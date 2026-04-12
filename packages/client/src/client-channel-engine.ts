import {
	type BroadcastServerMessage,
	buildShardAccessors,
	type ChannelData,
	type ClientTransport,
	type OperationDefinition,
	type RejectMessage,
	type ShardState,
	type StateMessage,
	type SubmitResult,
} from "@kio/shared";
import { produce } from "immer";
import type { InFlight } from "./shard-store";
import { ShardStore } from "./shard-store";

type PendingSubmit = {
	resolve: (result: SubmitResult) => void;
};

/**
 * Client-side engine for one channel.
 * Owns ShardStores. Created by createClient, not by consumer code.
 *
 * ShardStores are created when the server sends initial state during
 * the connection handshake — the server decides which shards the
 * client receives, not the client.
 */
export class ClientChannelEngine {
	private readonly stores = new Map<
		string,
		ShardStore<Record<string, unknown>>
	>();
	private readonly pendingSubmits = new Map<string, PendingSubmit>();
	/** Maps opId → shardId for in-flight optimistic operations */
	private readonly inFlightShards = new Map<string, string>();
	/** Maps opId → timeout timer for submit timeout */
	private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
	/** Listeners registered before the store exists — attached when the store is created */
	private readonly pendingListeners = new Map<string, Set<() => void>>();
	private opCounter = 0;
	private actor: { actorId: string } = { actorId: "" };

	constructor(
		private readonly channelData: ChannelData,
		private readonly transport: ClientTransport,
		private readonly submitTimeoutMs: number = 10_000,
	) {}

	/** Set the actor — called when the server sends the welcome message */
	setActor(actor: unknown): void {
		this.actor = actor as { actorId: string };
	}

	/**
	 * Handle a state message from the server (initial sync during handshake).
	 * Creates ShardStores for shards we haven't seen, grants access, applies state.
	 */
	handleStateMessage(message: StateMessage): void {
		for (const entry of message.shards) {
			let store = this.stores.get(entry.shardId);
			if (!store) {
				store = new ShardStore<Record<string, unknown>>(this.channelData.kind);
				this.stores.set(entry.shardId, store);

				// Attach any listeners that were registered before this store existed
				const pending = this.pendingListeners.get(entry.shardId);
				if (pending) {
					for (const listener of pending) {
						store.subscribe(listener);
					}
					this.pendingListeners.delete(entry.shardId);
				}
			}
			store.grantAccess();
			store.applyBroadcastEntry(entry);
		}
	}

	/**
	 * Handle a broadcast message from the server (ongoing state updates).
	 * Any broadcast to a shard drops its prediction. If causedBy.opId matches
	 * the in-flight operation, the in-flight slot is also cleared (confirmed).
	 */
	handleBroadcastMessage(message: BroadcastServerMessage): void {
		for (const entry of message.shards) {
			const store = this.stores.get(entry.shardId);
			if (store) {
				store.applyBroadcastEntry(entry);
			}
		}
	}

	/**
	 * Handle acknowledge or reject for a pending submit.
	 * On acknowledge: clears in-flight, resolves with acknowledged.
	 * On VERSION_CONFLICT: applies fresh state, runs canRetry, may resubmit.
	 * On other reject: clears in-flight, resolves with rejected.
	 */
	handleSubmitResponse(
		message: RejectMessage | { type: "acknowledge"; opId: string },
	): void {
		const pending = this.pendingSubmits.get(message.opId);
		if (!pending) return;

		this.clearTimer(message.opId);

		if (message.type === "acknowledge") {
			this.pendingSubmits.delete(message.opId);
			this.clearInFlightForOp(message.opId);
			pending.resolve({ status: "acknowledged" });
			return;
		}

		// Apply fresh shard state from VERSION_CONFLICT rejection
		if (message.shards) {
			for (const entry of message.shards) {
				const store = this.stores.get(entry.shardId);
				store?.applyBroadcastEntry({
					shardId: entry.shardId,
					version: entry.version,
					state: entry.state,
				});
			}
		}

		// Try canRetry for VERSION_CONFLICT
		if (message.code === "VERSION_CONFLICT") {
			const retried = this.tryRetry(message.opId);
			if (retried) return;
		}

		// No retry — resolve as rejected
		this.pendingSubmits.delete(message.opId);
		this.clearInFlightForOp(message.opId);
		pending.resolve({
			status: "rejected",
			error: { code: message.code, message: message.message },
		});
	}

	/** Handle disconnect — clear all in-flight operations and resolve pending submits */
	handleDisconnect(): void {
		for (const [opId, pending] of this.pendingSubmits) {
			this.clearTimer(opId);
			this.clearInFlightForOp(opId);
			pending.resolve({ status: "disconnected" });
		}
		this.pendingSubmits.clear();
	}

	private static readonly UNAVAILABLE_SNAPSHOT: ShardState<
		Record<string, unknown>
	> = {
		syncStatus: "unavailable",
		state: null,
		pending: null,
	};

	/** Get the ShardState snapshot for a shard */
	shardState(shardId: string): ShardState<Record<string, unknown>> {
		const store = this.stores.get(shardId);
		if (!store) {
			return ClientChannelEngine.UNAVAILABLE_SNAPSHOT;
		}
		return store.snapshot;
	}

	/** Subscribe to changes on a specific shard */
	subscribeToShard(shardId: string, listener: () => void): () => void {
		const store = this.stores.get(shardId);
		if (store) {
			return store.subscribe(listener);
		}

		// Store doesn't exist yet — queue the listener
		let pending = this.pendingListeners.get(shardId);
		if (!pending) {
			pending = new Set();
			this.pendingListeners.set(shardId, pending);
		}
		pending.add(listener);

		return () => {
			pending.delete(listener);
		};
	}

	/**
	 * Submit an operation via the transport.
	 *
	 * For optimistic operations: resolves scope, checks in-flight slot,
	 * runs apply() to compute prediction, sets in-flight + prediction
	 * on the target ShardStore, then sends to server.
	 *
	 * Returns a SubmitResult — never throws.
	 */
	async submit(operationName: string, input: unknown): Promise<SubmitResult> {
		const opId = `${this.actor.actorId}:${this.channelData.name}:${String(this.opCounter++)}`;
		const opDef = this.channelData.operations.get(operationName);

		// Optimistic apply — predict locally before sending to server
		if (opDef?.execution === "optimistic" && opDef.apply) {
			const blocked = this.applyOptimistic(opDef, input, opId, operationName);
			if (blocked) return blocked;
		}

		return this.sendAndAwait(opId, operationName, input);
	}

	/** Collect local shard versions for reconnect handshake */
	getShardVersions(): Record<string, number> {
		const versions: Record<string, number> = {};
		for (const [shardId, store] of this.stores) {
			const v = store.version;
			if (v !== null) {
				versions[shardId] = v;
			}
		}
		return versions;
	}

	get name(): string {
		return this.channelData.name;
	}

	// ── Private ─────────────────────────────────────────────────────────

	private sendAndAwait(
		opId: string,
		operationName: string,
		input: unknown,
	): Promise<SubmitResult> {
		const promise = new Promise<SubmitResult>((resolve) => {
			this.pendingSubmits.set(opId, { resolve });
		});

		this.startTimer(opId);

		this.transport.send({
			type: "submit",
			channelId: this.channelData.name,
			operationName,
			input,
			opId,
		});

		return promise;
	}

	/**
	 * Run optimistic apply: resolve scope, check in-flight, compute prediction.
	 * Returns a blocked SubmitResult if in-flight slot is occupied, null otherwise.
	 */
	private applyOptimistic(
		opDef: OperationDefinition,
		input: unknown,
		opId: string,
		operationName: string,
	): SubmitResult | null {
		const scopeRefs = opDef.scope(input, this.buildCtx());

		if (scopeRefs.length !== 1) return null;

		const ref = scopeRefs[0];
		if (!ref) return null;
		const shardId = ref.shardId;
		const store = this.stores.get(shardId);
		if (!store) return null;

		if (store.hasInFlight) {
			return {
				status: "blocked",
				error: {
					code: "PENDING_OPERATION",
					message: `Another operation on shard "${shardId}" hasn't resolved yet`,
				},
			};
		}

		this.computeAndSetPrediction(
			store,
			opDef,
			input,
			opId,
			operationName,
			shardId,
		);
		return null;
	}

	/** Compute prediction via Immer produce and set on store */
	private computeAndSetPrediction(
		store: ShardStore<Record<string, unknown>>,
		opDef: OperationDefinition,
		input: unknown,
		opId: string,
		operationName: string,
		shardId: string,
	): void {
		const authoritative = store.authoritative;
		if (!authoritative || !opDef.apply) return;

		const ctx = this.buildCtx();
		const scopeRefs = opDef.scope(input, ctx);
		const root: Record<string, unknown> = { [shardId]: authoritative };
		const applyFn = opDef.apply;

		const newRoot = produce(root, (draft) => {
			const accessors = buildShardAccessors(
				draft as Record<string, unknown>,
				scopeRefs,
				this.channelData.shardDefs,
			);
			applyFn(accessors, input, undefined, ctx);
		});

		const predictedState = newRoot[shardId] as Record<string, unknown>;
		const inFlight: InFlight = { opId, operationName, input };
		store.setOptimistic(inFlight, predictedState);
		this.inFlightShards.set(opId, shardId);
	}

	/**
	 * Try canRetry on VERSION_CONFLICT. If retry succeeds, sends a new submit
	 * with a fresh opId while keeping the original promise and in-flight slot.
	 */
	private tryRetry(oldOpId: string): boolean {
		const pending = this.pendingSubmits.get(oldOpId);
		if (!pending) return false;

		const shardId = this.inFlightShards.get(oldOpId);
		if (!shardId) return false;

		const store = this.stores.get(shardId);
		if (!store) return false;

		const inFlight = store.getInFlight();
		if (!inFlight) return false;

		const opDef = this.channelData.operations.get(inFlight.operationName);
		if (!opDef) return false;

		// Build fresh shard accessors for canRetry evaluation
		const authoritative = store.authoritative;
		if (!authoritative) return false;

		const ctx = this.buildCtx();
		const scopeRefs = opDef.scope(inFlight.input, ctx);
		const root: Record<string, unknown> = { [shardId]: authoritative };
		const freshAccessors = buildShardAccessors(
			root,
			scopeRefs,
			this.channelData.shardDefs,
		);

		// canRetry defaults to true if not defined
		const clientImpl = this.channelData.clientImpls.get(inFlight.operationName);
		const shouldRetry = clientImpl?.canRetry
			? clientImpl.canRetry(inFlight.input, freshAccessors, 1)
			: true;
		if (!shouldRetry) return false;

		// Retry: new opId, remap pending + in-flight, recompute prediction, resend
		const newOpId = `${this.actor.actorId}:${this.channelData.name}:${String(this.opCounter++)}`;

		this.pendingSubmits.delete(oldOpId);
		this.pendingSubmits.set(newOpId, pending);
		this.inFlightShards.delete(oldOpId);

		this.computeAndSetPrediction(
			store,
			opDef,
			inFlight.input,
			newOpId,
			inFlight.operationName,
			shardId,
		);

		this.startTimer(newOpId);
		this.transport.send({
			type: "submit",
			channelId: this.channelData.name,
			operationName: inFlight.operationName,
			input: inFlight.input,
			opId: newOpId,
		});

		return true;
	}

	private buildCtx(): { actor: { actorId: string }; channelId: string } {
		return {
			actor: this.actor,
			channelId: this.channelData.name,
		};
	}

	private clearInFlightForOp(opId: string): void {
		const shardId = this.inFlightShards.get(opId);
		if (shardId) {
			this.inFlightShards.delete(opId);
			this.stores.get(shardId)?.clearInFlight();
		}
	}

	private startTimer(opId: string): void {
		const timer = setTimeout(() => {
			this.timeouts.delete(opId);
			const pending = this.pendingSubmits.get(opId);
			if (pending) {
				this.pendingSubmits.delete(opId);
				this.clearInFlightForOp(opId);
				pending.resolve({ status: "timeout" });
			}
		}, this.submitTimeoutMs);
		this.timeouts.set(opId, timer);
	}

	private clearTimer(opId: string): void {
		const timer = this.timeouts.get(opId);
		if (timer) {
			globalThis.clearTimeout(timer);
			this.timeouts.delete(opId);
		}
	}
}

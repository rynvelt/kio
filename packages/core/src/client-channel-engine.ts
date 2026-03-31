import { produce } from "immer";
import type { ChannelData, OperationDefinition } from "./channel";
import { buildShardAccessors } from "./shard-accessors";
import { ShardStore } from "./shard-store";
import type { ShardState } from "./state";
import type {
	AcknowledgeMessage,
	BroadcastServerMessage,
	ClientTransport,
	RejectMessage,
	StateMessage,
} from "./transport";

type PendingSubmit = {
	resolve: (result: AcknowledgeMessage | RejectMessage) => void;
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
	private opCounter = 0;

	constructor(
		private readonly channelData: ChannelData,
		private readonly transport: ClientTransport,
	) {}

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
	 * Clears the in-flight slot on the affected shard.
	 */
	handleSubmitResponse(message: AcknowledgeMessage | RejectMessage): void {
		const pending = this.pendingSubmits.get(message.opId);
		if (pending) {
			this.pendingSubmits.delete(message.opId);

			// Clear in-flight on the affected shard store
			const shardId = this.inFlightShards.get(message.opId);
			if (shardId) {
				this.inFlightShards.delete(message.opId);
				this.stores.get(shardId)?.clearInFlight();
			}

			pending.resolve(message);
		}
	}

	/** Get the ShardState snapshot for a shard */
	shardState(shardId: string): ShardState<Record<string, unknown>> {
		const store = this.stores.get(shardId);
		if (!store) {
			return { syncStatus: "unavailable", state: null, pending: null };
		}
		return store.snapshot;
	}

	/** Subscribe to changes on a specific shard */
	subscribeToShard(shardId: string, listener: () => void): () => void {
		const store = this.stores.get(shardId);
		if (!store) return () => {};
		return store.subscribe(listener);
	}

	/**
	 * Submit an operation via the transport. Returns when server responds.
	 *
	 * For optimistic operations: resolves scope, checks in-flight slot,
	 * runs apply() to compute prediction, sets in-flight + prediction
	 * on the target ShardStore, then sends to server.
	 */
	async submit(
		operationName: string,
		input: unknown,
	): Promise<AcknowledgeMessage | RejectMessage> {
		const opId = `${this.channelData.name}:${String(this.opCounter++)}`;

		const opDef = this.channelData.operations.get(operationName);

		// Optimistic apply — predict locally before sending to server
		if (opDef?.execution === "optimistic" && opDef.apply) {
			const blocked = this.applyOptimistic(opDef, input, opId, operationName);
			if (blocked) return blocked;
		}

		const promise = new Promise<AcknowledgeMessage | RejectMessage>(
			(resolve) => {
				this.pendingSubmits.set(opId, { resolve });
			},
		);

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
	 * Returns a RejectMessage if blocked (in-flight slot occupied), null otherwise.
	 */
	private applyOptimistic(
		opDef: OperationDefinition,
		input: unknown,
		opId: string,
		operationName: string,
	): RejectMessage | null {
		// Resolve scope to find target shard
		const ctx = { actor: { actorId: "" }, channelId: this.channelData.name };
		const scopeRefs = opDef.scope(input, ctx);

		if (scopeRefs.length !== 1) {
			// Optimistic operations must target exactly one shard
			return null;
		}

		const ref = scopeRefs[0];
		if (!ref) return null;
		const shardId = ref.shardId;
		const store = this.stores.get(shardId);
		if (!store) return null;

		// Check in-flight slot
		if (store.hasInFlight) {
			return {
				type: "reject",
				opId,
				code: "PENDING_OPERATION",
				message: `Another operation on shard "${shardId}" hasn't resolved yet`,
			};
		}

		// Compute prediction via Immer produce
		const authoritative = store.authoritative;
		if (!authoritative) return null;

		const root: Record<string, unknown> = { [shardId]: authoritative };
		const applyFn = opDef.apply;
		if (!applyFn) return null;

		const newRoot = produce(root, (draft) => {
			const accessors = buildShardAccessors(
				draft as Record<string, unknown>,
				scopeRefs,
				this.channelData.shardDefs,
			);
			applyFn(accessors, input, undefined, ctx);
		});

		const predictedState = newRoot[shardId] as Record<string, unknown>;

		store.setOptimistic({ opId, operationName, input }, predictedState);
		this.inFlightShards.set(opId, shardId);

		return null;
	}

	get name(): string {
		return this.channelData.name;
	}
}

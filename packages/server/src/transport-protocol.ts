import type { BaseActor, ServerTransport, Subscriber } from "@kio/shared";
import type { ActorRegistry } from "./actor-registry";
import type { ChannelRuntime } from "./channel-runtime";
import type { PipelineResult, Submission } from "./pipeline";
import type { SubscriptionRef } from "./server";

/** Dependencies for TransportProtocol — all seams flow in as refs/callbacks. */
export interface TransportProtocolDeps<TActor extends BaseActor> {
	readonly transport: ServerTransport;
	readonly actorRegistry: ActorRegistry<TActor>;
	readonly channels: ReadonlyMap<string, ChannelRuntime>;
	/** Submit to a channel — returns the pipeline result without running afterApply hooks. */
	readonly submit: (
		channelName: string,
		submission: Submission,
	) => Promise<PipelineResult>;
	/** Run afterApply hooks for an acknowledged client operation (depth 0). */
	readonly runAfterApply: (
		channelName: string,
		result: PipelineResult & { status: "acknowledged" },
		actor: BaseActor,
		input: unknown,
	) => Promise<void>;
	readonly defaultSubscriptions?: (actor: TActor) => readonly SubscriptionRef[];
	readonly onConnect?: (actor: TActor) => void;
	readonly onDisconnect?: (actor: TActor, reason: string) => void;
}

/** Per-connection handshake state between welcome and versions messages. */
interface PendingHandshake<TActor extends BaseActor> {
	readonly actor: TActor;
	readonly channelStates: Array<{
		readonly channelId: string;
		readonly kind: "durable" | "ephemeral";
		readonly shardStates: Map<string, { state: unknown; version: number }>;
	}>;
}

/**
 * Implements the server-side wire protocol over a ServerTransport:
 * two-step handshake, submit routing, disconnect cleanup.
 *
 * Owns no domain state beyond the in-flight handshake map — all
 * state-changing work flows through the injected submit / runAfterApply
 * callbacks and the provided actor/channel references.
 */
export class TransportProtocol<TActor extends BaseActor> {
	private readonly transport: ServerTransport;
	private readonly actorRegistry: ActorRegistry<TActor>;
	private readonly channels: ReadonlyMap<string, ChannelRuntime>;
	private readonly submit: TransportProtocolDeps<TActor>["submit"];
	private readonly runAfterApply: TransportProtocolDeps<TActor>["runAfterApply"];
	private readonly defaultSubscriptions: TransportProtocolDeps<TActor>["defaultSubscriptions"];
	private readonly onConnect: TransportProtocolDeps<TActor>["onConnect"];
	private readonly onDisconnect: TransportProtocolDeps<TActor>["onDisconnect"];
	private readonly pendingHandshakes = new Map<
		string,
		PendingHandshake<TActor>
	>();

	constructor(deps: TransportProtocolDeps<TActor>) {
		this.transport = deps.transport;
		this.actorRegistry = deps.actorRegistry;
		this.channels = deps.channels;
		this.submit = deps.submit;
		this.runAfterApply = deps.runAfterApply;
		this.defaultSubscriptions = deps.defaultSubscriptions;
		this.onConnect = deps.onConnect;
		this.onDisconnect = deps.onDisconnect;

		this.transport.onConnection(async (connectionId, rawActor) => {
			await this.handleConnection(connectionId, rawActor);
		});

		this.transport.onMessage(async (connectionId, message) => {
			switch (message.type) {
				case "versions":
					this.handleClientVersions(connectionId, message.shards);
					break;
				case "submit":
					await this.handleSubmit(connectionId, message);
					break;
			}
		});

		this.transport.onDisconnection((connectionId, reason) => {
			this.handleDisconnection(connectionId, reason);
		});
	}

	/** Subscribe a transport connection to a channel's broadcasts. */
	addTransportSubscriber(
		channelName: string,
		connectionId: string,
		shardIds: readonly string[],
	): void {
		const ch = this.getChannelOrThrow(channelName);
		ch.addSubscriber(this.createSubscriber(connectionId), shardIds);
	}

	/** Unsubscribe a transport connection from a channel's broadcasts. */
	removeTransportSubscriber(channelName: string, connectionId: string): void {
		const ch = this.getChannelOrThrow(channelName);
		ch.removeSubscriber(connectionId);
	}

	private getChannelOrThrow(channelName: string): ChannelRuntime {
		const ch = this.channels.get(channelName);
		if (!ch) {
			throw new Error(`Channel "${channelName}" is not registered`);
		}
		return ch;
	}

	private createSubscriber(connectionId: string): Subscriber {
		return {
			id: connectionId,
			send: (message) => {
				this.transport.send(connectionId, {
					type: "broadcast",
					channelId: message.channelId,
					kind: message.kind,
					shards: message.shards,
				});
			},
		};
	}

	/**
	 * Handshake step 1: validate actor, subscribe to default channels,
	 * load shard states, send welcome.
	 */
	private async handleConnection(
		connectionId: string,
		rawActor: unknown,
	): Promise<void> {
		const actor = await this.actorRegistry.validateAndStore(
			connectionId,
			rawActor,
		);
		if (!actor) {
			this.transport.send(connectionId, {
				type: "error",
				code: "INVALID_ACTOR",
				message: "Actor validation failed",
			});
			this.transport.close(connectionId);
			return;
		}

		const subscriptions = this.defaultSubscriptions?.(actor) ?? [];

		const channelStates: PendingHandshake<TActor>["channelStates"] = [];
		const serverVersions: Record<string, number> = {};

		for (const sub of subscriptions) {
			const ch = this.channels.get(sub.channelId);
			if (!ch) continue;

			ch.addSubscriber(this.createSubscriber(connectionId), sub.shardIds);

			const shardStates = await ch.loadShardStates(sub.shardIds);
			channelStates.push({
				channelId: sub.channelId,
				kind: ch.kind,
				shardStates,
			});

			for (const [shardId, { version }] of shardStates) {
				serverVersions[shardId] = version;
			}
		}

		this.pendingHandshakes.set(connectionId, { actor, channelStates });

		this.transport.send(connectionId, {
			type: "welcome",
			actor,
			shards: serverVersions,
		});
	}

	/**
	 * Handshake step 2: diff versions, send state for stale shards, send ready.
	 */
	private handleClientVersions(
		connectionId: string,
		clientVersions: Record<string, number>,
	): void {
		const pending = this.pendingHandshakes.get(connectionId);
		if (!pending) return;
		this.pendingHandshakes.delete(connectionId);

		for (const { channelId, kind, shardStates } of pending.channelStates) {
			const entries: Array<{
				shardId: string;
				version: number;
				state: unknown;
			}> = [];

			for (const [shardId, { state, version }] of shardStates) {
				const clientVersion = clientVersions[shardId] ?? 0;
				if (version > clientVersion) {
					entries.push({ shardId, version, state });
				}
			}

			if (entries.length > 0) {
				this.transport.send(connectionId, {
					type: "state",
					channelId,
					kind,
					shards: entries,
				});
			}
		}

		this.transport.send(connectionId, { type: "ready" });
		this.onConnect?.(pending.actor);
	}

	/** Route a client submit to the right channel, respond with ack/reject, then run hooks. */
	private async handleSubmit(
		connectionId: string,
		message: {
			channelId: string;
			operationName: string;
			input: unknown;
			opId: string;
		},
	): Promise<void> {
		if (!this.channels.has(message.channelId)) {
			this.transport.send(connectionId, {
				type: "reject",
				opId: message.opId,
				code: "INVALID_CHANNEL",
				message: `Channel "${message.channelId}" is not registered`,
			});
			return;
		}

		const actor = this.actorRegistry.getActor(connectionId);
		if (!actor) {
			this.transport.send(connectionId, {
				type: "reject",
				opId: message.opId,
				code: "INTERNAL_ERROR",
				message: "Connection has no associated actor",
			});
			return;
		}

		const result = await this.submit(message.channelId, {
			operationName: message.operationName,
			input: message.input,
			actor,
			opId: message.opId,
		});

		if (result.status === "acknowledged") {
			this.transport.send(connectionId, {
				type: "acknowledge",
				opId: message.opId,
			});
			await this.runAfterApply(message.channelId, result, actor, message.input);
		} else {
			this.transport.send(connectionId, {
				type: "reject",
				opId: message.opId,
				code: result.code,
				message: result.message,
				shards: result.shards,
			});
		}
	}

	/** Clean up actor, unsubscribe from channels, notify consumer. */
	private handleDisconnection(connectionId: string, reason: string): void {
		const actor = this.actorRegistry.removeActor(connectionId);
		this.pendingHandshakes.delete(connectionId);

		for (const ch of this.channels.values()) {
			ch.removeSubscriber(connectionId);
		}

		if (actor) {
			this.onDisconnect?.(actor, reason);
		}
	}
}

import type { BaseActor, ServerTransport, Subscriber } from "@kio/shared";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ChannelRuntime } from "./channel-runtime";
import type { SubscriptionRef } from "./server";

/** Dependencies injected into the ConnectionManager */
export interface ConnectionManagerConfig<TActor extends BaseActor> {
	readonly transport: ServerTransport;
	readonly channels: ReadonlyMap<string, ChannelRuntime>;
	readonly actorSchema: StandardSchemaV1 | undefined;
	readonly defaultSubscriptions?: (actor: TActor) => readonly SubscriptionRef[];
	readonly onConnect?: (actor: TActor) => void;
	readonly onDisconnect?: (actor: TActor, reason: string) => void;
}

/** Per-connection state stored between handshake step 1 and step 2 */
interface PendingConnection<TActor extends BaseActor> {
	readonly actor: TActor;
	readonly channelStates: ReadonlyArray<{
		readonly channelId: string;
		readonly kind: "durable" | "ephemeral";
		readonly shardStates: Map<string, { state: unknown; version: number }>;
	}>;
}

/**
 * Manages transport connections: actor validation, handshake protocol,
 * actor storage, and subscriber lifecycle.
 */
export class ConnectionManager<TActor extends BaseActor> {
	private readonly connectionActors = new Map<string, TActor>();
	private readonly pendingConnections = new Map<
		string,
		PendingConnection<TActor>
	>();

	private readonly transport: ServerTransport;
	private readonly channels: ReadonlyMap<string, ChannelRuntime>;
	private readonly actorSchema: StandardSchemaV1 | undefined;
	private readonly defaultSubscriptions:
		| ((actor: TActor) => readonly SubscriptionRef[])
		| undefined;
	private readonly onConnectCb: ((actor: TActor) => void) | undefined;
	private readonly onDisconnectCb:
		| ((actor: TActor, reason: string) => void)
		| undefined;

	constructor(config: ConnectionManagerConfig<TActor>) {
		this.transport = config.transport;
		this.channels = config.channels;
		this.actorSchema = config.actorSchema;
		this.defaultSubscriptions = config.defaultSubscriptions;
		this.onConnectCb = config.onConnect;
		this.onDisconnectCb = config.onDisconnect;
	}

	/** Look up the validated actor for a connection */
	getActor(connectionId: string): TActor | undefined {
		return this.connectionActors.get(connectionId);
	}

	/**
	 * Handshake step 1: transport signals client connected.
	 * Validates actor, determines subscriptions, loads shard states, sends welcome.
	 */
	async handleConnection(
		connectionId: string,
		rawActor: unknown,
	): Promise<void> {
		const actor = await this.validateActor(rawActor);
		if (!actor) {
			this.transport.send(connectionId, {
				type: "error",
				code: "INVALID_ACTOR",
				message: "Actor validation failed",
			});
			this.transport.close(connectionId);
			return;
		}

		this.connectionActors.set(connectionId, actor);
		const subscriptions = this.defaultSubscriptions?.(actor) ?? [];

		const channelStates: Array<{
			channelId: string;
			kind: "durable" | "ephemeral";
			shardStates: Map<string, { state: unknown; version: number }>;
		}> = [];
		const serverVersions: Record<string, number> = {};

		for (const sub of subscriptions) {
			const ch = this.channels.get(sub.channelId);
			if (!ch) continue;

			ch.addSubscriber(
				this.createTransportSubscriber(connectionId),
				sub.shardIds,
			);

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

		this.pendingConnections.set(connectionId, { actor, channelStates });

		this.transport.send(connectionId, {
			type: "welcome",
			actor,
			shards: serverVersions,
		});
	}

	/**
	 * Handshake step 2: client sends its versions.
	 * Server diffs, sends only shards where client is behind, then ready.
	 */
	handleClientVersions(
		connectionId: string,
		clientVersions: Record<string, number>,
	): void {
		const pending = this.pendingConnections.get(connectionId);
		if (!pending) return;
		this.pendingConnections.delete(connectionId);

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
		this.onConnectCb?.(pending.actor);
	}

	/** Clean up connection state and notify via onDisconnect callback */
	handleDisconnection(connectionId: string, reason: string): void {
		const actor = this.connectionActors.get(connectionId);
		this.connectionActors.delete(connectionId);
		this.pendingConnections.delete(connectionId);

		// Remove subscriber from all channels
		for (const ch of this.channels.values()) {
			ch.removeSubscriber(connectionId);
		}

		if (actor) {
			this.onDisconnectCb?.(actor, reason);
		}
	}

	/** Create a Subscriber that sends broadcasts via the transport */
	createTransportSubscriber(connectionId: string): Subscriber {
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

	/** Validate raw actor from transport against the actor schema */
	private async validateActor(rawActor: unknown): Promise<TActor | null> {
		if (!this.actorSchema) {
			// No schema — accept as-is (backward compat with engine() without defineApp)
			return rawActor as TActor;
		}
		const result = await this.actorSchema["~standard"].validate(rawActor);
		if ("issues" in result && result.issues) {
			return null;
		}
		return ("value" in result ? result.value : rawActor) as TActor;
	}
}

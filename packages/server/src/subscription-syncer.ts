import type { BaseActor, SubscriptionRef } from "@kiojs/shared";
import type { ActorRegistry } from "./actor-registry";

/**
 * Dependencies for the SubscriptionSyncer. All mutation flows through
 * callbacks — no direct dependency on transport, channels, or protocol.
 */
export interface SubscriptionSyncerDeps<TActor extends BaseActor> {
	readonly actorRegistry: ActorRegistry<TActor>;
	/**
	 * Ensure a connection is subscribed to a shard on a channel. Creates
	 * the subscriber entry if it doesn't exist; extends the shard set if
	 * it does.
	 */
	readonly addConnectionToShard: (
		connectionId: string,
		channelId: string,
		shardId: string,
	) => void;
	/**
	 * Remove a shard from a connection's subscription on a channel.
	 */
	readonly removeConnectionFromShard: (
		connectionId: string,
		channelId: string,
		shardId: string,
	) => void;
	/**
	 * Send the current state of shard(s) to a specific connection so the
	 * client has base state immediately after gaining access.
	 */
	readonly sendShardState: (
		connectionId: string,
		channelId: string,
		shardIds: readonly string[],
	) => Promise<void>;
}

/**
 * Keeps the runtime subscriber map in sync with subscription-shard
 * mutations that happen while an actor is connected.
 *
 * On `grant`: adds the target actor's live connections to the affected
 * channel's broadcast list and pushes current shard state to each.
 * On `revoke`: removes them.
 *
 * If the target actor has no live connections, both are no-ops — the
 * shard persists the change for the next connect.
 */
export class SubscriptionSyncer<TActor extends BaseActor> {
	constructor(private readonly deps: SubscriptionSyncerDeps<TActor>) {}

	async onGrant(input: {
		actorId: string;
		ref: SubscriptionRef;
	}): Promise<void> {
		const connections = this.deps.actorRegistry.getConnections(input.actorId);
		if (connections.size === 0) return;

		for (const connectionId of connections) {
			this.deps.addConnectionToShard(
				connectionId,
				input.ref.channelId,
				input.ref.shardId,
			);
			await this.deps.sendShardState(connectionId, input.ref.channelId, [
				input.ref.shardId,
			]);
		}
	}

	onRevoke(input: { actorId: string; ref: SubscriptionRef }): void {
		const connections = this.deps.actorRegistry.getConnections(input.actorId);
		if (connections.size === 0) return;

		for (const connectionId of connections) {
			this.deps.removeConnectionFromShard(
				connectionId,
				input.ref.channelId,
				input.ref.shardId,
			);
		}
	}
}

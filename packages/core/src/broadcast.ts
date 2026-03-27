import type { Patch } from "immer";

/** Metadata about what caused the state change */
export interface CausedBy {
	readonly operation: string;
	readonly actor: string;
}

/** A single shard entry in a broadcast message */
export type BroadcastShardEntry =
	| {
			readonly shardId: string;
			readonly version: number;
			readonly patches: readonly Patch[];
			readonly causedBy?: CausedBy;
	  }
	| {
			readonly shardId: string;
			readonly version: number;
			readonly state: unknown;
			readonly causedBy?: CausedBy;
	  };

/** Broadcast message — array of shard entries scoped to one channel */
export interface BroadcastMessage {
	readonly type: "broadcast";
	readonly channelId: string;
	readonly kind: "durable" | "ephemeral";
	readonly shards: readonly BroadcastShardEntry[];
}

/** Receives broadcast messages */
export interface Subscriber {
	readonly id: string;
	send(message: BroadcastMessage): void;
}

/**
 * Manages subscribers and broadcasting.
 *
 * Two broadcast modes, never mixed on the same channel:
 * - autoBroadcast: true → patches sent immediately after each operation
 * - autoBroadcast: false → shards marked dirty, full state sent on manual flush
 */
export class BroadcastManager {
	private readonly subscribers = new Map<string, Subscriber>();
	private readonly subscriberShards = new Map<string, Set<string>>();
	private readonly dirtySets = new Map<string, Set<string>>();

	constructor(
		private readonly channelId: string,
		private readonly kind: "durable" | "ephemeral",
	) {}

	addSubscriber(subscriber: Subscriber, shardIds: readonly string[]): void {
		this.subscribers.set(subscriber.id, subscriber);
		this.subscriberShards.set(subscriber.id, new Set(shardIds));
		this.dirtySets.set(subscriber.id, new Set());
	}

	removeSubscriber(subscriberId: string): void {
		this.subscribers.delete(subscriberId);
		this.subscriberShards.delete(subscriberId);
		this.dirtySets.delete(subscriberId);
	}

	addShards(subscriberId: string, shardIds: readonly string[]): void {
		const shards = this.subscriberShards.get(subscriberId);
		if (shards) {
			for (const id of shardIds) shards.add(id);
		}
	}

	removeShards(subscriberId: string, shardIds: readonly string[]): void {
		const shards = this.subscriberShards.get(subscriberId);
		if (shards) {
			for (const id of shardIds) shards.delete(id);
		}
	}

	/**
	 * Called after a successful operation (autoBroadcast: true channels).
	 * Sends patches immediately to subscribers of the affected shards.
	 */
	broadcastPatches(
		patchesByShard: ReadonlyMap<string, readonly Patch[]>,
		shardVersions: ReadonlyMap<string, number>,
		causedBy: CausedBy,
	): void {
		const changedShardIds = [...patchesByShard.keys()];

		for (const [subscriberId, subscribedShards] of this.subscriberShards) {
			const subscriber = this.subscribers.get(subscriberId);
			if (!subscriber) continue;

			const entries: BroadcastShardEntry[] = [];
			for (const shardId of changedShardIds) {
				if (!subscribedShards.has(shardId)) continue;

				const version = shardVersions.get(shardId) ?? 0;
				const patches = patchesByShard.get(shardId);
				if (patches && patches.length > 0) {
					entries.push({ shardId, version, patches, causedBy });
				}
			}

			if (entries.length > 0) {
				subscriber.send({
					type: "broadcast",
					channelId: this.channelId,
					kind: this.kind,
					shards: entries,
				});
			}
		}
	}

	/**
	 * Called after a successful operation (autoBroadcast: false channels).
	 * Marks affected shards as dirty for each subscriber.
	 */
	markDirty(shardIds: readonly string[]): void {
		for (const [subscriberId, subscribedShards] of this.subscriberShards) {
			const dirtySet = this.dirtySets.get(subscriberId);
			if (!dirtySet) continue;

			for (const shardId of shardIds) {
				if (subscribedShards.has(shardId)) {
					dirtySet.add(shardId);
				}
			}
		}
	}

	/**
	 * Flush dirty shards — send full state to subscribers.
	 * If shardIds provided, flush only those. Otherwise flush all dirty.
	 */
	broadcastDirtyShards(
		getShardState: (
			shardId: string,
		) => { state: unknown; version: number } | undefined,
		shardIds?: readonly string[],
	): void {
		for (const [subscriberId, dirtySet] of this.dirtySets) {
			const subscriber = this.subscribers.get(subscriberId);
			const subscribedShards = this.subscriberShards.get(subscriberId);
			if (!subscriber || !subscribedShards) continue;

			const shardsToFlush = shardIds
				? shardIds.filter((id) => dirtySet.has(id) && subscribedShards.has(id))
				: [...dirtySet].filter((id) => subscribedShards.has(id));

			if (shardsToFlush.length === 0) continue;

			const entries: BroadcastShardEntry[] = [];
			for (const shardId of shardsToFlush) {
				const cached = getShardState(shardId);
				if (cached) {
					entries.push({
						shardId,
						version: cached.version,
						state: cached.state,
					});
				}
			}

			if (entries.length > 0) {
				subscriber.send({
					type: "broadcast",
					channelId: this.channelId,
					kind: this.kind,
					shards: entries,
				});
			}

			// Clear dirty after successful send
			for (const shardId of shardsToFlush) {
				dirtySet.delete(shardId);
			}
		}
	}
}

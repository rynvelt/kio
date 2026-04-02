import type { Patch } from "immer";

/** Metadata about what caused the state change */
export interface CausedBy {
	readonly opId: string;
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

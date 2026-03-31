import type { BroadcastShardEntry } from "./broadcast";

// ── Bidirectional messages ───────────────────────────────────────────

/** Both client and server send their shard versions during connection handshake */
export interface VersionsMessage {
	readonly type: "versions";
	readonly shards: Record<string, number>;
}

// ── Client → Server messages ─────────────────────────────────────────

/** Client submits an operation */
export interface SubmitMessage {
	readonly type: "submit";
	readonly channelId: string;
	readonly operationName: string;
	readonly input: unknown;
	readonly opId: string;
}

export type ClientMessage = VersionsMessage | SubmitMessage;

// ── Server → Client messages ─────────────────────────────────────────

/** Server sends shard state to a specific client (initial sync after handshake) */
export interface StateMessage {
	readonly type: "state";
	readonly channelId: string;
	readonly kind: "durable" | "ephemeral";
	readonly shards: readonly BroadcastShardEntry[];
}

/** Server broadcasts shard updates to all subscribers of affected shards */
export interface BroadcastServerMessage {
	readonly type: "broadcast";
	readonly channelId: string;
	readonly kind: "durable" | "ephemeral";
	readonly shards: readonly BroadcastShardEntry[];
}

/** Server signals initial sync is complete — client can start submitting */
export interface ReadyMessage {
	readonly type: "ready";
}

/** Server confirms an operation was applied */
export interface AcknowledgeMessage {
	readonly type: "acknowledge";
	readonly opId: string;
}

/** Server rejects an operation */
export interface RejectMessage {
	readonly type: "reject";
	readonly opId: string;
	readonly code: string;
	readonly message: string;
	/** Fresh shard state — included for VERSION_CONFLICT so clients can evaluate canRetry */
	readonly shards?: ReadonlyArray<{
		readonly shardId: string;
		readonly version: number;
		readonly state: unknown;
	}>;
}

export type ServerMessage =
	| VersionsMessage
	| StateMessage
	| BroadcastServerMessage
	| ReadyMessage
	| AcknowledgeMessage
	| RejectMessage;

// ── Transport interfaces ─────────────────────────────────────────────

/** Client-side transport */
export interface ClientTransport {
	send(message: ClientMessage): void;
	onMessage(handler: (message: ServerMessage) => void): void;
	onConnected(handler: () => void): void;
	onDisconnected(handler: (reason: string) => void): void;
}

/** Server-side transport */
export interface ServerTransport {
	send(connectionId: string, message: ServerMessage): void;
	onMessage(
		handler: (connectionId: string, message: ClientMessage) => void,
	): void;
	onConnection(handler: (connectionId: string) => void): void;
	onDisconnection(
		handler: (connectionId: string, reason: string) => void,
	): void;
}

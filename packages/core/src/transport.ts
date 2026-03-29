import type { BroadcastShardEntry } from "./broadcast";

// ── Client → Server messages ─────────────────────────────────────────

/** Client requests connection with its local shard versions (empty on first connect) */
export interface ConnectMessage {
	readonly type: "connect";
	readonly shardVersions: Record<string, number>;
}

/** Client submits an operation */
export interface SubmitMessage {
	readonly type: "submit";
	readonly channelId: string;
	readonly operationName: string;
	readonly input: unknown;
	readonly opId: string;
	readonly shardVersions: Record<string, number>;
}

export type ClientMessage = ConnectMessage | SubmitMessage;

// ── Server → Client messages ─────────────────────────────────────────

/** Server tells client the current version per subscribed shard */
export interface ManifestMessage {
	readonly type: "manifest";
	readonly versions: Record<string, number>;
}

/** Server sends shard state updates (full state or patches) */
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
}

export type ServerMessage =
	| ManifestMessage
	| BroadcastServerMessage
	| ReadyMessage
	| AcknowledgeMessage
	| RejectMessage;

// ── Transport interfaces ─────────────────────────────────────────────

/** Client-side transport — sends messages to server, receives from server */
export interface ClientTransport {
	send(message: ClientMessage): void;
	onMessage(handler: (message: ServerMessage) => void): void;
}

/** Server-side transport — sends messages to clients, receives from clients */
export interface ServerTransport {
	send(connectionId: string, message: ServerMessage): void;
	onMessage(
		handler: (connectionId: string, message: ClientMessage) => void,
	): void;
}

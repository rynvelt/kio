import type { BroadcastShardEntry } from "./broadcast";

// ── Client → Server messages ─────────────────────────────────────────

export interface SubmitMessage {
	readonly type: "submit";
	readonly channelId: string;
	readonly operationName: string;
	readonly input: unknown;
	readonly opId: string;
	readonly shardVersions: Record<string, number>;
}

export type ClientMessage = SubmitMessage;

// ── Server → Client messages ─────────────────────────────────────────

export interface BroadcastServerMessage {
	readonly type: "broadcast";
	readonly channelId: string;
	readonly kind: "durable" | "ephemeral";
	readonly shards: readonly BroadcastShardEntry[];
}

export interface AcknowledgeMessage {
	readonly type: "acknowledge";
	readonly opId: string;
}

export interface RejectMessage {
	readonly type: "reject";
	readonly opId: string;
	readonly code: string;
	readonly message: string;
}

export type ServerMessage =
	| BroadcastServerMessage
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

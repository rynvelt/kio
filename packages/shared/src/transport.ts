import type { BroadcastShardEntry } from "./broadcast";

// ── Client → Server messages ─────────────────────────────────────────

/** Client responds to welcome with its local shard versions */
export interface VersionsMessage {
	readonly type: "versions";
	readonly shards: Record<string, number>;
}

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

/** Server sends welcome on connect — full actor identity + server shard versions */
export interface WelcomeMessage {
	readonly type: "welcome";
	/** Full actor object (untyped on the wire — typed at the engine layer) */
	readonly actor: unknown;
	readonly shards: Record<string, number>;
}

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

/** Server sends an error before closing the connection */
export interface ErrorMessage {
	readonly type: "error";
	readonly code: string;
	readonly message: string;
}

export type ServerMessage =
	| WelcomeMessage
	| StateMessage
	| BroadcastServerMessage
	| ReadyMessage
	| AcknowledgeMessage
	| RejectMessage
	| ErrorMessage;

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
	close(connectionId: string): void;
	onMessage(
		handler: (connectionId: string, message: ClientMessage) => void,
	): void;
	onConnection(handler: (connectionId: string, actor: unknown) => void): void;
	onDisconnection(
		handler: (connectionId: string, reason: string) => void,
	): void;
}

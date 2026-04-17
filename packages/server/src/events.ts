import type { BaseActor } from "@kio/shared";

/**
 * Structured observability events emitted by the server.
 *
 * Consumers pipe these into their logging / metrics / tracing backend
 * of choice via `ServerConfig.onEvent`. The emit contract is synchronous
 * and errors from the listener are caught and logged — observability
 * must never affect operation outcomes. Consumers that need async sinks
 * (batching exporters, etc.) should buffer internally.
 */

interface BaseEvent {
	/** Wall-clock time (Date.now()) at emit, for correlation with external logs. */
	readonly timestamp: number;
}

interface BaseOpEvent extends BaseEvent {
	readonly channelId: string;
	readonly opId: string;
	readonly operationName: string;
	readonly actor: BaseActor;
}

export interface OpSubmittedEvent extends BaseOpEvent {
	readonly type: "op.submitted";
}

export interface OpCommittedEvent extends BaseOpEvent {
	readonly type: "op.committed";
	readonly durationMs: number;
	readonly shardIds: readonly string[];
}

export interface OpRejectedEvent extends BaseOpEvent {
	readonly type: "op.rejected";
	readonly code: string;
	readonly message: string;
	readonly durationMs: number;
}

export interface CasConflictEvent extends BaseEvent {
	readonly type: "cas.conflict";
	readonly channelId: string;
	readonly opId: string;
	readonly operationName: string;
	readonly failedShardId: string;
	readonly expectedVersion: number;
	readonly currentVersion: number;
}

export interface BroadcastSentEvent extends BaseEvent {
	readonly type: "broadcast.sent";
	readonly channelId: string;
	/** The op that caused the broadcast, if any. Dirty-flush broadcasts have no op. */
	readonly opId: string | undefined;
	readonly operationName: string | undefined;
	readonly shardCount: number;
	readonly subscriberCount: number;
}

export interface HookFailedEvent extends BaseEvent {
	readonly type: "hook.failed";
	readonly channelId: string;
	readonly opId: string;
	readonly operationName: string;
	readonly actor: BaseActor;
	readonly error: unknown;
}

export interface ConnectionOpenedEvent extends BaseEvent {
	readonly type: "connection.opened";
	readonly actor: BaseActor;
}

export interface ConnectionClosedEvent extends BaseEvent {
	readonly type: "connection.closed";
	readonly actor: BaseActor;
	readonly reason: string;
}

export type KioEvent =
	| OpSubmittedEvent
	| OpCommittedEvent
	| OpRejectedEvent
	| CasConflictEvent
	| BroadcastSentEvent
	| HookFailedEvent
	| ConnectionOpenedEvent
	| ConnectionClosedEvent;

export type EventEmitter = (event: KioEvent) => void;

/**
 * Invoke an optional listener with the given event. Swallows listener errors
 * (with a console.warn) so that observability failures can never affect
 * operation outcomes.
 */
export function safeEmit(
	emitter: EventEmitter | undefined,
	event: KioEvent,
): void {
	if (!emitter) return;
	try {
		emitter(event);
	} catch (err) {
		console.warn("[kio] onEvent listener threw:", err);
	}
}

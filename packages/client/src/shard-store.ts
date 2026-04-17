import type { BroadcastShardEntry, ShardState } from "@kiojs/shared";
import { applyPatches, enableMapSet, enablePatches } from "immer";

enablePatches();
enableMapSet();

type Listener = () => void;

/** In-flight operation metadata stored on the shard */
export interface InFlight {
	readonly opId: string;
	readonly operationName: string;
	readonly input: unknown;
}

/**
 * Client-side store for a single shard's state.
 * Framework-agnostic — compatible with useSyncExternalStore via kio-react.
 *
 * Lifecycle: unavailable → loading → latest
 * - unavailable: no access (initial, or access revoked)
 * - loading: access granted, waiting for first state from server
 * - latest: has current state from server
 *
 * Optimistic lifecycle:
 * - inFlight: an operation has been sent to the server, awaiting response
 * - prediction: the predicted state from running apply() at submit time
 *
 * These have independent lifetimes:
 * - prediction is dropped on any broadcast to this shard
 * - inFlight is cleared on server response (ack/reject), timeout, or disconnect
 *
 * Snapshot caching:
 * The snapshot is rebuilt once per state change (in notify()) and cached.
 * Repeated reads between changes return the same object reference.
 * This is required by useSyncExternalStore and benefits any reactive framework.
 */
export class ShardStore<T extends Record<string, unknown>> {
	/** State received from the server's last broadcast. null until first broadcast arrives. */
	private received: { state: T; version: number } | null = null;
	private accessGranted = false;
	private listeners = new Set<Listener>();

	/** In-flight operation — cleared on server response, timeout, or disconnect */
	private inFlight: InFlight | null = null;
	/** Predicted state from optimistic apply — dropped on any broadcast */
	private prediction: { state: T } | null = null;
	/** Cached snapshot — rebuilt in notify(), returned by snapshot getter */
	private cachedSnapshot: ShardState<T>;

	constructor(private readonly kind: "durable" | "ephemeral") {
		this.cachedSnapshot = {
			syncStatus: "unavailable",
			state: null,
			pending: null,
		};
	}

	/** Consumer-facing snapshot — referentially stable between state changes. */
	get snapshot(): ShardState<T> {
		return this.cachedSnapshot;
	}

	/** Whether this shard has an in-flight operation (blocks new optimistic submits) */
	get hasInFlight(): boolean {
		return this.inFlight !== null;
	}

	/** Get the in-flight operation metadata (for retry logic) */
	getInFlight(): InFlight | null {
		return this.inFlight;
	}

	/** The current authoritative state (for building apply() input) */
	get authoritative(): T | null {
		return this.received?.state ?? null;
	}

	/**
	 * Set the in-flight operation and predicted state after optimistic apply.
	 * Called by ClientChannelEngine on optimistic submit.
	 */
	setOptimistic(inFlight: InFlight, predictedState: T): void {
		this.inFlight = inFlight;
		this.prediction = { state: predictedState };
		this.notify();
	}

	/**
	 * Clear the in-flight slot. Called on server acknowledge, reject, timeout, or disconnect.
	 * Also clears prediction if it still exists.
	 */
	clearInFlight(): void {
		if (!this.inFlight) return;
		this.inFlight = null;
		this.prediction = null;
		this.notify();
	}

	/**
	 * Apply a broadcast entry from the server.
	 * Handles full state and patch entries.
	 * Durable shards ignore stale broadcasts (version <= current).
	 *
	 * If a prediction exists, it is always dropped — authoritative state is truth.
	 * If causedBy.opId matches our in-flight, also clears in-flight (confirmed).
	 */
	applyBroadcastEntry(entry: BroadcastShardEntry): void {
		if (
			this.kind === "durable" &&
			this.received &&
			entry.version <= this.received.version
		) {
			return;
		}

		if ("state" in entry) {
			this.received = {
				state: entry.state as T,
				version: entry.version,
			};
		} else if (this.received) {
			this.received = {
				state: applyPatches(this.received.state, entry.patches) as T,
				version: entry.version,
			};
		} else {
			// Patches without existing state — can't apply. Ignore.
			return;
		}

		// Drop prediction on any broadcast
		this.prediction = null;

		// If this broadcast confirms our in-flight operation, clear it
		if (
			this.inFlight &&
			entry.causedBy &&
			entry.causedBy.opId === this.inFlight.opId
		) {
			this.inFlight = null;
		}

		this.notify();
	}

	/** Grant access — transitions from unavailable to loading */
	grantAccess(): void {
		if (this.accessGranted) return;
		this.accessGranted = true;
		this.notify();
	}

	/** Revoke access — transitions to unavailable, clears state */
	revokeAccess(): void {
		if (!this.accessGranted) return;
		this.accessGranted = false;
		this.received = null;
		this.inFlight = null;
		this.prediction = null;
		this.notify();
	}

	/** Version of the last received state (for broadcast version comparison) */
	get version(): number | null {
		return this.received?.version ?? null;
	}

	/** Subscribe to state changes. Returns unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		this.cachedSnapshot = this.buildSnapshot();
		for (const listener of this.listeners) {
			listener();
		}
	}

	private buildSnapshot(): ShardState<T> {
		if (!this.accessGranted) {
			return { syncStatus: "unavailable", state: null, pending: null };
		}
		if (!this.received) {
			return { syncStatus: "loading", state: null, pending: null };
		}
		const pending = this.inFlight
			? {
					operationName: this.inFlight.operationName,
					input: this.inFlight.input,
				}
			: null;
		return {
			syncStatus: "latest",
			state: this.prediction ? this.prediction.state : this.received.state,
			pending,
		};
	}
}

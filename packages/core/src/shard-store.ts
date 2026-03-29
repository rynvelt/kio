import { applyPatches, enableMapSet, enablePatches } from "immer";
import type { BroadcastShardEntry } from "./broadcast";
import type { ShardState } from "./state";

enablePatches();
enableMapSet();

type Listener = () => void;

/**
 * Client-side store for a single shard's state.
 * Framework-agnostic — compatible with useSyncExternalStore via kio-react.
 *
 * Lifecycle: unavailable → loading → latest
 * - unavailable: no access (initial, or access revoked)
 * - loading: access granted, waiting for first state from server
 * - latest: has current state from server
 */
export class ShardStore<T extends Record<string, unknown>> {
	/** State received from the server's last broadcast. null until first broadcast arrives. */
	private received: { state: T; version: number } | null = null;
	private accessGranted = false;
	private listeners = new Set<Listener>();

	constructor(private readonly kind: "durable" | "ephemeral") {}

	/** Consumer-facing snapshot — derived from received state + access. */
	get snapshot(): ShardState<T> {
		if (!this.accessGranted) {
			return { syncStatus: "unavailable", state: null, pending: null };
		}
		if (!this.received) {
			return { syncStatus: "loading", state: null, pending: null };
		}
		return {
			syncStatus: "latest",
			state: this.received.state,
			pending: null,
		};
	}

	/**
	 * Apply a broadcast entry from the server.
	 * Handles full state and patch entries.
	 * Durable shards ignore stale broadcasts (version <= current).
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
		for (const listener of this.listeners) {
			listener();
		}
	}
}

import type { ShardState } from "./state";

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
export class ShardStore<T> {
	/** State received from the server's last broadcast. null until first broadcast arrives. */
	private received: { state: T; version: number } | null = null;
	private accessGranted = false;
	private listeners = new Set<Listener>();

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

	/** Set state from a server broadcast */
	setState(state: T, version: number): void {
		this.received = { state, version };
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

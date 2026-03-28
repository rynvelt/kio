import type { ShardState } from "./state";

type Listener = () => void;

/**
 * Client-side store for a single shard's state.
 * Framework-agnostic — compatible with useSyncExternalStore, Solid signals, Svelte stores.
 *
 * Lifecycle: unavailable → loading → latest
 * - unavailable: no access (initial, or access revoked)
 * - loading: access granted, waiting for first state delivery
 * - latest: has current state from server
 */
export class ShardStore<T> {
	private authoritative: { state: T; version: number } | null = null;
	private status: "unavailable" | "loading" | "latest" = "unavailable";
	private listeners = new Set<Listener>();
	private cachedSnapshot: ShardState<T> | null = null;

	/** Transition to "loading" — access granted but no state yet */
	setLoading(): void {
		if (this.status === "loading") return;
		this.status = "loading";
		this.authoritative = null;
		this.invalidate();
	}

	/** Transition to "unavailable" — access revoked or not yet granted */
	setUnavailable(): void {
		if (this.status === "unavailable") return;
		this.status = "unavailable";
		this.authoritative = null;
		this.invalidate();
	}

	/** Set authoritative state from a server broadcast (full state) */
	setState(state: T, version: number): void {
		this.authoritative = { state, version };
		this.status = "latest";
		this.invalidate();
	}

	/** Get the current snapshot — stable reference, only changes when state changes */
	get snapshot(): ShardState<T> {
		if (this.cachedSnapshot) return this.cachedSnapshot;

		let snap: ShardState<T>;
		switch (this.status) {
			case "unavailable":
				snap = { syncStatus: "unavailable", state: null, pending: null };
				break;
			case "loading":
				snap = { syncStatus: "loading", state: null, pending: null };
				break;
			case "latest": {
				const auth = this.authoritative;
				if (!auth)
					throw new Error("ShardStore: latest without authoritative state");
				snap = {
					syncStatus: "latest",
					state: auth.state,
					pending: null,
				};
				break;
			}
		}

		this.cachedSnapshot = snap;
		return snap;
	}

	/** Subscribe to state changes. Returns unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Current authoritative version (for durable shards) */
	get version(): number | null {
		return this.authoritative?.version ?? null;
	}

	private invalidate(): void {
		this.cachedSnapshot = null;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

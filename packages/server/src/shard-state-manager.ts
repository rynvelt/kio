import {
	buildShardAccessors,
	type ShardDefinition,
	type ShardRef,
} from "@kio/shared";
import {
	enableMapSet,
	enablePatches,
	type Patch,
	produceWithPatches,
} from "immer";
import type { StateAdapter } from "./persistence";

enablePatches();
enableMapSet();

/** Cached shard state with version */
interface CachedShard {
	state: unknown;
	version: number;
}

/** Result of applying an operation to shards */
export interface ApplyResult {
	/** New state per shard ID */
	readonly newStates: ReadonlyMap<string, { state: unknown; version: number }>;
	/** Patches per shard ID (first path segment stripped) */
	readonly patches: ReadonlyMap<string, readonly Patch[]>;
}

/** Callback fired when a shard's cached state changes */
export type ShardChangeListener = (shardId: string) => void;

/** Manages shard state: loading, caching, applying via Immer, writing back */
export class ShardStateManager {
	private readonly cache = new Map<string, CachedShard>();
	private changeListener: ShardChangeListener | undefined;

	constructor(
		private readonly channelId: string,
		private readonly shardDefs: ReadonlyMap<string, ShardDefinition>,
		private readonly adapter: StateAdapter,
	) {}

	/** Register a listener called whenever a shard's cached state changes */
	onChange(listener: ShardChangeListener): void {
		this.changeListener = listener;
	}

	private notifyChange(shardId: string): void {
		this.changeListener?.(shardId);
	}

	/** Load shard states for the given refs. Uses cache, falls back to persistence. */
	async loadShards(
		refs: readonly ShardRef[],
	): Promise<Map<string, CachedShard>> {
		const result = new Map<string, CachedShard>();

		for (const ref of refs) {
			const existing = this.cache.get(ref.shardId);
			if (existing) {
				result.set(ref.shardId, existing);
				continue;
			}

			const persisted = await this.adapter.load(this.channelId, ref.shardId);
			let cached: CachedShard;
			if (persisted) {
				cached = { state: persisted.state, version: persisted.version };
			} else {
				const def = this.shardDefs.get(ref.shardType);
				cached = {
					state: def ? this.resolveDefaultState(def, ref.shardId) : undefined,
					version: 0,
				};
			}

			this.cache.set(ref.shardId, cached);
			result.set(ref.shardId, cached);
		}

		return result;
	}

	/**
	 * Resolve the initial state for a shard that has never been written.
	 * For singletons: returns the static `defaultState` value.
	 * For per-resource: invokes `defaultState(resourceId)` if it's a function,
	 * otherwise returns the static value. Returns undefined when no default
	 * is declared (legacy behavior).
	 */
	private resolveDefaultState(def: ShardDefinition, shardId: string): unknown {
		if (def.defaultState === undefined) return undefined;
		if (def.kind === "singleton") return def.defaultState;
		if (typeof def.defaultState === "function") {
			const resourceId = shardId.startsWith(`${def.name}:`)
				? shardId.slice(def.name.length + 1)
				: shardId;
			return (def.defaultState as (id: string) => unknown)(resourceId);
		}
		return def.defaultState;
	}

	/** Build a composed root object from loaded shard states */
	buildComposedRoot(
		shards: ReadonlyMap<string, CachedShard>,
	): Record<string, unknown> {
		const root: Record<string, unknown> = {};
		for (const [shardId, cached] of shards) {
			root[shardId] = cached.state;
		}
		return root;
	}

	/** Build shard accessors from a root object. Delegates to shared utility. */
	buildAccessors(
		root: Record<string, unknown>,
		scopedRefs: readonly ShardRef[],
	): Record<string, unknown> {
		return buildShardAccessors(root, scopedRefs, this.shardDefs);
	}

	/**
	 * Apply a mutation function to a composed root via Immer.
	 * Returns new states and patches decomposed per shard.
	 */
	applyMutation(
		root: Record<string, unknown>,
		scopedRefs: readonly ShardRef[],
		mutate: (accessors: Record<string, unknown>) => void,
	): {
		newRoot: Record<string, unknown>;
		patchesByShard: Map<string, Patch[]>;
	} {
		const [newRoot, patches] = produceWithPatches(root, (draft) => {
			const accessors = this.buildAccessors(
				draft as Record<string, unknown>,
				scopedRefs,
			);
			mutate(accessors);
		});

		const patchesByShard = new Map<string, Patch[]>();
		for (const patch of patches) {
			const shardKey = patch.path[0];
			if (typeof shardKey === "string") {
				const existing = patchesByShard.get(shardKey) ?? [];
				existing.push({
					...patch,
					path: patch.path.slice(1),
				});
				patchesByShard.set(shardKey, existing);
			}
		}

		return { newRoot, patchesByShard };
	}

	/**
	 * Persist new shard states via CAS. Updates cache on success.
	 * For single shard: uses compareAndSwap.
	 * For multiple shards: uses compareAndSwapMulti.
	 */
	async persist(
		shards: ReadonlyMap<string, CachedShard>,
		newRoot: Record<string, unknown>,
	): Promise<
		| { success: true; versions: Map<string, number> }
		| { success: false; failedShardId: string }
	> {
		const entries = [...shards.entries()];

		const first = entries[0];
		if (entries.length === 1 && first) {
			const [shardId, cached] = first;
			const result = await this.adapter.compareAndSwap(
				this.channelId,
				shardId,
				cached.version,
				newRoot[shardId],
			);

			if (!result.success) {
				this.cache.set(shardId, {
					state: result.currentState,
					version: result.currentVersion,
				});
				return { success: false, failedShardId: shardId };
			}

			this.cache.set(shardId, {
				state: newRoot[shardId],
				version: result.version,
			});
			this.notifyChange(shardId);
			return { success: true, versions: new Map([[shardId, result.version]]) };
		}

		const operations = entries.map(([shardId, cached]) => ({
			channelId: this.channelId,
			shardId,
			expectedVersion: cached.version,
			newState: newRoot[shardId],
		}));

		const result = await this.adapter.compareAndSwapMulti(operations);

		if (!result.success) {
			return { success: false, failedShardId: result.failedShardId };
		}

		for (const [shardId] of entries) {
			const newVersion = result.versions.get(shardId);
			if (newVersion !== undefined) {
				this.cache.set(shardId, {
					state: newRoot[shardId],
					version: newVersion,
				});
				this.notifyChange(shardId);
			}
		}

		return { success: true, versions: new Map(result.versions) };
	}

	/**
	 * Persist unconditionally — no version check. For versionChecked: false operations.
	 * Always succeeds. Updates cache.
	 */
	async persistUnconditional(
		shardIds: readonly string[],
		newRoot: Record<string, unknown>,
	): Promise<{ versions: Map<string, number> }> {
		const versions = new Map<string, number>();

		for (const shardId of shardIds) {
			const result = await this.adapter.set(
				this.channelId,
				shardId,
				newRoot[shardId],
			);
			this.cache.set(shardId, {
				state: newRoot[shardId],
				version: result.version,
			});
			this.notifyChange(shardId);
			versions.set(shardId, result.version);
		}

		return { versions };
	}

	/** Get cached shard state (for broadcasting) */
	getCached(shardId: string): CachedShard | undefined {
		return this.cache.get(shardId);
	}

	/** Update cache directly (for ephemeral channels that skip persistence) */
	setCached(shardId: string, state: unknown, version: number): void {
		this.cache.set(shardId, { state, version });
		this.notifyChange(shardId);
	}
}

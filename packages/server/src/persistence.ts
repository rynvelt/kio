/** Persisted shard state with version for optimistic concurrency */
export interface PersistedShard {
	readonly state: unknown;
	readonly version: number;
}

/** Compare-and-swap result for single-shard operations */
export type CasResult =
	| { readonly success: true; readonly version: number }
	| {
			readonly success: false;
			readonly currentVersion: number;
			readonly currentState: unknown;
	  };

/** Compare-and-swap result for multi-shard operations */
export type CasMultiResult =
	| {
			readonly success: true;
			readonly versions: ReadonlyMap<string, number>;
	  }
	| {
			readonly success: false;
			readonly failedShardId: string;
			readonly currentVersion: number;
			readonly currentState: unknown;
	  };

/**
 * Persistence adapter interface — pluggable storage backend.
 *
 * Error contract:
 * - Return result objects (CasResult, CasMultiResult) for version conflicts.
 *   These are expected outcomes that the engine handles via retry or rejection.
 * - Throw for infrastructure errors (database unreachable, serialization failure,
 *   constraint violations, etc.). The engine catches thrown errors and maps them
 *   to INTERNAL_ERROR for the client. The adapter should not retry internally.
 * - State values are JSON-serializable. The adapter stores and retrieves them
 *   as-is — no transformation. Round-tripping must preserve value equality.
 */
export interface StateAdapter {
	/**
	 * Load shard state. Returns undefined if the shard has never been persisted.
	 * Throws on infrastructure errors.
	 */
	load(channelId: string, shardId: string): Promise<PersistedShard | undefined>;

	/**
	 * Unconditional write — always succeeds. Creates the shard if it doesn't exist,
	 * or overwrites it if it does. Increments the version in both cases.
	 * Used for versionChecked: false operations.
	 * Throws on infrastructure errors.
	 */
	set(
		channelId: string,
		shardId: string,
		newState: unknown,
	): Promise<{ version: number }>;

	/**
	 * Atomically update shard state if the current version matches expectedVersion.
	 * Returns { success: true, version } on match, or { success: false, currentVersion,
	 * currentState } on mismatch. The new version must be expectedVersion + 1.
	 * Throws on infrastructure errors.
	 */
	compareAndSwap(
		channelId: string,
		shardId: string,
		expectedVersion: number,
		newState: unknown,
	): Promise<CasResult>;

	/**
	 * Atomically update multiple shards. All must match their expectedVersion or none
	 * are written. Returns { success: true, versions } if all match, or { success: false,
	 * failedShardId, currentVersion, currentState } identifying the first mismatch.
	 * Implementations should use a database transaction or equivalent atomic mechanism.
	 * Throws on infrastructure errors.
	 */
	compareAndSwapMulti(
		operations: ReadonlyArray<{
			readonly channelId: string;
			readonly shardId: string;
			readonly expectedVersion: number;
			readonly newState: unknown;
		}>,
	): Promise<CasMultiResult>;
}

/** In-memory persistence adapter for testing */
export class MemoryStateAdapter implements StateAdapter {
	private readonly store = new Map<
		string,
		{ state: unknown; version: number }
	>();

	private key(channelId: string, shardId: string): string {
		return `${channelId}\0${shardId}`;
	}

	async set(
		channelId: string,
		shardId: string,
		newState: unknown,
	): Promise<{ version: number }> {
		const k = this.key(channelId, shardId);
		const entry = this.store.get(k);
		const newVersion = (entry?.version ?? 0) + 1;
		this.store.set(k, { state: newState, version: newVersion });
		return { version: newVersion };
	}

	async load(
		channelId: string,
		shardId: string,
	): Promise<PersistedShard | undefined> {
		const entry = this.store.get(this.key(channelId, shardId));
		if (!entry) return undefined;
		return { state: entry.state, version: entry.version };
	}

	async compareAndSwap(
		channelId: string,
		shardId: string,
		expectedVersion: number,
		newState: unknown,
	): Promise<CasResult> {
		const k = this.key(channelId, shardId);
		const entry = this.store.get(k);
		const currentVersion = entry?.version ?? 0;

		if (currentVersion !== expectedVersion) {
			return {
				success: false,
				currentVersion,
				currentState: entry?.state,
			};
		}

		const newVersion = currentVersion + 1;
		this.store.set(k, { state: newState, version: newVersion });
		return { success: true, version: newVersion };
	}

	async compareAndSwapMulti(
		operations: ReadonlyArray<{
			readonly channelId: string;
			readonly shardId: string;
			readonly expectedVersion: number;
			readonly newState: unknown;
		}>,
	): Promise<CasMultiResult> {
		if (operations.length === 0) {
			return { success: true, versions: new Map() };
		}

		// Check all versions first
		for (const op of operations) {
			const k = this.key(op.channelId, op.shardId);
			const entry = this.store.get(k);
			const currentVersion = entry?.version ?? 0;

			if (currentVersion !== op.expectedVersion) {
				return {
					success: false,
					failedShardId: op.shardId,
					currentVersion,
					currentState: entry?.state,
				};
			}
		}

		// All matched — apply all
		const versions = new Map<string, number>();
		for (const op of operations) {
			const k = this.key(op.channelId, op.shardId);
			const entry = this.store.get(k);
			const newVersion = (entry?.version ?? 0) + 1;
			this.store.set(k, { state: op.newState, version: newVersion });
			versions.set(op.shardId, newVersion);
		}

		return { success: true, versions };
	}
}

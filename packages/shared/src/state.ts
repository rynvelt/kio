/**
 * Client-side shard state — discriminated union on syncStatus.
 *
 * `TFallback` controls the `state` type for `unavailable` and `loading`.
 * Defaults to `null`, matching the raw snapshot. Consumer hooks that
 * accept a fallback value set `TFallback = T` so `state` is always
 * usable without narrowing on `syncStatus`.
 */
export type ShardState<T, TFallback = null> =
	| {
			readonly syncStatus: "unavailable";
			readonly state: TFallback;
			readonly pending: null;
	  }
	| {
			readonly syncStatus: "loading";
			readonly state: TFallback;
			readonly pending: null;
	  }
	| {
			readonly syncStatus: "stale";
			readonly state: T;
			readonly pending: PendingOperation | null;
	  }
	| {
			readonly syncStatus: "latest";
			readonly state: T;
			readonly pending: PendingOperation | null;
	  };

export interface PendingOperation {
	readonly operationName: string;
	readonly input: unknown;
}

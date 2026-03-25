/** Client-side shard state — discriminated union on syncStatus */
export type ShardState<T> =
	| {
			readonly syncStatus: "unavailable";
			readonly state: null;
			readonly pending: null;
	  }
	| {
			readonly syncStatus: "loading";
			readonly state: null;
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

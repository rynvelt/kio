/** Engine-defined error codes — always possible on any rejection */
export type EngineErrorCode =
	| "VERSION_CONFLICT"
	| "UNAUTHORIZED"
	| "DUPLICATE_OPERATION"
	| "SHARD_NOT_FOUND"
	| "INVALID_INPUT"
	| "INVALID_OPERATION"
	| "INVALID_CHANNEL"
	| "INTERNAL_ERROR";

/** Client-only block code — no server round-trip happened */
export type BlockedCode = "PENDING_OPERATION";

/** Full error info on a rejection */
export interface RejectionError<TCode extends string = string> {
	readonly code: TCode;
	readonly message: string;
}

/** Submit result — discriminated union, never throws */
export type SubmitResult<
	TConsumerErrors extends string = string,
	TFreshState = unknown,
> =
	| { readonly status: "acknowledged" }
	| {
			readonly status: "rejected";
			readonly error: RejectionError<TConsumerErrors | EngineErrorCode>;
			readonly freshState?: TFreshState;
	  }
	| {
			readonly status: "blocked";
			readonly error: RejectionError<BlockedCode>;
	  }
	| { readonly status: "timeout" }
	| { readonly status: "disconnected" };

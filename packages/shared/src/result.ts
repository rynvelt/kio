/** Engine-defined error codes — always possible on any rejection */
export type EngineErrorCode =
	| "VERSION_CONFLICT"
	| "UNAUTHORIZED"
	| "DUPLICATE_OPERATION"
	| "SHARD_NOT_FOUND"
	| "INVALID_INPUT"
	| "INVALID_OPERATION"
	| "INVALID_CHANNEL"
	| "SERVER_ONLY_OPERATION"
	| "INTERNAL_ERROR";

/** Client-only block code — no server round-trip happened */
export type BlockedCode = "PENDING_OPERATION";

/** Full error info on a rejection */
export interface RejectionError<TCode extends string = string> {
	readonly code: TCode;
	readonly message: string;
}

/**
 * Submit result — discriminated union, never throws.
 *
 * `ok` is true only when the server acknowledged the operation. Consumers
 * that don't care which failure happened can branch on `!result.ok`;
 * consumers that do can still switch on `status`.
 */
export type SubmitResult<
	TConsumerErrors extends string = string,
	TFreshState = unknown,
> =
	| { readonly ok: true; readonly status: "acknowledged" }
	| {
			readonly ok: false;
			readonly status: "rejected";
			readonly error: RejectionError<TConsumerErrors | EngineErrorCode>;
			readonly freshState?: TFreshState;
	  }
	| {
			readonly ok: false;
			readonly status: "blocked";
			readonly error: RejectionError<BlockedCode>;
	  }
	| { readonly ok: false; readonly status: "timeout" }
	| { readonly ok: false; readonly status: "disconnected" };

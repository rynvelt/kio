import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Infer the output type from any StandardSchema-compatible schema */
export type InferSchema<T> =
	T extends StandardSchemaV1<infer _Input, infer Output> ? Output : never;

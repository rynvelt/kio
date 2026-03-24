import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferSchema } from "./schema";
import type { ShardRef } from "./shard";

// ── Shard type tracking ──────────────────────────────────────────────

export interface ShardDefs {
	readonly singletons: object;
	readonly perResource: object;
}

// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation via intersection
type EmptyShardDefs = { readonly singletons: {}; readonly perResource: {} };

type AddSingleton<D extends ShardDefs, Name extends string, State> = {
	readonly singletons: D["singletons"] & Record<Name, State>;
	readonly perResource: D["perResource"];
};

type AddPerResource<D extends ShardDefs, Name extends string, State> = {
	readonly singletons: D["singletons"];
	readonly perResource: D["perResource"] & Record<Name, State>;
};

// ── Shard accessors ──────────────────────────────────────────────────

export type ShardAccessors<D extends ShardDefs> = {
	readonly [K in keyof D["singletons"]]: D["singletons"][K];
} & {
	readonly [K in keyof D["perResource"]]: (
		resourceId: string,
	) => D["perResource"][K];
};

// ── Operation context ────────────────────────────────────────────────

export interface OperationContext<TActor = { actorId: string }> {
	readonly actor: TActor;
	readonly channelId: string;
}

// ── Operation metadata (tracked in Ops type parameter) ───────────────

type Execution = "optimistic" | "confirmed" | "computed";

type ExtractErrors<E> = E extends StandardSchemaV1
	? InferSchema<E> & string
	: never;

type ExtractServerResult<S> = S extends StandardSchemaV1
	? InferSchema<S>
	: undefined;

interface OpMeta<
	TExecution extends Execution,
	TInput,
	TErrorsSchema,
	TServerResultSchema,
> {
	readonly _execution: TExecution;
	readonly _input: TInput;
	readonly _errorsSchema: TErrorsSchema;
	readonly _serverResultSchema: TServerResultSchema;
}

// ── Shared operation configs (schema.ts) ─────────────────────────────

interface BaseOperationFields<TInput> {
	readonly versionChecked: boolean;
	readonly deduplicate: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly scope: (input: TInput, ctx: OperationContext) => readonly ShardRef[];
}

interface OptimisticOperationConfig<D extends ShardDefs, TInput>
	extends BaseOperationFields<TInput> {
	readonly execution: "optimistic";
	readonly apply: (
		shards: ShardAccessors<D>,
		input: TInput,
		serverResult: undefined,
		ctx: OperationContext,
	) => void;
}

interface ConfirmedOperationConfig<TInput> extends BaseOperationFields<TInput> {
	readonly execution: "confirmed";
}

interface ComputedOperationConfig<TInput> extends BaseOperationFields<TInput> {
	readonly execution: "computed";
}

/**
 * Errors and serverResult schemas are captured as separate generics
 * rather than through the config interfaces, because TypeScript can't
 * infer types through StandardSchemaV1's optional `types` property.
 */
interface InferredSchemaFields<
	TErrorsSchema extends StandardSchemaV1 | undefined = undefined,
	TServerResultSchema extends StandardSchemaV1 | undefined = undefined,
> {
	readonly errors?: TErrorsSchema;
	readonly serverResult?: TServerResultSchema;
}

// ── Server impl configs (schema.server.ts) ───────────────────────────

type RejectFn<TErrors extends string> = (
	code: TErrors,
	message: string,
) => never;

type ValidateFn<D extends ShardDefs, TInput, TErrors extends string> = (
	shards: ShardAccessors<D>,
	input: TInput,
	ctx: OperationContext,
	tools: { readonly reject: RejectFn<TErrors> },
) => void;

type ApplyFn<D extends ShardDefs, TInput, TServerResult> = (
	shards: ShardAccessors<D>,
	input: TInput,
	serverResult: TServerResult,
	ctx: OperationContext,
) => void;

type ComputeFn<D extends ShardDefs, TInput, TServerResult> = (
	shards: ShardAccessors<D>,
	input: TInput,
	ctx: OperationContext,
) => TServerResult;

/** Maps execution type → required server impl shape */
type ServerImplMap<
	D extends ShardDefs,
	TInput,
	TErrors extends string,
	TServerResult,
> = {
	optimistic: {
		readonly validate?: ValidateFn<D, TInput, TErrors>;
	};
	confirmed: {
		readonly validate?: ValidateFn<D, TInput, TErrors>;
		readonly apply: ApplyFn<D, TInput, undefined>;
	};
	computed: {
		readonly validate?: ValidateFn<D, TInput, TErrors>;
		readonly compute?: ComputeFn<D, TInput, TServerResult>;
		readonly apply: ApplyFn<D, TInput, TServerResult>;
	};
};

/** Resolve server impl config from operation metadata */
type ServerImplConfig<D extends ShardDefs, Meta> = Meta extends {
	_execution: infer E extends Execution;
	_input: infer TInput;
	_errorsSchema: infer TES;
	_serverResultSchema: infer TSRS;
}
	? ServerImplMap<D, TInput, ExtractErrors<TES>, ExtractServerResult<TSRS>>[E]
	: never;

/** Pre-compute ServerImplConfig for all operations in the Ops record */
type ServerImplLookup<D extends ShardDefs, Ops> = {
	[K in keyof Ops]: ServerImplConfig<D, Ops[K]>;
};

// ── Channel builder ──────────────────────────────────────────────────

type ChannelKind = "durable" | "ephemeral";

export interface ChannelBuilder<
	Kind extends ChannelKind,
	Name extends string,
	D extends ShardDefs,
	Ops extends object = object,
> {
	readonly kind: Kind;
	readonly name: Name;

	shard<SName extends string, S extends StandardSchemaV1>(
		name: SName,
		schema: S,
	): ChannelBuilder<Kind, Name, AddSingleton<D, SName, InferSchema<S>>, Ops>;

	shardPerResource<SName extends string, S extends StandardSchemaV1>(
		name: SName,
		schema: S,
	): ChannelBuilder<Kind, Name, AddPerResource<D, SName, InferSchema<S>>, Ops>;

	// Overload: optimistic
	operation<
		OName extends string,
		TInput,
		TES extends StandardSchemaV1 | undefined = undefined,
	>(
		name: OName,
		config: OptimisticOperationConfig<D, TInput> &
			InferredSchemaFields<TES, undefined>,
	): ChannelBuilder<
		Kind,
		Name,
		D,
		Ops & Record<OName, OpMeta<"optimistic", TInput, TES, undefined>>
	>;

	// Overload: confirmed
	operation<
		OName extends string,
		TInput,
		TES extends StandardSchemaV1 | undefined = undefined,
	>(
		name: OName,
		config: ConfirmedOperationConfig<TInput> &
			InferredSchemaFields<TES, undefined>,
	): ChannelBuilder<
		Kind,
		Name,
		D,
		Ops & Record<OName, OpMeta<"confirmed", TInput, TES, undefined>>
	>;

	// Overload: computed
	operation<
		OName extends string,
		TInput,
		TES extends StandardSchemaV1 | undefined = undefined,
		TSRS extends StandardSchemaV1 | undefined = undefined,
	>(
		name: OName,
		config: ComputedOperationConfig<TInput> & InferredSchemaFields<TES, TSRS>,
	): ChannelBuilder<
		Kind,
		Name,
		D,
		Ops & Record<OName, OpMeta<"computed", TInput, TES, TSRS>>
	>;

	serverImpl<OName extends string & keyof Ops>(
		name: OName,
		config: ServerImplLookup<D, Ops>[OName],
	): ChannelBuilder<Kind, Name, D, Ops>;
}

// ── Channel constructors ─────────────────────────────────────────────

interface ChannelOptions {
	readonly autoBroadcast?: boolean;
	readonly broadcastMode?: "patch" | "full";
}

// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation
type EmptyOps = {};

function createChannelBuilder<Kind extends ChannelKind, Name extends string>(
	kind: Kind,
	name: Name,
	_options?: ChannelOptions,
): ChannelBuilder<Kind, Name, EmptyShardDefs, EmptyOps> {
	const builder: ChannelBuilder<Kind, Name, EmptyShardDefs, EmptyOps> = {
		kind,
		name,
		shard(_name, _schema) {
			return builder as never;
		},
		shardPerResource(_name, _schema) {
			return builder as never;
		},
		// biome-ignore lint/suspicious/noExplicitAny: overloaded method needs loose impl signature
		operation(_name: string, _config: any) {
			return builder as never;
		},
		serverImpl(_name, _config) {
			return builder as never;
		},
	};
	return builder;
}

export const channel = {
	durable<Name extends string>(name: Name, options?: ChannelOptions) {
		return createChannelBuilder("durable", name, options);
	},
	ephemeral<Name extends string>(name: Name, options?: ChannelOptions) {
		return createChannelBuilder("ephemeral", name, options);
	},
} as const;

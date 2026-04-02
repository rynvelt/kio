import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferSchema } from "./schema";
import type { ShardRef } from "./shard";

// ── Runtime data structures ──────────────────────────────────────────

export interface ShardDefinition {
	readonly name: string;
	readonly kind: "singleton" | "perResource";
	readonly schema: StandardSchemaV1;
}

export interface OperationDefinition {
	readonly name: string;
	readonly execution: "optimistic" | "confirmed" | "computed";
	readonly versionChecked?: boolean;
	readonly deduplicate?: boolean;
	readonly inputSchema: StandardSchemaV1;
	readonly errorsSchema: StandardSchemaV1 | undefined;
	readonly serverResultSchema: StandardSchemaV1 | undefined;
	readonly scope: (input: unknown, ctx: unknown) => readonly ShardRef[];
	readonly apply:
		| ((
				shards: unknown,
				input: unknown,
				serverResult: unknown,
				ctx: unknown,
		  ) => void)
		| undefined;
}

export interface ServerImplDefinition {
	readonly validate: ((...args: readonly unknown[]) => void) | undefined;
	readonly compute: ((...args: readonly unknown[]) => unknown) | undefined;
	readonly apply: ((...args: readonly unknown[]) => void) | undefined;
}

export interface ClientImplDefinition {
	readonly canRetry:
		| ((input: unknown, freshShards: unknown, attemptCount: number) => boolean)
		| undefined;
}

/** Runtime data collected by the builder — accessible to the engine */
export interface ChannelData {
	readonly kind: "durable" | "ephemeral";
	readonly name: string;
	readonly options: ChannelOptions;
	readonly shardDefs: ReadonlyMap<string, ShardDefinition>;
	readonly operations: ReadonlyMap<string, OperationDefinition>;
	readonly serverImpls: ReadonlyMap<string, ServerImplDefinition>;
	readonly clientImpls: ReadonlyMap<string, ClientImplDefinition>;
}

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

/** Full shard accessors — all shards on the channel */
export type ShardAccessors<D extends ShardDefs> = {
	readonly [K in keyof D["singletons"]]: D["singletons"][K];
} & {
	readonly [K in keyof D["perResource"]]: (
		resourceId: string,
	) => D["perResource"][K];
};

/** Narrowed shard accessors — only shard types declared in scope */
export type ScopedShardAccessors<D extends ShardDefs, TNames extends string> = {
	readonly [K in keyof D["singletons"] & TNames]: D["singletons"][K];
} & {
	readonly [K in keyof D["perResource"] & TNames]: (
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

export interface OpMeta<
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

interface OptimisticOperationConfig<
	D extends ShardDefs,
	TInput,
	TScopeNames extends string,
> {
	readonly execution: "optimistic";
	readonly versionChecked?: boolean;
	readonly deduplicate?: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly scope: (
		input: TInput,
		ctx: OperationContext,
	) => readonly ShardRef<TScopeNames>[];
	readonly apply: (
		shards: ScopedShardAccessors<D, TScopeNames>,
		input: TInput,
		serverResult: undefined,
		ctx: OperationContext,
	) => void;
}

interface ConfirmedOperationConfig<TInput, TScopeNames extends string> {
	readonly execution: "confirmed";
	readonly versionChecked?: boolean;
	readonly deduplicate?: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly scope: (
		input: TInput,
		ctx: OperationContext,
	) => readonly ShardRef<TScopeNames>[];
}

interface ComputedOperationConfig<TInput, TScopeNames extends string> {
	readonly execution: "computed";
	readonly versionChecked?: boolean;
	readonly deduplicate?: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly scope: (
		input: TInput,
		ctx: OperationContext,
	) => readonly ShardRef<TScopeNames>[];
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

// ── Client impl configs (schema.client.ts) ───────────────────────────

type CanRetryFn<D extends ShardDefs, TInput> = (
	input: TInput,
	freshShards: ShardAccessors<D>,
	attemptCount: number,
) => boolean;

type ClientImplConfig<D extends ShardDefs, Meta> = Meta extends {
	_input: infer TInput;
}
	? { readonly canRetry?: CanRetryFn<D, TInput> }
	: never;

/** Pre-compute ClientImplConfig for all operations in the Ops record */
type ClientImplLookup<D extends ShardDefs, Ops> = {
	[K in keyof Ops]: ClientImplConfig<D, Ops[K]>;
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
	readonly "~data": ChannelData;

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
		TScopeNames extends string,
		TES extends StandardSchemaV1 | undefined = undefined,
	>(
		name: OName,
		config: OptimisticOperationConfig<D, TInput, TScopeNames> &
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
		TScopeNames extends string,
		TES extends StandardSchemaV1 | undefined = undefined,
	>(
		name: OName,
		config: ConfirmedOperationConfig<TInput, TScopeNames> &
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
		TScopeNames extends string,
		TES extends StandardSchemaV1 | undefined = undefined,
		TSRS extends StandardSchemaV1 | undefined = undefined,
	>(
		name: OName,
		config: ComputedOperationConfig<TInput, TScopeNames> &
			InferredSchemaFields<TES, TSRS>,
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

	clientImpl<OName extends string & keyof Ops>(
		name: OName,
		config: ClientImplLookup<D, Ops>[OName],
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
	options?: ChannelOptions,
): ChannelBuilder<Kind, Name, EmptyShardDefs, EmptyOps> {
	const shardDefs = new Map<string, ShardDefinition>();
	const operations = new Map<string, OperationDefinition>();
	const serverImpls = new Map<string, ServerImplDefinition>();
	const clientImpls = new Map<string, ClientImplDefinition>();

	const data: ChannelData = {
		kind,
		name,
		options: options ?? {},
		shardDefs,
		operations,
		serverImpls,
		clientImpls,
	};

	const builder = {
		kind,
		name,
		"~data": data,

		shard(shardName: string, schema: StandardSchemaV1) {
			shardDefs.set(shardName, { name: shardName, kind: "singleton", schema });
			return builder;
		},

		shardPerResource(shardName: string, schema: StandardSchemaV1) {
			shardDefs.set(shardName, {
				name: shardName,
				kind: "perResource",
				schema,
			});
			return builder;
		},

		// biome-ignore lint/suspicious/noExplicitAny: overloaded method needs loose impl signature
		operation(opName: string, config: any) {
			operations.set(opName, {
				name: opName,
				execution: config.execution,
				versionChecked: config.versionChecked ?? true,
				deduplicate: config.deduplicate ?? true,
				inputSchema: config.input,
				errorsSchema: config.errors ?? undefined,
				serverResultSchema: config.serverResult ?? undefined,
				scope: config.scope,
				apply: config.apply ?? undefined,
			});
			return builder;
		},

		// biome-ignore lint/suspicious/noExplicitAny: server impl config shape varies by execution type
		serverImpl(opName: string, config: any) {
			if (!operations.has(opName)) {
				throw new Error(
					`serverImpl: operation "${opName}" is not defined on channel "${name}"`,
				);
			}
			serverImpls.set(opName, {
				validate: config.validate ?? undefined,
				compute: config.compute ?? undefined,
				apply: config.apply ?? undefined,
			});
			return builder;
		},

		// biome-ignore lint/suspicious/noExplicitAny: client impl config shape varies
		clientImpl(opName: string, config: any) {
			if (!operations.has(opName)) {
				throw new Error(
					`clientImpl: operation "${opName}" is not defined on channel "${name}"`,
				);
			}
			clientImpls.set(opName, {
				canRetry: config.canRetry ?? undefined,
			});
			return builder;
		},
	};

	return builder as never;
}

export const channel = {
	durable<Name extends string>(name: Name, options?: ChannelOptions) {
		return createChannelBuilder("durable", name, options);
	},
	ephemeral<Name extends string>(name: Name, options?: ChannelOptions) {
		return createChannelBuilder("ephemeral", name, options);
	},
} as const;

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InferSchema } from "./schema";
import type { ShardRef } from "./shard";

// ── Shard type tracking ──────────────────────────────────────────────

/**
 * Shard definitions are tracked as two plain object types mapping
 * shard name → state type. No index signatures — only explicit keys.
 */
export interface ShardDefs {
	readonly singletons: object;
	readonly perResource: object;
}

/** Empty shard definitions — starting point for a new channel */
interface EmptyShardDefs extends ShardDefs {
	// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation via intersection
	readonly singletons: {};
	// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation via intersection
	readonly perResource: {};
}

/** Add a singleton shard to existing defs */
type AddSingleton<D extends ShardDefs, Name extends string, State> = {
	readonly singletons: D["singletons"] & Record<Name, State>;
	readonly perResource: D["perResource"];
};

/** Add a per-resource shard to existing defs */
type AddPerResource<D extends ShardDefs, Name extends string, State> = {
	readonly singletons: D["singletons"];
	readonly perResource: D["perResource"] & Record<Name, State>;
};

// ── Shard accessors in apply/validate/compute ────────────────────────

/** Build the shard accessor object from ShardDefs */
export type ShardAccessors<D extends ShardDefs> = {
	readonly [K in keyof D["singletons"]]: D["singletons"][K];
} & {
	readonly [K in keyof D["perResource"]]: (
		resourceId: string,
	) => D["perResource"][K];
};

// ── Operation types ──────────────────────────────────────────────────

/** Context available in operation handlers */
export interface OperationContext<TActor = { actorId: string }> {
	readonly actor: TActor;
	readonly channelId: string;
}

/** Operation config for optimistic operations (apply required in shared schema) */
interface OptimisticOperationConfig<D extends ShardDefs, TInput> {
	readonly execution: "optimistic";
	readonly versionChecked: boolean;
	readonly deduplicate: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly errors?: StandardSchemaV1;
	readonly scope: (input: TInput, ctx: OperationContext) => readonly ShardRef[];
	readonly apply: (
		shards: ShardAccessors<D>,
		input: TInput,
		serverResult: undefined,
		ctx: OperationContext,
	) => void;
}

/** Operation config for confirmed operations (apply NOT allowed in shared schema) */
interface ConfirmedOperationConfig<TInput> {
	readonly execution: "confirmed";
	readonly versionChecked: boolean;
	readonly deduplicate: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly errors?: StandardSchemaV1;
	readonly scope: (input: TInput, ctx: OperationContext) => readonly ShardRef[];
}

/** Operation config for computed operations (apply NOT allowed in shared schema) */
interface ComputedOperationConfig<TInput> {
	readonly execution: "computed";
	readonly versionChecked: boolean;
	readonly deduplicate: boolean;
	readonly input: StandardSchemaV1<TInput>;
	readonly serverResult?: StandardSchemaV1;
	readonly errors?: StandardSchemaV1;
	readonly scope: (input: TInput, ctx: OperationContext) => readonly ShardRef[];
}

/** Union of all operation configs — execution flag determines which variant */
type OperationConfig<D extends ShardDefs, TInput> =
	| OptimisticOperationConfig<D, TInput>
	| ConfirmedOperationConfig<TInput>
	| ComputedOperationConfig<TInput>;

// ── Channel builder ──────────────────────────────────────────────────

type ChannelKind = "durable" | "ephemeral";

export interface ChannelBuilder<
	Kind extends ChannelKind,
	Name extends string,
	D extends ShardDefs,
> {
	readonly kind: Kind;
	readonly name: Name;

	/** Add a singleton shard (one instance per channel) */
	shard<SName extends string, S extends StandardSchemaV1>(
		name: SName,
		schema: S,
	): ChannelBuilder<Kind, Name, AddSingleton<D, SName, InferSchema<S>>>;

	/** Add a per-resource shard (one instance per resource ID) */
	shardPerResource<SName extends string, S extends StandardSchemaV1>(
		name: SName,
		schema: S,
	): ChannelBuilder<Kind, Name, AddPerResource<D, SName, InferSchema<S>>>;

	/** Define an operation on this channel */
	operation<OName extends string, TInput>(
		name: OName,
		config: OperationConfig<D, TInput>,
	): ChannelBuilder<Kind, Name, D>;
}

// ── Channel constructors ─────────────────────────────────────────────

interface ChannelOptions {
	readonly autoBroadcast?: boolean;
	readonly broadcastMode?: "patch" | "full";
}

function createChannelBuilder<Kind extends ChannelKind, Name extends string>(
	kind: Kind,
	name: Name,
	_options?: ChannelOptions,
): ChannelBuilder<Kind, Name, EmptyShardDefs> {
	const builder: ChannelBuilder<Kind, Name, EmptyShardDefs> = {
		kind,
		name,
		shard(_name, _schema) {
			return builder as never;
		},
		shardPerResource(_name, _schema) {
			return builder as never;
		},
		operation(_name, _config) {
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

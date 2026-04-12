import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type ChannelBuilder,
	type ChannelOptions,
	createChannelBuilder,
} from "./channel";
import {
	type BaseActor,
	createEngineBuilder,
	type EngineBuilder,
} from "./engine";
import type { InferSchema } from "./schema";
import { shard } from "./shard";

// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation via intersection
type EmptyShardDefs = { readonly singletons: {}; readonly perResource: {} };
// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation
type EmptyOps = {};

/** Configuration for defineApp */
export interface DefineAppConfig<TSchema extends StandardSchemaV1> {
	/** Actor schema — defines the shape of actor identity. Must include actorId: string. */
	readonly actor: TSchema;
	/** Static server actor value — must satisfy the actor schema */
	readonly serverActor: InferSchema<TSchema> & BaseActor;
}

/** Typed channel factory — creates channels pre-typed with TActor */
export interface TypedChannelFactory<TActor extends BaseActor> {
	durable<Name extends string>(
		name: Name,
		options?: ChannelOptions,
	): ChannelBuilder<"durable", Name, EmptyShardDefs, EmptyOps, TActor>;
	ephemeral<Name extends string>(
		name: Name,
		options?: ChannelOptions,
	): ChannelBuilder<"ephemeral", Name, EmptyShardDefs, EmptyOps, TActor>;
}

/** Return type of defineApp — pre-typed channel, engine, and shard builders */
export interface AppDefinition<TActor extends BaseActor> {
	/** Channel builder — creates channels with TActor-typed OperationContext */
	readonly channel: TypedChannelFactory<TActor>;
	/** Create an engine builder pre-typed with TActor */
	engine(): EngineBuilder<Record<string, never>, TActor>;
	/** Shard ref helper */
	readonly shard: typeof shard;
}

/**
 * Define a Kio app with a consumer-defined actor type.
 *
 * The actor schema defines the shape of actor identity (who is connecting).
 * The serverActor is a static value used for server-as-actor submissions.
 *
 * Returns pre-typed builders for channels, engine, and shard refs.
 *
 * ```ts
 * const kio = defineApp({
 *   actor: v.object({ actorId: v.string(), name: v.string() }),
 *   serverActor: { actorId: "__kio:server__", name: "System" },
 * });
 *
 * const gameChannel = kio.channel.durable("game").shard(...).operation(...);
 * const appEngine = kio.engine().channel(gameChannel);
 * ```
 */
export function defineApp<TSchema extends StandardSchemaV1>(
	config: DefineAppConfig<TSchema>,
): AppDefinition<InferSchema<TSchema> & BaseActor> {
	type TActor = InferSchema<TSchema> & BaseActor;

	return {
		channel: {
			durable<Name extends string>(name: Name, options?: ChannelOptions) {
				return createChannelBuilder<"durable", Name, TActor>(
					"durable",
					name,
					options,
				);
			},
			ephemeral<Name extends string>(name: Name, options?: ChannelOptions) {
				return createChannelBuilder<"ephemeral", Name, TActor>(
					"ephemeral",
					name,
					options,
				);
			},
		},
		engine(): EngineBuilder<Record<string, never>, TActor> {
			return createEngineBuilder<TActor>(config.actor, config.serverActor);
		},
		shard,
	};
}

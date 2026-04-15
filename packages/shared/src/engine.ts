import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type ChannelBuilder,
	type ChannelData,
	type ChannelOptions,
	createChannelBuilder,
	type ShardDefs,
} from "./channel";
import type { InferSchema } from "./schema";
import { shard } from "./shard";

/** Base actor type — actorId is always required */
export interface BaseActor {
	readonly actorId: string;
}

/**
 * Surfaced as the return type of `.register()` when the engine's actor type
 * cannot satisfy the channel's required actor shape. Chaining another method
 * on this type fails with a visible error message in the type hover.
 */
export type ChannelActorMismatch<ChTActor, TActor> = {
	readonly __KIO_TYPE_ERROR__: "Channel's required actor shape is not satisfied by engine's actor type";
	readonly channelRequires: ChTActor;
	readonly engineHas: TActor;
};

// biome-ignore lint/complexity/noBannedTypes: empty shape starter
type EmptyShardDefs = { readonly singletons: {}; readonly perResource: {} };
// biome-ignore lint/complexity/noBannedTypes: empty shape starter
type EmptyOps = {};

/**
 * Factory object attached to an engine — creates channel builders that
 * are pre-typed with the engine's actor type. `shard` is a straight
 * re-export for convenience so consumers have a single entry point.
 */
export interface ChannelFactory<TActor extends BaseActor> {
	durable<Name extends string>(
		name: Name,
		options?: ChannelOptions,
	): ChannelBuilder<"durable", Name, EmptyShardDefs, EmptyOps, TActor>;
	ephemeral<Name extends string>(
		name: Name,
		options?: ChannelOptions,
	): ChannelBuilder<"ephemeral", Name, EmptyShardDefs, EmptyOps, TActor>;
}

/**
 * Engine builder — the single source of truth for a Kio app.
 *
 * Create channels with `.channel.durable(name)` / `.channel.ephemeral(name)`
 * (pre-typed with the engine's actor), build ref objects with `.shard.ref()`,
 * and add finished channels with `.register(ch)`. `createServer` and
 * `createClient` take the builder and introspect `~channels` / `~actorSchema`
 * / `~serverActor` to set themselves up.
 */
export interface EngineBuilder<
	TChannels extends object = object,
	TActor extends BaseActor = BaseActor,
> {
	readonly "~channels": ReadonlyMap<string, ChannelData>;
	readonly "~actorSchema": StandardSchemaV1 | undefined;
	readonly "~serverActor": TActor | undefined;

	/** Channel builder factory, pre-typed with TActor. */
	readonly channel: ChannelFactory<TActor>;

	/** Shard ref helper — same as the bare `shard` export from `@kio/shared`. */
	readonly shard: typeof shard;

	/**
	 * Register a channel. Contravariant in the channel's actor type: the
	 * engine's actor must be assignable to the channel's actor (i.e., the
	 * engine's actor carries at least the fields the channel's handlers
	 * read). A channel whose handlers only reference `actorId` (default
	 * `BaseActor`) can be added to any engine.
	 */
	register<
		Kind extends "durable" | "ephemeral",
		Name extends string,
		D extends ShardDefs,
		Ops extends object,
		ChTActor extends BaseActor,
	>(
		ch: ChannelBuilder<Kind, Name, D, Ops, ChTActor>,
	): TActor extends ChTActor
		? EngineBuilder<
				TChannels & Record<Name, ChannelBuilder<Kind, Name, D, Ops, ChTActor>>,
				TActor
			>
		: ChannelActorMismatch<ChTActor, TActor>;
}

/** Extract the TChannels type from an EngineBuilder */
export type InferChannels<E> =
	E extends EngineBuilder<infer TChannels, infer _TActor> ? TChannels : never;

/** Extract the TActor type from an EngineBuilder */
export type InferActor<E> =
	E extends EngineBuilder<infer _TChannels, infer TActor> ? TActor : never;

// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation
type EmptyChannels = {};

/** Configuration for {@link engine}. All fields optional. */
export interface EngineOptions<
	TSchema extends StandardSchemaV1 | undefined = undefined,
> {
	/**
	 * Schema for validating actor identity on every connection. When set,
	 * channel handlers see `ctx.actor` typed as the schema's output type.
	 * Leave unset for apps whose actor is just `{ actorId: string }`.
	 */
	readonly actor?: TSchema;
	/**
	 * Static server-as-actor value used for engine-initiated submissions
	 * (timers, afterCommit, built-in grants). Must satisfy `actor`'s schema
	 * when `actor` is set. Defaults to `KIO_SERVER_ACTOR`.
	 */
	readonly serverActor?: TSchema extends StandardSchemaV1
		? InferSchema<TSchema> & BaseActor
		: BaseActor;
}

type ResolveActor<TSchema> = TSchema extends StandardSchemaV1
	? InferSchema<TSchema> & BaseActor
	: BaseActor;

/**
 * Create a new engine builder. All options are optional.
 *
 * ```ts
 * // Bare — actor is just { actorId: string }
 * const app = engine()
 *
 * // With a custom actor shape
 * const app = engine({
 *   actor: v.object({ actorId: v.string(), name: v.string() }),
 *   serverActor: { actorId: "__kio:server__", name: "Server" },
 * })
 *
 * // Build channels using the pre-typed factory
 * const gameChannel = app.channel.durable("game").shard(...).operation(...)
 *
 * // Register them
 * const appEngine = app.register(gameChannel)
 * ```
 */
export function engine(): EngineBuilder<EmptyChannels, BaseActor>;
export function engine<TSchema extends StandardSchemaV1>(
	options: EngineOptions<TSchema> & { actor: TSchema },
): EngineBuilder<EmptyChannels, ResolveActor<TSchema>>;
export function engine(
	options?: EngineOptions<StandardSchemaV1 | undefined>,
): EngineBuilder<EmptyChannels, BaseActor> {
	const channels = new Map<string, ChannelData>();

	const factory: ChannelFactory<BaseActor> = {
		durable(name, chOptions) {
			return createChannelBuilder("durable", name, chOptions);
		},
		ephemeral(name, chOptions) {
			return createChannelBuilder("ephemeral", name, chOptions);
		},
	};

	const builder = {
		"~channels": channels,
		"~actorSchema": options?.actor,
		"~serverActor": options?.serverActor,
		channel: factory,
		shard,
		register(ch: { "~data": ChannelData }) {
			channels.set(ch["~data"].name, ch["~data"]);
			return builder;
		},
	};

	return builder as never;
}

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ChannelBuilder, ChannelData, ShardDefs } from "./channel";

/** Base actor type — actorId is always required */
export interface BaseActor {
	readonly actorId: string;
}

/**
 * Surfaced as the return type of `.channel()` when the engine's actor type
 * cannot satisfy the channel's required actor shape. Chaining another method
 * on this type fails with a visible error message in the type hover.
 */
export type ChannelActorMismatch<ChTActor, TActor> = {
	readonly __KIO_TYPE_ERROR__: "Channel's required actor shape is not satisfied by engine's actor type";
	readonly channelRequires: ChTActor;
	readonly engineHas: TActor;
};

/** Engine builder — accumulates channels, carries actor type */
export interface EngineBuilder<
	TChannels extends object = object,
	TActor extends BaseActor = BaseActor,
> {
	readonly "~channels": ReadonlyMap<string, ChannelData>;
	readonly "~actorSchema": StandardSchemaV1 | undefined;
	readonly "~serverActor": TActor | undefined;

	/**
	 * Add a channel. Contravariant in the channel's actor type: the engine's
	 * actor must be assignable to the channel's actor (i.e., the engine's
	 * actor has at least the fields the channel's handlers read). A channel
	 * whose handlers only reference `actorId` (default `BaseActor`) can be
	 * added to any engine.
	 */
	channel<
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

export function engine(): EngineBuilder<EmptyChannels> {
	return createEngineBuilder(undefined, undefined);
}

export function createEngineBuilder<TActor extends BaseActor>(
	actorSchema: StandardSchemaV1 | undefined,
	serverActor: TActor | undefined,
): EngineBuilder<EmptyChannels, TActor> {
	const channels = new Map<string, ChannelData>();

	const builder = {
		"~channels": channels,
		"~actorSchema": actorSchema,
		"~serverActor": serverActor,
		channel(ch: { "~data": ChannelData }) {
			channels.set(ch["~data"].name, ch["~data"]);
			return builder;
		},
	};

	return builder as never;
}

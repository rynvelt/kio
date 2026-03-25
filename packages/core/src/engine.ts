import type { ChannelBuilder, ShardDefs } from "./channel";

/** Engine builder — accumulates channels */
export interface EngineBuilder<TChannels extends object = object> {
	channel<
		Kind extends "durable" | "ephemeral",
		Name extends string,
		D extends ShardDefs,
		Ops extends object,
	>(
		ch: ChannelBuilder<Kind, Name, D, Ops>,
	): EngineBuilder<
		TChannels & Record<Name, ChannelBuilder<Kind, Name, D, Ops>>
	>;
}

// biome-ignore lint/complexity/noBannedTypes: empty object for type accumulation
type EmptyChannels = {};

export function engine(): EngineBuilder<EmptyChannels> {
	const builder: EngineBuilder<EmptyChannels> = {
		channel(_ch) {
			return builder as never;
		},
	};
	return builder;
}

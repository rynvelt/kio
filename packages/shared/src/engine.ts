import type { ChannelBuilder, ChannelData, ShardDefs } from "./channel";

/** Engine builder — accumulates channels */
export interface EngineBuilder<TChannels extends object = object> {
	readonly "~channels": ReadonlyMap<string, ChannelData>;

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
	const channels = new Map<string, ChannelData>();

	const builder = {
		"~channels": channels,
		channel(ch: { "~data": ChannelData }) {
			channels.set(ch["~data"].name, ch["~data"]);
			return builder;
		},
	};

	return builder as never;
}

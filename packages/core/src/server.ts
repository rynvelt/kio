import type { Subscriber } from "./broadcast";
import { ChannelEngine } from "./channel-engine";
import type { EngineBuilder } from "./engine";
import type { StateAdapter } from "./persistence";
import type { Actor, AuthorizeFn, PipelineResult } from "./pipeline";
import { KIO_SERVER_ACTOR } from "./pipeline";

/** Configuration for createServer */
export interface ServerConfig {
	readonly persistence: StateAdapter;
	readonly authorize?: AuthorizeFn;
	readonly onConnect?: (actor: Actor) => void;
	readonly onDisconnect?: (actor: Actor, reason: string) => void;
}

/** Server instance — consumer-facing API */
export interface Server {
	/** Submit an operation as server-as-actor */
	submit(
		channelName: string,
		operationName: string,
		input: unknown,
	): Promise<PipelineResult>;

	/** Flush dirty shards for a manual-broadcast channel */
	broadcastDirtyShards(channelName: string, shardIds?: readonly string[]): void;

	/** Add a subscriber to a channel's shards */
	addSubscriber(
		channelName: string,
		subscriber: Subscriber,
		shardIds: readonly string[],
	): void;

	/** Remove a subscriber from a channel */
	removeSubscriber(channelName: string, subscriberId: string): void;

	/** Get a channel engine by name (for advanced use) */
	getChannel(channelName: string): ChannelEngine | undefined;
}

/** Create a server from an engine builder and config */
export function createServer(
	engineBuilder: EngineBuilder,
	config: ServerConfig,
): Server {
	const channels = new Map<string, ChannelEngine>();

	for (const [name, channelData] of engineBuilder["~channels"]) {
		channels.set(
			name,
			new ChannelEngine(channelData, config.persistence, {
				authorize: config.authorize,
			}),
		);
	}

	function getChannelOrThrow(channelName: string): ChannelEngine {
		const ch = channels.get(channelName);
		if (!ch) {
			throw new Error(`Channel "${channelName}" is not registered`);
		}
		return ch;
	}

	return {
		async submit(channelName, operationName, input) {
			const ch = getChannelOrThrow(channelName);
			return ch.submit({
				operationName,
				input,
				actor: KIO_SERVER_ACTOR,
			});
		},

		broadcastDirtyShards(channelName, shardIds) {
			const ch = getChannelOrThrow(channelName);
			ch.broadcastDirtyShards(shardIds);
		},

		addSubscriber(channelName, subscriber, shardIds) {
			const ch = getChannelOrThrow(channelName);
			ch.addSubscriber(subscriber, shardIds);
		},

		removeSubscriber(channelName, subscriberId) {
			const ch = getChannelOrThrow(channelName);
			ch.removeSubscriber(subscriberId);
		},

		getChannel(channelName) {
			return channels.get(channelName);
		},
	};
}

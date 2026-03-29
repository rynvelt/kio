import type { Subscriber } from "./broadcast";
import type { ChannelBuilder } from "./channel";
import { ChannelEngine } from "./channel-engine";
import type { EngineBuilder } from "./engine";
import type { StateAdapter } from "./persistence";
import type { Actor, AuthorizeFn, PipelineResult } from "./pipeline";
import { KIO_SERVER_ACTOR } from "./pipeline";
import type { ServerTransport } from "./transport";

/** Configuration for createServer */
export interface ServerConfig {
	readonly persistence: StateAdapter;
	readonly transport?: ServerTransport;
	readonly authorize?: AuthorizeFn;
	readonly onConnect?: (actor: Actor) => void;
	readonly onDisconnect?: (actor: Actor, reason: string) => void;
}

/** Extract operation names from a ChannelBuilder's Ops type */
type OperationNames<Ch> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer _D, infer Ops>
		? string & keyof Ops
		: never;

/** Extract input type for a specific operation on a channel */
type OperationInput<Ch, OpName extends string> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer _D, infer Ops>
		? OpName extends keyof Ops
			? Ops[OpName] extends { _input: infer TInput }
				? TInput
				: never
			: never
		: never;

/** Typed server instance — channel names, operation names, and inputs are enforced */
export interface Server<TChannels extends object = object> {
	/** Submit an operation as server-as-actor */
	submit<
		CName extends string & keyof TChannels,
		OpName extends OperationNames<TChannels[CName]>,
	>(
		channelName: CName,
		operationName: OpName,
		input: OperationInput<TChannels[CName], OpName>,
	): Promise<PipelineResult>;

	/** Flush dirty shards for a manual-broadcast channel */
	broadcastDirtyShards(
		channelName: string & keyof TChannels,
		shardIds?: readonly string[],
	): void;

	/** Add a subscriber to a channel's shards */
	addSubscriber(
		channelName: string & keyof TChannels,
		subscriber: Subscriber,
		shardIds: readonly string[],
	): void;

	/** Remove a subscriber from a channel */
	removeSubscriber(
		channelName: string & keyof TChannels,
		subscriberId: string,
	): void;

	/**
	 * Register a transport connection as a subscriber.
	 * Broadcasts for the subscribed shards are sent via the transport.
	 */
	addTransportSubscriber(
		channelName: string & keyof TChannels,
		connectionId: string,
		shardIds: readonly string[],
	): void;

	/** Remove a transport subscriber */
	removeTransportSubscriber(
		channelName: string & keyof TChannels,
		connectionId: string,
	): void;

	/** Get a channel engine by name */
	getChannel(channelName: string & keyof TChannels): ChannelEngine | undefined;
}

/** Create a server from an engine builder and config */
export function createServer<TChannels extends object>(
	engineBuilder: EngineBuilder<TChannels>,
	config: ServerConfig,
): Server<TChannels> {
	const channels = new Map<string, ChannelEngine>();
	const { transport } = config;

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

	// Wire transport: receive client submissions, route to channel engine
	if (transport) {
		transport.onMessage(async (connectionId, message) => {
			if (message.type === "submit") {
				const ch = channels.get(message.channelId);
				if (!ch) {
					transport.send(connectionId, {
						type: "reject",
						opId: message.opId,
						code: "INVALID_CHANNEL",
						message: `Channel "${message.channelId}" is not registered`,
					});
					return;
				}

				const result = await ch.submit({
					operationName: message.operationName,
					input: message.input,
					actor: { actorId: connectionId },
					opId: message.opId,
				});

				if (result.status === "acknowledged") {
					transport.send(connectionId, {
						type: "acknowledge",
						opId: message.opId,
					});
				} else {
					transport.send(connectionId, {
						type: "reject",
						opId: message.opId,
						code: result.code,
						message: result.message,
					});
				}
			}
		});
	}

	/** Create a Subscriber that sends broadcasts via the transport */
	function createTransportSubscriber(connectionId: string): Subscriber {
		return {
			id: connectionId,
			send(message) {
				transport?.send(connectionId, {
					type: "broadcast",
					channelId: message.channelId,
					kind: message.kind,
					shards: message.shards,
				});
			},
		};
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

		addTransportSubscriber(channelName, connectionId, shardIds) {
			const ch = getChannelOrThrow(channelName);
			ch.addSubscriber(createTransportSubscriber(connectionId), shardIds);
		},

		removeTransportSubscriber(channelName, connectionId) {
			const ch = getChannelOrThrow(channelName);
			ch.removeSubscriber(connectionId);
		},

		getChannel(channelName) {
			return channels.get(channelName);
		},
	} as Server<TChannels>;
}

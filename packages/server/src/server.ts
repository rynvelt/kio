import type {
	BaseActor,
	ChannelBuilder,
	EngineBuilder,
	ServerTransport,
	Subscriber,
} from "@kio/shared";
import { ChannelRuntime } from "./channel-runtime";
import { ConnectionManager } from "./connection-manager";
import type { StateAdapter } from "./persistence";
import type { AuthorizeFn, PipelineResult } from "./pipeline";

/** Subscription entry: which channel and which shards */
export interface SubscriptionRef {
	readonly channelId: string;
	readonly shardIds: readonly string[];
}

/** Configuration for createServer — TActor is inferred from the engine builder */
export interface ServerConfig<TActor extends BaseActor = BaseActor> {
	readonly persistence: StateAdapter;
	readonly transport?: ServerTransport;
	readonly authorize?: AuthorizeFn;
	readonly defaultSubscriptions?: (actor: TActor) => readonly SubscriptionRef[];
	readonly onConnect?: (actor: TActor) => void;
	readonly onDisconnect?: (actor: TActor, reason: string) => void;
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

	/** Register a transport connection as a subscriber */
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
	getChannel(channelName: string & keyof TChannels): ChannelRuntime | undefined;
}

/** Create a server from an engine builder and config */
export function createServer<
	TChannels extends object,
	TActor extends BaseActor = BaseActor,
>(
	engineBuilder: EngineBuilder<TChannels, TActor>,
	config: ServerConfig<TActor>,
): Server<TChannels> {
	const channels = new Map<string, ChannelRuntime>();
	const { transport } = config;
	const serverActor: BaseActor = engineBuilder["~serverActor"] ?? {
		actorId: "__kio:server__",
	};

	for (const [name, channelData] of engineBuilder["~channels"]) {
		channels.set(
			name,
			new ChannelRuntime(channelData, config.persistence, {
				authorize: config.authorize,
				serverActorId: serverActor.actorId,
			}),
		);
	}

	function getChannelOrThrow(channelName: string): ChannelRuntime {
		const ch = channels.get(channelName);
		if (!ch) {
			throw new Error(`Channel "${channelName}" is not registered`);
		}
		return ch;
	}

	// Connection manager handles handshake, actor validation, and subscriber lifecycle
	let connectionManager: ConnectionManager<TActor> | undefined;

	/** Create a Subscriber that sends broadcasts via the transport */
	function createTransportSubscriber(connectionId: string): Subscriber {
		if (connectionManager) {
			return connectionManager.createTransportSubscriber(connectionId);
		}
		// Fallback for when no transport is configured (shouldn't be called)
		return {
			id: connectionId,
			send() {},
		};
	}

	// Wire transport
	if (transport) {
		connectionManager = new ConnectionManager<TActor>({
			transport,
			channels,
			actorSchema: engineBuilder["~actorSchema"],
			defaultSubscriptions: config.defaultSubscriptions,
			onConnect: config.onConnect,
			onDisconnect: config.onDisconnect,
		});

		const cm = connectionManager;

		transport.onConnection(async (connectionId, rawActor) => {
			await cm.handleConnection(connectionId, rawActor);
		});

		transport.onMessage(async (connectionId, message) => {
			if (message.type === "versions") {
				cm.handleClientVersions(connectionId, message.shards);
				return;
			}

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

				const actor = cm.getActor(connectionId);
				if (!actor) {
					transport.send(connectionId, {
						type: "reject",
						opId: message.opId,
						code: "INTERNAL_ERROR",
						message: "Connection has no associated actor",
					});
					return;
				}

				const result = await ch.submit({
					operationName: message.operationName,
					input: message.input,
					actor,
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
						shards: result.shards,
					});
				}
			}
		});

		transport.onDisconnection((connectionId, reason) => {
			cm.handleDisconnection(connectionId, reason);
		});
	}

	let serverOpCounter = 0;

	return {
		async submit(channelName, operationName, input) {
			const ch = getChannelOrThrow(channelName);
			const opId = `server:${String(serverOpCounter++)}`;
			return ch.submit({
				operationName,
				input,
				actor: serverActor,
				opId,
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

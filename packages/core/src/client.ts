import type { ChannelBuilder } from "./channel";
import { ClientChannelEngine } from "./client-channel-engine";
import type { EngineBuilder } from "./engine";
import type { ShardState } from "./state";
import type {
	AcknowledgeMessage,
	ClientTransport,
	RejectMessage,
} from "./transport";

/** Configuration for createClient */
export interface ClientConfig {
	readonly transport: ClientTransport;
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

/** Typed channel handle — consumer uses this to submit and read state */
export interface ClientChannel<Ch> {
	submit<OpName extends OperationNames<Ch>>(
		operationName: OpName,
		input: OperationInput<Ch, OpName>,
	): Promise<AcknowledgeMessage | RejectMessage>;

	shardState(shardId: string): ShardState<Record<string, unknown>>;

	subscribeToShard(shardId: string, listener: () => void): () => void;
}

/** Typed client instance */
export interface Client<TChannels extends object = object> {
	channel<CName extends string & keyof TChannels>(
		channelName: CName,
	): ClientChannel<TChannels[CName]>;

	readonly ready: boolean;
}

/** Create a client from an engine builder and config */
export function createClient<TChannels extends object>(
	engineBuilder: EngineBuilder<TChannels>,
	config: ClientConfig,
): Client<TChannels> {
	const engines = new Map<string, ClientChannelEngine>();
	let isReady = false;

	// Create a ClientChannelEngine per channel
	for (const [name, channelData] of engineBuilder["~channels"]) {
		engines.set(name, new ClientChannelEngine(channelData, config.transport));
	}

	// Wire transport messages to the right engine
	config.transport.onMessage((message) => {
		switch (message.type) {
			case "versions":
				// Server sent its versions — respond with ours
				config.transport.send({
					type: "versions",
					shards: collectLocalVersions(engines),
				});
				break;

			case "state": {
				const eng = engines.get(message.channelId);
				eng?.handleStateMessage(message);
				break;
			}

			case "broadcast": {
				const eng = engines.get(message.channelId);
				eng?.handleBroadcastMessage(message);
				break;
			}

			case "ready":
				isReady = true;
				break;

			case "acknowledge":
			case "reject":
				// Route to the engine that owns the opId
				for (const eng of engines.values()) {
					eng.handleSubmitResponse(message);
				}
				break;
		}
	});

	// When transport connects, the server initiates the handshake
	config.transport.onConnected(() => {
		// Nothing to do — server sends versions first, we respond in onMessage
	});

	return {
		channel(channelName) {
			const eng = engines.get(channelName);
			if (!eng) {
				throw new Error(`Channel "${channelName}" is not registered`);
			}
			return {
				submit(operationName, input) {
					return eng.submit(operationName, input);
				},
				shardState(shardId) {
					return eng.shardState(shardId);
				},
				subscribeToShard(shardId, listener) {
					return eng.subscribeToShard(shardId, listener);
				},
			} as ClientChannel<TChannels[typeof channelName]>;
		},
		get ready() {
			return isReady;
		},
	} as Client<TChannels>;
}

/**
 * Collect local shard versions from all engines.
 *
 * INCOMPLETE: Always returns empty. When reconnect is implemented,
 * this must iterate each engine's ShardStores and return their
 * current versions so the server can diff and skip up-to-date shards.
 * Without this, every reconnect transfers full state for all shards.
 */
function collectLocalVersions(
	_engines: Map<string, ClientChannelEngine>,
): Record<string, number> {
	return {};
}

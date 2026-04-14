import { type Codec, jsonCodec } from "./codec";
import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
	ServerTransport,
} from "./transport";

/**
 * Test helper that wraps a raw bytes `ClientTransport` with a codec so tests
 * can send and receive typed `ClientMessage` / `ServerMessage` values.
 *
 * Usage:
 * ```ts
 * const { client: rawClient } = createDirectTransport();
 * const client = createTypedTestClient(rawClient);
 * client.send({ type: "versions", shards: {} });
 * client.onMessage((msg) => { ... });
 * ```
 */
export function createTypedTestClient(
	client: ClientTransport,
	codec: Codec = jsonCodec,
): {
	send(message: ClientMessage): void;
	onMessage(handler: (message: ServerMessage) => void): void;
	onConnected(handler: () => void): void;
	onDisconnected(handler: (reason: string) => void): void;
} {
	return {
		send(message) {
			client.send(codec.encode(message));
		},
		onMessage(handler) {
			client.onMessage((raw) => {
				handler(codec.decode(raw) as ServerMessage);
			});
		},
		onConnected(handler) {
			client.onConnected(handler);
		},
		onDisconnected(handler) {
			client.onDisconnected(handler);
		},
	};
}

/**
 * Symmetric counterpart to `createTypedTestClient` — wraps a raw
 * `ServerTransport` so tests can push typed `ServerMessage` values to the
 * client side and observe incoming `ClientMessage` values.
 */
export function createTypedTestServer(
	server: ServerTransport,
	codec: Codec = jsonCodec,
): {
	send(connectionId: string, message: ServerMessage): void;
	close(connectionId: string): void;
	onMessage(
		handler: (connectionId: string, message: ClientMessage) => void,
	): void;
	onConnection(handler: (connectionId: string, actor: unknown) => void): void;
	onDisconnection(
		handler: (connectionId: string, reason: string) => void,
	): void;
} {
	return {
		send(connectionId, message) {
			server.send(connectionId, codec.encode(message));
		},
		close(connectionId) {
			server.close(connectionId);
		},
		onMessage(handler) {
			server.onMessage((id, raw) => {
				handler(id, codec.decode(raw) as ClientMessage);
			});
		},
		onConnection(handler) {
			server.onConnection(handler);
		},
		onDisconnection(handler) {
			server.onDisconnection(handler);
		},
	};
}

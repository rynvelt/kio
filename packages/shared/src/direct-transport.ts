import type { ClientTransport, ServerTransport } from "./transport";

const CONNECTION_ID = "direct";
const DEFAULT_ACTOR = { actorId: "direct" };

/**
 * In-process transport for testing.
 * Connects a client and server directly — no serialization, no network.
 * Call connect(actor) to initiate the connection handshake.
 * Call disconnect() to simulate a connection drop.
 *
 * Implements the raw bytes transport contract. Tests that want to work
 * with typed ClientMessage/ServerMessage values can wrap `client` with
 * `createTypedTestClient(rawClient, jsonCodec)`.
 */
export function createDirectTransport(): {
	client: ClientTransport;
	server: ServerTransport;
	/** Initiate the connection — fires onConnection on server, onConnected on client */
	connect: (actor?: unknown) => void;
	/** Simulate a disconnect — fires onDisconnection on server, onDisconnected on client */
	disconnect: (reason?: string) => void;
	connectionId: string;
} {
	let clientMessageHandler: ((data: string | Uint8Array) => void) | null = null;
	let clientConnectedHandler: (() => void) | null = null;
	let clientDisconnectedHandler: ((reason: string) => void) | null = null;
	let serverMessageHandler:
		| ((connectionId: string, data: string | Uint8Array) => void)
		| null = null;
	let serverConnectionHandler:
		| ((connectionId: string, actor: unknown) => void)
		| null = null;
	let serverDisconnectionHandler:
		| ((connectionId: string, reason: string) => void)
		| null = null;

	const client: ClientTransport = {
		send(data) {
			if (!serverMessageHandler)
				throw new Error(
					"DirectTransport: server message handler not registered",
				);
			serverMessageHandler(CONNECTION_ID, data);
		},
		onMessage(handler) {
			clientMessageHandler = handler;
		},
		onConnected(handler) {
			clientConnectedHandler = handler;
		},
		onDisconnected(handler) {
			clientDisconnectedHandler = handler;
		},
	};

	const server: ServerTransport = {
		send(_connectionId, data) {
			if (!clientMessageHandler)
				throw new Error(
					"DirectTransport: client message handler not registered",
				);
			clientMessageHandler(data);
		},
		close(_connectionId) {
			clientDisconnectedHandler?.("closed by server");
		},
		onMessage(handler) {
			serverMessageHandler = handler;
		},
		onConnection(handler) {
			serverConnectionHandler = handler;
		},
		onDisconnection(handler) {
			serverDisconnectionHandler = handler;
		},
	};

	function connect(actor: unknown = DEFAULT_ACTOR) {
		serverConnectionHandler?.(CONNECTION_ID, actor);
		clientConnectedHandler?.();
	}

	function disconnect(reason = "test disconnect") {
		serverDisconnectionHandler?.(CONNECTION_ID, reason);
		clientDisconnectedHandler?.(reason);
	}

	return { client, server, connect, disconnect, connectionId: CONNECTION_ID };
}

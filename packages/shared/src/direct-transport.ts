import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
	ServerTransport,
} from "./transport";

const CONNECTION_ID = "direct";

/**
 * In-process transport for testing.
 * Connects a client and server directly — no serialization, no network.
 * Call connect() to initiate the connection handshake.
 */
export function createDirectTransport(): {
	client: ClientTransport;
	server: ServerTransport;
	/** Initiate the connection — fires onConnection on server, onConnected on client */
	connect: () => void;
	connectionId: string;
} {
	let clientMessageHandler: ((message: ServerMessage) => void) | null = null;
	let clientConnectedHandler: (() => void) | null = null;
	let serverMessageHandler:
		| ((connectionId: string, message: ClientMessage) => void)
		| null = null;
	let serverConnectionHandler: ((connectionId: string) => void) | null = null;

	const client: ClientTransport = {
		send(message) {
			if (!serverMessageHandler)
				throw new Error(
					"DirectTransport: server message handler not registered",
				);
			serverMessageHandler(CONNECTION_ID, message);
		},
		onMessage(handler) {
			clientMessageHandler = handler;
		},
		onConnected(handler) {
			clientConnectedHandler = handler;
		},
		onDisconnected() {
			// Not implemented for direct transport
		},
	};

	const server: ServerTransport = {
		send(_connectionId, message) {
			if (!clientMessageHandler)
				throw new Error(
					"DirectTransport: client message handler not registered",
				);
			clientMessageHandler(message);
		},
		onMessage(handler) {
			serverMessageHandler = handler;
		},
		onConnection(handler) {
			serverConnectionHandler = handler;
		},
		onDisconnection() {
			// Not implemented for direct transport
		},
	};

	function connect() {
		serverConnectionHandler?.(CONNECTION_ID);
		clientConnectedHandler?.();
	}

	return { client, server, connect, connectionId: CONNECTION_ID };
}

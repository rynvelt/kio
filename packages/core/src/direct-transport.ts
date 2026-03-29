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
 * send() on one side calls onMessage() on the other synchronously.
 */
export function createDirectTransport(): {
	client: ClientTransport;
	server: ServerTransport;
	connectionId: string;
} {
	let clientHandler: ((message: ServerMessage) => void) | null = null;
	let serverHandler:
		| ((connectionId: string, message: ClientMessage) => void)
		| null = null;

	const client: ClientTransport = {
		send(message) {
			if (!serverHandler)
				throw new Error("DirectTransport: server handler not registered");
			serverHandler(CONNECTION_ID, message);
		},
		onMessage(handler) {
			clientHandler = handler;
		},
	};

	const server: ServerTransport = {
		send(_connectionId, message) {
			if (!clientHandler)
				throw new Error("DirectTransport: client handler not registered");
			clientHandler(message);
		},
		onMessage(handler) {
			serverHandler = handler;
		},
	};

	return { client, server, connectionId: CONNECTION_ID };
}

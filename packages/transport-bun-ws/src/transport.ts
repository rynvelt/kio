import type {
	ClientMessage,
	ServerMessage,
	ServerTransport,
} from "@kio/shared";

/** Data attached to each WebSocket connection */
export type KioWsData = { connectionId: string };

/**
 * Bun WebSocket server transport for Kio.
 *
 * Returns a ServerTransport and a websocket handler object.
 * The consumer plugs the websocket handlers into their own Bun.serve()
 * and calls upgrade() in their fetch handler.
 *
 * Usage:
 * ```ts
 * const { transport, websocket, upgrade } = createBunWsTransport();
 *
 * const server = createServer(engine, { transport, ... });
 *
 * Bun.serve({
 *   port: 4000,
 *   fetch(req, server) {
 *     if (upgrade(req, server)) return;
 *     return new Response("My App");
 *   },
 *   websocket,
 * });
 * ```
 */
export function createBunWsTransport(): {
	transport: ServerTransport;
	/** Bun WebSocket handler object — pass to Bun.serve({ websocket }) */
	websocket: {
		open: (ws: { data: KioWsData; send: (data: string) => void }) => void;
		message: (
			ws: { data: KioWsData },
			message: string | ArrayBuffer | Uint8Array,
		) => void;
		close: (ws: { data: KioWsData }, code: number, reason: string) => void;
	};
	/** Upgrade a request to a WebSocket connection. Returns true if upgraded. */
	upgrade: (
		req: Request,
		server: {
			upgrade: (req: Request, options: { data: KioWsData }) => boolean;
		},
	) => boolean;
} {
	let messageHandler:
		| ((connectionId: string, message: ClientMessage) => void)
		| null = null;
	let connectionHandler: ((connectionId: string) => void) | null = null;
	let disconnectionHandler:
		| ((connectionId: string, reason: string) => void)
		| null = null;

	const sockets = new Map<string, { send: (data: string) => void }>();
	let connectionCounter = 0;

	const transport: ServerTransport = {
		send(connectionId: string, message: ServerMessage) {
			sockets.get(connectionId)?.send(JSON.stringify(message));
		},
		onMessage(handler) {
			messageHandler = handler;
		},
		onConnection(handler) {
			connectionHandler = handler;
		},
		onDisconnection(handler) {
			disconnectionHandler = handler;
		},
	};

	const websocket = {
		open(ws: { data: KioWsData; send: (data: string) => void }) {
			sockets.set(ws.data.connectionId, ws);
			connectionHandler?.(ws.data.connectionId);
		},
		message(
			ws: { data: KioWsData },
			message: string | ArrayBuffer | Uint8Array,
		) {
			const parsed = JSON.parse(String(message)) as ClientMessage;
			messageHandler?.(ws.data.connectionId, parsed);
		},
		close(ws: { data: KioWsData }, _code: number, reason: string) {
			sockets.delete(ws.data.connectionId);
			disconnectionHandler?.(ws.data.connectionId, reason);
		},
	};

	function upgrade(
		req: Request,
		server: {
			upgrade: (req: Request, options: { data: KioWsData }) => boolean;
		},
	): boolean {
		const connectionId = `ws:${String(connectionCounter++)}`;
		return server.upgrade(req, { data: { connectionId } });
	}

	return { transport, websocket, upgrade };
}

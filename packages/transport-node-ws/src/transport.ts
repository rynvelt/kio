import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerTransport } from "@kiojs/shared";
import type { WebSocket as WsWebSocket } from "ws";
import { WebSocketServer } from "ws";

/**
 * Node.js WebSocket server transport for Kio (built on the `ws` library).
 *
 * Runs in `noServer: true` mode so the consumer owns the HTTP server's
 * `upgrade` event listener. That leaves authentication in consumer code —
 * derive an actor from the request, then hand the upgrade to us.
 *
 * The transport moves raw bytes; the server engine owns the codec. Incoming
 * binary frames are delivered as `Uint8Array`; text frames as `string`.
 *
 * Usage:
 * ```ts
 * import { serve } from "@hono/node-server";
 * import { Hono } from "hono";
 * import { createServer, MemoryStateAdapter } from "@kiojs/server";
 * import { createNodeWsTransport } from "@kiojs/transport-node-ws";
 *
 * const { transport, handleUpgrade } = createNodeWsTransport();
 * const server = createServer(engine, { transport, persistence: new MemoryStateAdapter() });
 *
 * const app = new Hono();
 * app.get("/", (c) => c.text("Kio server"));
 *
 * const httpServer = serve({ fetch: app.fetch, port: 4000 });
 * httpServer.on("upgrade", (req, socket, head) => {
 *   const actor = authenticate(req); // consumer's auth logic
 *   if (!actor) {
 *     socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
 *     socket.destroy();
 *     return;
 *   }
 *   handleUpgrade(req, socket, head, actor);
 * });
 * ```
 */
export function createNodeWsTransport(): {
	transport: ServerTransport;
	/**
	 * Upgrade an already-authenticated request to a WebSocket connection.
	 * Call from your `http.Server`'s `upgrade` listener after auth succeeds.
	 */
	handleUpgrade: (
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		actor: unknown,
	) => void;
	/** Close all live sockets and the underlying WebSocketServer. */
	close: () => void;
} {
	const wss = new WebSocketServer({ noServer: true });

	let messageHandler:
		| ((connectionId: string, data: string | Uint8Array) => void)
		| null = null;
	let connectionHandler:
		| ((connectionId: string, actor: unknown) => void)
		| null = null;
	let disconnectionHandler:
		| ((connectionId: string, reason: string) => void)
		| null = null;

	const sockets = new Map<string, WsWebSocket>();
	let connectionCounter = 0;

	wss.on(
		"connection",
		(ws: WsWebSocket, _request: IncomingMessage, actor: unknown) => {
			const connectionId = `ws:${String(connectionCounter++)}`;
			sockets.set(connectionId, ws);

			ws.on(
				"message",
				(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
					const payload: string | Uint8Array = isBinary
						? toUint8Array(data)
						: toUtf8String(data);
					messageHandler?.(connectionId, payload);
				},
			);

			ws.on("close", (code: number, reason: Buffer) => {
				sockets.delete(connectionId);
				const reasonStr = reason.toString("utf8");
				disconnectionHandler?.(
					connectionId,
					reasonStr || `close:${String(code)}`,
				);
			});

			// ws emits 'error' on the socket; an unhandled emit would crash the process.
			ws.on("error", () => {});

			connectionHandler?.(connectionId, actor);
		},
	);

	const transport: ServerTransport = {
		send(connectionId, data) {
			sockets.get(connectionId)?.send(data);
		},
		close(connectionId) {
			const ws = sockets.get(connectionId);
			if (ws) {
				ws.close();
				sockets.delete(connectionId);
			}
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

	function handleUpgrade(
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		actor: unknown,
	): void {
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request, actor);
		});
	}

	function close(): void {
		for (const ws of sockets.values()) ws.close();
		sockets.clear();
		wss.close();
	}

	return { transport, handleUpgrade, close };
}

function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
	if (Array.isArray(data)) {
		const total = data.reduce((n, b) => n + b.length, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const b of data) {
			out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), offset);
			offset += b.length;
		}
		return out;
	}
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toUtf8String(data: Buffer | ArrayBuffer | Buffer[]): string {
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	return data.toString("utf8");
}

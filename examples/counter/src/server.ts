import { createServer, MemoryStateAdapter } from "@kio/server";
import type {
	ClientMessage,
	ServerMessage,
	ServerTransport,
} from "@kio/shared";
import { appEngine } from "./schema";

// ── Bun WebSocket transport (inline, not yet a package) ─────────────

type WsData = { connectionId: string };

function createBunWsTransport(port: number): {
	transport: ServerTransport;
	start: () => void;
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
			const ws = sockets.get(connectionId);
			ws?.send(JSON.stringify(message));
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

	function start() {
		Bun.serve({
			port,
			fetch(req, server) {
				if (
					server.upgrade<WsData>(req, {
						data: { connectionId: `ws:${String(connectionCounter++)}` },
					})
				) {
					return;
				}
				return new Response("Kio Counter Server", { status: 200 });
			},
			websocket: {
				open(ws) {
					sockets.set(ws.data.connectionId, ws);
					connectionHandler?.(ws.data.connectionId);
				},
				message(ws, message) {
					const parsed = JSON.parse(String(message)) as ClientMessage;
					messageHandler?.(ws.data.connectionId, parsed);
				},
				close(ws, _code, reason) {
					sockets.delete(ws.data.connectionId);
					disconnectionHandler?.(ws.data.connectionId, reason);
				},
			},
		});
		console.log(`Kio counter server running on ws://localhost:${String(port)}`);
	}

	return { transport, start };
}

// ── Boot ────────────────────────────────────────────────────────────

async function main() {
	const adapter = new MemoryStateAdapter();
	await adapter.compareAndSwap("counter", "count", 0, { value: 0 });
	// Seed presence with empty connected list
	await adapter.set("presence", "users", { connected: [] });

	const { transport, start } = createBunWsTransport(4000);

	const server = createServer(appEngine, {
		persistence: adapter,
		transport,
		defaultSubscriptions: () => [
			{ channelId: "counter", shardIds: ["count"] },
			{ channelId: "presence", shardIds: ["users"] },
		],
		onConnect(actor) {
			server.submit("presence", "join", { id: actor.actorId });
		},
		async onDisconnect(actor) {
			await server.submit("presence", "leave", { id: actor.actorId });
			server.broadcastDirtyShards("presence");
		},
	});

	// Flush presence broadcasts every second
	setInterval(() => {
		server.broadcastDirtyShards("presence");
	}, 1000);

	start();
}

main();

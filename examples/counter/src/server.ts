import { createServer, MemoryStateAdapter } from "@kio/server";
import { createBunWsTransport } from "@kio/transport-bun-ws";
import { appEngine } from "./schema";

async function main() {
	const adapter = new MemoryStateAdapter();
	await adapter.compareAndSwap("counter", "count", 0, { value: 0 });
	await adapter.set("presence", "users", { connected: [] });

	const { transport, websocket, upgrade } = createBunWsTransport();

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

	setInterval(() => {
		server.broadcastDirtyShards("presence");
	}, 1000);

	let playerCounter = 0;

	Bun.serve({
		port: 4000,
		fetch(req, srv) {
			const actorId = `player:${String(playerCounter++)}`;
			if (upgrade(req, srv, { actorId })) return;
			return new Response("Kio Counter Server");
		},
		websocket,
	});

	console.log("Kio counter server running on ws://localhost:4000");
}

main();

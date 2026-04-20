import { serve } from "@hono/node-server";
import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createNodeWsTransport } from "@kiojs/transport-node-ws";
import { Hono } from "hono";
import { appEngine } from "./schema.ts";

const { transport, handleUpgrade } = createNodeWsTransport();

const kio = createServer(appEngine, {
	persistence: new MemoryStateAdapter(),
	transport,
	defaultSubscriptions: () => [
		{ channelId: "counter", shardId: "count" },
		{ channelId: "presence", shardId: "users" },
	],
	onConnect(actor) {
		kio.submit("presence", "join", { id: actor.actorId });
	},
	async onDisconnect(actor) {
		await kio.submit("presence", "leave", { id: actor.actorId });
		kio.broadcastDirtyShards("presence");
	},
});

setInterval(() => {
	kio.broadcastDirtyShards("presence");
}, 1000);

const app = new Hono();

app.get("/", (c) => c.text("Kio + Hono + Node counter server"));
app.get("/health", (c) => c.json({ status: "ok" }));

let playerCounter = 0;

const httpServer = serve({ fetch: app.fetch, port: 4000 });

httpServer.on("upgrade", (req, socket, head) => {
	const actorId = `player:${String(playerCounter++)}`;
	handleUpgrade(req, socket, head, { actorId });
});

console.log("Kio+Hono server listening on http://localhost:4000");

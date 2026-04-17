import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createBunWsTransport } from "@kiojs/transport-bun-ws";
import { appEngine } from "./schema";

async function main() {
	const adapter = new MemoryStateAdapter();
	const { transport, websocket, upgrade } = createBunWsTransport();

	createServer(appEngine, {
		persistence: adapter,
		transport,
		defaultSubscriptions(actor) {
			if (!actor.sessionCode) return [];
			return [{ channelId: "poll", shardId: `session:${actor.sessionCode}` }];
		},
	});

	Bun.serve({
		port: 4003,
		fetch(req, srv) {
			const url = new URL(req.url);
			const actorId = url.searchParams.get("actorId");
			const name = url.searchParams.get("name");
			const sessionCode = url.searchParams.get("sessionCode");
			if (actorId && name) {
				if (upgrade(req, srv, { actorId, name, sessionCode })) return;
			}
			return new Response("Kio Poll Server", { status: 200 });
		},
		websocket,
	});

	console.log("Kio poll server running on ws://localhost:4003");
}

main();

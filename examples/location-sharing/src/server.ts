import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createBunWsTransport } from "@kiojs/transport-bun-ws";
import { appEngine } from "./schema";

async function main() {
	const adapter = new MemoryStateAdapter();
	const { transport, websocket, upgrade } = createBunWsTransport();

	const server = createServer(appEngine, {
		persistence: adapter,
		transport,
		defaultSubscriptions(actor) {
			return [
				{ channelId: "room", shardId: "room" },
				{ channelId: "presence", shardId: `player:${actor.actorId}` },
				{ channelId: "sharing", shardId: `actor:${actor.actorId}` },
			];
		},
		async onConnect(actor) {
			await server.submit("room", "join", {
				actorId: actor.actorId,
				name: actor.name,
			});
			await server.submit("presence", "initPresence", {
				actorId: actor.actorId,
				name: actor.name,
			});
		},
		async onDisconnect(actor) {
			await server.submit("room", "leave", {
				actorId: actor.actorId,
			});
		},
	});

	// When a user shares their location with someone, grant the target
	// access to the sharer's presence shard.
	server.afterCommit("sharing", "startShare", async ({ input, actor }) => {
		await server.grantSubscription(input.targetActorId, {
			channelId: "presence",
			shardId: `player:${actor.actorId}`,
		});
	});

	// When a user stops sharing, revoke.
	server.afterCommit("sharing", "stopShare", async ({ input, actor }) => {
		await server.revokeSubscription(input.targetActorId, {
			channelId: "presence",
			shardId: `player:${actor.actorId}`,
		});
	});

	Bun.serve({
		port: 4002,
		fetch(req, srv) {
			const url = new URL(req.url);
			const name = url.searchParams.get("name");
			const actorId = name ? name.toLowerCase().replace(/\s+/g, "-") : null;
			if (actorId && name) {
				if (upgrade(req, srv, { actorId, name })) return;
			}
			return new Response("Kio Location Sharing Server", { status: 200 });
		},
		websocket,
	});

	console.log("Location sharing server running on ws://localhost:4002");
}

main();

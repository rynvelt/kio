import { createServer, MemoryStateAdapter } from "@kio/server";
import { createBunWsTransport } from "@kio/transport-bun-ws";
import type { RoomState } from "./schema";
import { appEngine } from "./schema";

const COUNTDOWN_SECONDS = 3;

async function main() {
	const adapter = new MemoryStateAdapter();

	// Seed lobby room
	await adapter.compareAndSwap("lobby", "room", 0, {
		phase: "waiting",
		countdownEndsAt: null,
		players: [],
	} satisfies RoomState);

	const { transport, websocket, upgrade } = createBunWsTransport();

	let countdownTimer: ReturnType<typeof setTimeout> | null = null;

	const server = createServer(appEngine, {
		persistence: adapter,
		transport,
		defaultSubscriptions: () => [{ channelId: "lobby", shardId: "room" }],
		async onConnect(actor) {
			await server.submit("lobby", "join", {
				actorId: actor.actorId,
				name: actor.name,
			});
		},
		async onDisconnect(actor) {
			await server.submit("lobby", "leave", {
				actorId: actor.actorId,
			});
		},
	});

	async function getRoom(): Promise<RoomState | undefined> {
		const shard = await adapter.load("lobby", "room");
		return shard?.state as RoomState | undefined;
	}

	// React to setReady — check if all players are ready for countdown
	server.afterCommit("lobby", "setReady", async ({ newState, submit }) => {
		const room = newState.room as RoomState;

		const readyCount = room.players.filter((p) => p.ready).length;
		const allReady = readyCount === room.players.length && readyCount >= 2;

		if (room.phase === "waiting" && allReady) {
			const endsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
			await submit("lobby", "setPhase", {
				phase: "countdown",
				countdownEndsAt: endsAt,
			});

			if (countdownTimer) clearTimeout(countdownTimer);
			countdownTimer = setTimeout(async () => {
				const current = await getRoom();
				if (current?.phase === "countdown") {
					await server.submit("lobby", "setPhase", {
						phase: "started",
						countdownEndsAt: null,
					});
				}
			}, COUNTDOWN_SECONDS * 1000);
		} else if (room.phase === "countdown" && !allReady) {
			if (countdownTimer) {
				clearTimeout(countdownTimer);
				countdownTimer = null;
			}
			await submit("lobby", "setPhase", {
				phase: "waiting",
				countdownEndsAt: null,
			});
		}
	});

	// React to leave — cancel countdown timer if active
	server.afterCommit("lobby", "leave", ({ newState }) => {
		const room = newState.room as RoomState;
		if (room.phase !== "countdown" && countdownTimer) {
			clearTimeout(countdownTimer);
			countdownTimer = null;
		}
	});

	Bun.serve({
		port: 4001,
		fetch(req, srv) {
			const url = new URL(req.url);
			const actorId = url.searchParams.get("actorId");
			const name = url.searchParams.get("name");

			if (actorId && name) {
				if (upgrade(req, srv, { actorId, name })) return;
			}

			return new Response("Kio Lobby Server", { status: 200 });
		},
		websocket,
	});

	console.log("Kio lobby server running on ws://localhost:4001");
}

main();

import { type Client, createClient } from "@kiojs/client";
import { createWsTransport } from "@kiojs/transport-ws";
import { appEngine } from "./schema";

/**
 * Get or create a stable player ID from localStorage.
 */
function getPlayerId(): string {
	const key = "kio-lobby-player-id";
	let id = localStorage.getItem(key);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(key, id);
	}
	return id;
}

/**
 * Connect to the lobby server with the given player name.
 * Uses a stable actorId from localStorage so refreshes don't create new players.
 */
export function connectToLobby(name: string): {
	client: Client;
	actorId: string;
} {
	const actorId = getPlayerId();

	const transport = createWsTransport({
		connect: () =>
			new WebSocket(
				`ws://localhost:4001?actorId=${encodeURIComponent(actorId)}&name=${encodeURIComponent(name)}`,
			),
	});

	const client = createClient(appEngine, { transport });

	return { client, actorId };
}

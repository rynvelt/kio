import { type Client, createClient } from "@kio/client";
import { createWsTransport } from "@kio/transport-ws";
import { getActorId } from "./identity";
import { appEngine } from "./schema";

export function connect(options: {
	name: string;
	sessionCode: string | null;
}): { client: Client; actorId: string } {
	const actorId = getActorId();
	const params = new URLSearchParams({
		actorId,
		name: options.name,
	});
	if (options.sessionCode) params.set("sessionCode", options.sessionCode);

	const transport = createWsTransport({
		connect: () => new WebSocket(`ws://localhost:4003?${params.toString()}`),
	});

	const client = createClient(appEngine, { transport });
	return { client, actorId };
}

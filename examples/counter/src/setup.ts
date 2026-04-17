import { createClient } from "@kiojs/client";
import { createWsTransport } from "@kiojs/transport-ws";
import { appEngine } from "./schema";

export function setupApp() {
	const transport = createWsTransport({
		connect: () => new WebSocket("ws://localhost:4000"),
	});

	const client = createClient(appEngine, { transport });

	return { client };
}

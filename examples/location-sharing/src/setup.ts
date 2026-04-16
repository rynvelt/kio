import { createClient } from "@kio/client";
import { createWsTransport } from "@kio/transport-ws";
import { appEngine } from "./schema";

export function setupApp(name: string) {
	const transport = createWsTransport({
		connect: () =>
			new WebSocket(`ws://localhost:4002?name=${encodeURIComponent(name)}`),
	});

	const client = createClient(appEngine, { transport });

	return { client };
}

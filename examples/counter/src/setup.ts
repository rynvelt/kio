import { createClient } from "@kio/client";
import { appEngine } from "./schema";
import { createWsClientTransport } from "./ws-client-transport";

export function setupApp() {
	const transport = createWsClientTransport("ws://localhost:4000");

	const client = createClient(appEngine, { transport });

	return { client };
}

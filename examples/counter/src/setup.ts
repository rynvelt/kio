import { createClient } from "@kio/client";
import { createServer, MemoryStateAdapter } from "@kio/server";
import { createDirectTransport } from "@kio/shared";
import { appEngine } from "./schema";

export async function setupApp() {
	const adapter = new MemoryStateAdapter();

	// Seed initial counter state
	await adapter.compareAndSwap("counter", "count", 0, { value: 0 });

	const {
		client: clientTransport,
		server: serverTransport,
		connect,
	} = createDirectTransport();

	const server = createServer(appEngine, {
		persistence: adapter,
		transport: serverTransport,
		defaultSubscriptions: () => [{ channelId: "counter", shardIds: ["count"] }],
	});

	const client = createClient(appEngine, {
		transport: clientTransport,
	});

	// Complete handshake
	connect();
	// Wait for async handshake to complete
	await new Promise((r) => setTimeout(r, 10));

	return { server, client };
}

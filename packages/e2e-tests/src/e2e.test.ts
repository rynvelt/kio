import { describe, expect, test } from "bun:test";
import { createClient } from "@kio/client";
import { createServer, MemoryStateAdapter } from "@kio/server";
import { channel, engine, shard } from "@kio/shared";
import { createDirectTransport } from "@kio/shared/test";
import * as v from "valibot";

const gameChannel = channel
	.durable("game")
	.shard("world", v.object({ stage: v.string(), turn: v.number() }))
	.shardPerResource(
		"seat",
		v.object({
			items: v.array(v.object({ id: v.string(), name: v.string() })),
		}),
	)
	.operation("advanceTurn", {
		execution: "optimistic",
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply(shards) {
			shards.world.turn += 1;
		},
	})
	.operation("addItem", {
		execution: "optimistic",
		input: v.object({ seatId: v.string(), item: v.string() }),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			shards.seat(input.seatId).items.push({
				id: input.item,
				name: input.item,
			});
		},
	})
	.operation("setStage", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ stage: v.string() }),
		scope: () => [shard.ref("world")],
		apply(shards, input) {
			shards.world.stage = input.stage;
		},
	});

const presenceChannel = channel
	.ephemeral("presence", { autoBroadcast: false })
	.shardPerResource("player", v.object({ online: v.boolean() }))
	.operation("setOnline", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ playerId: v.string() }),
		scope: (input) => [shard.ref("player", input.playerId)],
		apply(shards, input) {
			(shards.player(input.playerId) as { online: boolean }).online = true;
		},
	});

const serverEngine = engine().register(gameChannel).register(presenceChannel);
const clientEngine = engine().register(gameChannel).register(presenceChannel);

async function setupE2E() {
	const adapter = new MemoryStateAdapter();
	await adapter.compareAndSwap("game", "world", 0, {
		stage: "PLAYING",
		turn: 0,
	});
	await adapter.compareAndSwap("game", "seat:1", 0, {
		items: [{ id: "sword", name: "Sword" }],
	});
	await adapter.set("presence", "player:alice", { online: false });

	const {
		client: clientTransport,
		server: serverTransport,
		connect,
	} = createDirectTransport();

	const server = createServer(serverEngine, {
		persistence: adapter,
		transport: serverTransport,
		defaultSubscriptions: () => [
			{ channelId: "game", shardIds: ["world", "seat:1"] },
			{ channelId: "presence", shardIds: ["player:alice"] },
		],
	});

	const client = createClient(clientEngine, {
		transport: clientTransport,
	});

	// Complete handshake
	connect();
	// Server handleConnection is async — wait for it
	await new Promise((r) => setTimeout(r, 10));
	// Client received server versions and auto-responded
	// Server received client versions and sent state + ready

	return { server, client, adapter };
}

describe("End-to-end", () => {
	test("handshake delivers initial state to client", async () => {
		const { client } = await setupE2E();

		expect(client.ready).toBe(true);

		const worldSnap = client.channel("game").shardState("world");
		expect(worldSnap.syncStatus).toBe("latest");
		expect(worldSnap.state).toEqual({ stage: "PLAYING", turn: 0 });

		const seatSnap = client.channel("game").shardState("seat:1");
		expect(seatSnap.syncStatus).toBe("latest");
		expect(seatSnap.state).toEqual({
			items: [{ id: "sword", name: "Sword" }],
		});
	});

	test("server-as-actor submit updates client ShardStore", async () => {
		const { server, client } = await setupE2E();

		await server.submit("game", "advanceTurn", {});

		const snap = client.channel("game").shardState("world");
		expect(snap.state).toEqual({ stage: "PLAYING", turn: 1 });
	});

	test("multiple server submits accumulate on client", async () => {
		const { server, client } = await setupE2E();

		await server.submit("game", "advanceTurn", {});
		await server.submit("game", "advanceTurn", {});
		await server.submit("game", "advanceTurn", {});

		const snap = client.channel("game").shardState("world");
		expect(snap.state).toEqual({ stage: "PLAYING", turn: 3 });
	});

	test("client submit goes through server and updates client", async () => {
		const { client } = await setupE2E();

		const result = await client.channel("game").submit("advanceTurn", {});

		expect(result.status).toBe("acknowledged");

		const snap = client.channel("game").shardState("world");
		expect(snap.state).toEqual({ stage: "PLAYING", turn: 1 });
	});

	test("client submit on per-resource shard", async () => {
		const { client } = await setupE2E();

		const result = await client
			.channel("game")
			.submit("addItem", { seatId: "1", item: "shield" });

		expect(result.status).toBe("acknowledged");

		const snap = client.channel("game").shardState("seat:1");
		expect(snap.state).toEqual({
			items: [
				{ id: "sword", name: "Sword" },
				{ id: "shield", name: "shield" },
			],
		});
	});

	test("ephemeral channel with manual broadcast", async () => {
		const { server, client } = await setupE2E();

		await server.submit("presence", "setOnline", {
			playerId: "alice",
		});

		// autoBroadcast: false — client hasn't received update yet
		const before = client.channel("presence").shardState("player:alice");
		expect(before.state).toEqual({ online: false });

		// Manual flush
		server.broadcastDirtyShards("presence");

		const after = client.channel("presence").shardState("player:alice");
		expect(after.state).toEqual({ online: true });
	});

	test("server-as-actor unconditional write updates client", async () => {
		const { server, client, adapter } = await setupE2E();

		// First, advance turn so version > 1
		await server.submit("game", "advanceTurn", {});
		const versionBefore = (await adapter.load("game", "world"))?.version;

		// Server submits with versionChecked: false — always succeeds
		const result = await server.submit("game", "setStage", {
			stage: "FINISHED",
		});
		expect(result.status).toBe("acknowledged");

		// Client received the broadcast with updated state
		const snap = client.channel("game").shardState("world");
		expect((snap.state as { stage: string }).stage).toBe("FINISHED");

		// Persisted with incremented version
		const persisted = await adapter.load("game", "world");
		expect((persisted?.state as { stage: string }).stage).toBe("FINISHED");
		expect(persisted?.version).toBeGreaterThan(versionBefore ?? 0);
	});

	test("client subscriber notified on broadcast", async () => {
		const { server, client } = await setupE2E();

		let notified = false;
		client.channel("game").subscribeToShard("world", () => {
			notified = true;
		});

		await server.submit("game", "advanceTurn", {});

		expect(notified).toBe(true);
	});

	test("reconnect resumes with local versions, server only sends changed shards", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});
		await adapter.compareAndSwap("game", "seat:1", 0, {
			items: [{ id: "sword", name: "Sword" }],
		});

		const {
			client: clientTransport,
			server: serverTransport,
			connect,
			disconnect,
		} = createDirectTransport();

		const server = createServer(serverEngine, {
			persistence: adapter,
			transport: serverTransport,
			defaultSubscriptions: () => [
				{ channelId: "game", shardIds: ["world", "seat:1"] },
			],
		});

		const client = createClient(clientEngine, {
			transport: clientTransport,
		});

		// Initial handshake
		connect();
		await new Promise((r) => setTimeout(r, 10));

		expect(client.ready).toBe(true);
		expect(client.channel("game").shardState("world").state).toEqual({
			stage: "PLAYING",
			turn: 0,
		});

		// Server advances turn while client is connected
		await server.submit("game", "advanceTurn", {});
		expect(client.channel("game").shardState("world").state).toEqual({
			stage: "PLAYING",
			turn: 1,
		});

		// Disconnect
		disconnect();
		expect(client.ready).toBe(false);

		// Client still has its local state
		expect(client.channel("game").shardState("world").state).toEqual({
			stage: "PLAYING",
			turn: 1,
		});
		expect(client.channel("game").shardState("seat:1").state).toEqual({
			items: [{ id: "sword", name: "Sword" }],
		});

		// Server advances turn while client is disconnected
		await server.submit("game", "advanceTurn", {});

		// Reconnect
		connect();
		await new Promise((r) => setTimeout(r, 10));

		expect(client.ready).toBe(true);

		// Client received the update that happened during disconnect
		expect(client.channel("game").shardState("world").state).toEqual({
			stage: "PLAYING",
			turn: 2,
		});

		// seat:1 unchanged — should still have its state (no re-send needed)
		expect(client.channel("game").shardState("seat:1").state).toEqual({
			items: [{ id: "sword", name: "Sword" }],
		});
	});
});

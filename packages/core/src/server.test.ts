import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import type { BroadcastMessage, Subscriber } from "./broadcast";
import { createDirectTransport } from "./direct-transport";
import { channel, engine, shard } from "./index";
import { MemoryStateAdapter } from "./persistence";
import { createServer } from "./server";

function createSubscriber(
	id: string,
): Subscriber & { messages: BroadcastMessage[] } {
	const messages: BroadcastMessage[] = [];
	return {
		id,
		messages,
		send(message: BroadcastMessage) {
			messages.push(message);
		},
	};
}

function setupServerEngine() {
	const gameChannel = channel
		.durable("game")
		.shard("world", v.object({ stage: v.string(), turn: v.number() }))
		.operation("advanceTurn", {
			execution: "optimistic",
			input: v.object({}),
			scope: () => [shard.ref("world")],
			apply(shards) {
				shards.world.turn += 1;
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

	const serverEngine = engine().channel(gameChannel).channel(presenceChannel);

	return serverEngine;
}

describe("createServer", () => {
	test("server-as-actor submits operations", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("acknowledged");

		const persisted = await adapter.load("game", "world");
		expect((persisted?.state as { turn: number }).turn).toBe(1);
	});

	test("server-as-actor broadcasts to subscribers", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const sub = createSubscriber("alice");
		server.addSubscriber("game", sub, ["world"]);

		await server.submit("game", "advanceTurn", {});

		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.channelId).toBe("game");
	});

	test("broadcastDirtyShards flushes ephemeral channel", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.set("presence", "player:alice", { online: false });

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const sub = createSubscriber("bob");
		server.addSubscriber("presence", sub, ["player:alice"]);

		await server.submit("presence", "setOnline", {
			playerId: "alice",
		});

		// autoBroadcast: false — nothing sent yet
		expect(sub.messages).toHaveLength(0);

		server.broadcastDirtyShards("presence");

		expect(sub.messages).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		if (entry && "state" in entry) {
			expect((entry.state as { online: boolean }).online).toBe(true);
		}
	});

	test("authorize hook is wired to all channels", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
			authorize: () => false,
		});

		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("rejected");
		if (result.status === "rejected") {
			expect(result.code).toBe("UNAUTHORIZED");
		}
	});

	test("removeSubscriber stops broadcasts", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const sub = createSubscriber("alice");
		server.addSubscriber("game", sub, ["world"]);

		await server.submit("game", "advanceTurn", {});
		expect(sub.messages).toHaveLength(1);

		server.removeSubscriber("game", "alice");

		await server.submit("game", "advanceTurn", {});
		expect(sub.messages).toHaveLength(1);
	});

	test("multiple channels work independently", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});
		await adapter.set("presence", "player:alice", { online: false });

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const gameSub = createSubscriber("game-watcher");
		const presSub = createSubscriber("pres-watcher");
		server.addSubscriber("game", gameSub, ["world"]);
		server.addSubscriber("presence", presSub, ["player:alice"]);

		await server.submit("game", "advanceTurn", {});
		await server.submit("presence", "setOnline", { playerId: "alice" });

		// game is autoBroadcast — sent immediately
		expect(gameSub.messages).toHaveLength(1);

		// presence is manual — nothing yet
		expect(presSub.messages).toHaveLength(0);

		server.broadcastDirtyShards("presence");
		expect(presSub.messages).toHaveLength(1);
	});

	describe("transport wiring", () => {
		test("client submit via transport returns acknowledge", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const { client, server: serverTransport } = createDirectTransport();
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: {},
				opId: "op-1",
			});

			// Wait for async pipeline
			await new Promise((r) => setTimeout(r, 10));

			expect(received).toHaveLength(1);
			expect(received[0]?.type).toBe("acknowledge");
			if (received[0]?.type === "acknowledge") {
				expect(received[0].opId).toBe("op-1");
			}
		});

		test("client submit via transport returns reject for bad input", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const { client, server: serverTransport } = createDirectTransport();
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: "invalid",
				opId: "op-2",
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(received).toHaveLength(1);
			expect(received[0]?.type).toBe("reject");
		});

		test("transport subscriber receives broadcasts", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client,
				server: serverTransport,
				connectionId,
			} = createDirectTransport();
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			server.addTransportSubscriber("game", connectionId, ["world"]);

			await server.submit("game", "advanceTurn", {});

			const broadcasts = received.filter((m) => m.type === "broadcast");
			expect(broadcasts).toHaveLength(1);
			if (broadcasts[0]?.type === "broadcast") {
				expect(broadcasts[0].channelId).toBe("game");
				expect(broadcasts[0].shards).toHaveLength(1);
			}
		});

		test("transport rejects unknown channel", async () => {
			const { client, server: serverTransport } = createDirectTransport();
			createServer(setupServerEngine(), {
				persistence: new MemoryStateAdapter(),
				transport: serverTransport,
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			client.send({
				type: "submit",
				channelId: "nonexistent",
				operationName: "op",
				input: {},
				opId: "op-3",
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(received).toHaveLength(1);
			expect(received[0]?.type).toBe("reject");
			if (received[0]?.type === "reject") {
				expect(received[0].code).toBe("INVALID_CHANNEL");
			}
		});
	});

	describe("connection handshake", () => {
		test("connect sends server versions, client responds, gets state + ready", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [
					{ channelId: "game", shardIds: ["world"] },
				],
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			connect();
			await new Promise((r) => setTimeout(r, 10));

			// Step 1: server sends its versions
			expect(received).toHaveLength(1);
			expect(received[0]?.type).toBe("versions");
			if (received[0]?.type === "versions") {
				expect(received[0].shards.world).toBe(1);
			}

			// Step 2: client responds with its versions (empty = first connect)
			client.send({ type: "versions", shards: {} });

			// Server sends state + ready
			expect(received).toHaveLength(3);
			expect(received[1]?.type).toBe("state");
			if (received[1]?.type === "state") {
				expect(received[1].channelId).toBe("game");
				expect(received[1].shards).toHaveLength(1);
				const entry = received[1].shards[0];
				if (entry && "state" in entry) {
					expect(entry.state).toEqual({ stage: "PLAYING", turn: 0 });
				}
			}
			expect(received[2]?.type).toBe("ready");
		});

		test("client with up-to-date version receives no state", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [
					{ channelId: "game", shardIds: ["world"] },
				],
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			connect();
			await new Promise((r) => setTimeout(r, 10));

			// Client already has version 1
			client.send({ type: "versions", shards: { world: 1 } });

			// Only ready — no state sent
			expect(received).toHaveLength(2);
			expect(received[1]?.type).toBe("ready");
		});

		test("after handshake, subscriber receives future broadcasts", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [
					{ channelId: "game", shardIds: ["world"] },
				],
			});

			const received: import("./transport").ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			// Complete handshake
			connect();
			await new Promise((r) => setTimeout(r, 10));
			client.send({ type: "versions", shards: {} });

			const handshakeCount = received.length;

			// Server submits — should broadcast to connected client
			await server.submit("game", "advanceTurn", {});

			const newMessages = received.slice(handshakeCount);
			const broadcasts = newMessages.filter((m) => m.type === "broadcast");
			expect(broadcasts).toHaveLength(1);
		});
	});

	describe("type + runtime safety", () => {
		test("rejects invalid channel name", async () => {
			const server = createServer(setupServerEngine(), {
				persistence: new MemoryStateAdapter(),
			});

			// @ts-expect-error: "nonexistent" is not a valid channel
			const promise = server.submit("nonexistent", "advanceTurn", {});
			await expect(promise).rejects.toThrow(
				'Channel "nonexistent" is not registered',
			);
		});

		test("rejects invalid operation name", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const server = createServer(setupServerEngine(), {
				persistence: adapter,
			});

			// @ts-expect-error: "nonexistent" is not a valid operation on "game"
			const result = await server.submit("game", "nonexistent", {});
			expect(result.status).toBe("rejected");
		});

		test("rejects invalid channel for broadcastDirtyShards", () => {
			const server = createServer(setupServerEngine(), {
				persistence: new MemoryStateAdapter(),
			});

			expect(() => {
				// @ts-expect-error: "nonexistent" is not a valid channel
				server.broadcastDirtyShards("nonexistent");
			}).toThrow('Channel "nonexistent" is not registered');
		});
	});
});

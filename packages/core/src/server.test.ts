import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import type { BroadcastMessage, Subscriber } from "./broadcast";
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

	test("throws on unknown channel name", async () => {
		const server = createServer(setupServerEngine(), {
			persistence: new MemoryStateAdapter(),
		});

		await expect(server.submit("nonexistent", "op", {})).rejects.toThrow(
			'Channel "nonexistent" is not registered',
		);
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
});

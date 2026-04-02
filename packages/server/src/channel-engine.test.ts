import { describe, expect, test } from "bun:test";
import {
	type BroadcastMessage,
	channel,
	type Subscriber,
	shard,
} from "@kio/shared";
import { expectToBeDefined } from "@kio/shared/test";
import * as v from "valibot";
import { ChannelEngine } from "./channel-engine";
import { MemoryStateAdapter } from "./persistence";

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

function setupDurableGame() {
	const ch = channel
		.durable("game")
		.shard("world", v.object({ stage: v.string(), turn: v.number() }))
		.shardPerResource("seat", v.object({ items: v.array(v.string()) }))
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
				shards.seat(input.seatId).items.push(input.item);
			},
		});

	const adapter = new MemoryStateAdapter();
	const engine = new ChannelEngine(ch["~data"], adapter);
	return { engine, adapter };
}

function setupEphemeralPresence() {
	const ch = channel
		.ephemeral("presence", { autoBroadcast: false })
		.shardPerResource("player", v.object({ lat: v.number(), lng: v.number() }))
		.operation("updateGps", {
			execution: "optimistic",
			versionChecked: false,
			deduplicate: false,
			input: v.object({
				playerId: v.string(),
				lat: v.number(),
				lng: v.number(),
			}),
			scope: (input) => [shard.ref("player", input.playerId)],
			apply(shards, input) {
				const p = shards.player(input.playerId);
				(p as { lat: number; lng: number }).lat = input.lat;
				(p as { lat: number; lng: number }).lng = input.lng;
			},
		});

	const adapter = new MemoryStateAdapter();
	const engine = new ChannelEngine(ch["~data"], adapter);
	return { engine, adapter };
}

const actor = { actorId: "player:alice" };

let opCounter = 0;
function nextOpId(): string {
	return `test:${String(opCounter++)}`;
}

describe("ChannelEngine — durable, autoBroadcast: true", () => {
	test("submit changes state and broadcasts patches", async () => {
		const { engine, adapter } = setupDurableGame();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["world"]);

		const result = await engine.submit({
			operationName: "advanceTurn",
			input: {},
			actor,
			opId: nextOpId(),
		});

		expect(result.status).toBe("acknowledged");

		// State persisted
		const persisted = await adapter.load("game", "world");
		expect((persisted?.state as { turn: number }).turn).toBe(1);

		// Subscriber received broadcast
		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.channelId).toBe("game");
		expect(sub.messages[0]?.kind).toBe("durable");
		expect(sub.messages[0]?.shards).toHaveLength(1);
		expect(sub.messages[0]?.shards[0]?.shardId).toBe("world");

		// causedBy includes opId
		const entry = sub.messages[0]?.shards[0];
		expectToBeDefined(entry);
		expectToBeDefined(entry.causedBy);
		expect(entry.causedBy.opId).toBeDefined();
		expect(entry.causedBy.operation).toBe("advanceTurn");
		expect(entry.causedBy.actor).toBe("player:alice");
	});

	test("failed submission does not broadcast", async () => {
		const { engine } = setupDurableGame();

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["world"]);

		const result = await engine.submit({
			operationName: "advanceTurn",
			input: "invalid",
			actor,
			opId: nextOpId(),
		});

		expect(result.status).toBe("rejected");
		expect(sub.messages).toHaveLength(0);
	});

	test("subscriber only receives broadcasts for subscribed shards", async () => {
		const { engine, adapter } = setupDurableGame();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});
		await adapter.compareAndSwap("game", "seat:1", 0, {
			items: [],
		});

		const worldSub = createSubscriber("world-watcher");
		const seatSub = createSubscriber("seat-watcher");
		engine.addSubscriber(worldSub, ["world"]);
		engine.addSubscriber(seatSub, ["seat:1"]);

		await engine.submit({
			operationName: "advanceTurn",
			input: {},
			actor,
			opId: nextOpId(),
		});

		expect(worldSub.messages).toHaveLength(1);
		expect(seatSub.messages).toHaveLength(0);

		await engine.submit({
			operationName: "addItem",
			input: { seatId: "1", item: "sword" },
			actor,
			opId: nextOpId(),
		});

		expect(worldSub.messages).toHaveLength(1);
		expect(seatSub.messages).toHaveLength(1);
		expect(seatSub.messages[0]?.shards[0]?.shardId).toBe("seat:1");
	});

	test("removed subscriber stops receiving", async () => {
		const { engine, adapter } = setupDurableGame();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["world"]);

		await engine.submit({
			operationName: "advanceTurn",
			input: {},
			actor,
			opId: nextOpId(),
		});
		expect(sub.messages).toHaveLength(1);

		engine.removeSubscriber("bob");

		await engine.submit({
			operationName: "advanceTurn",
			input: {},
			actor,
			opId: nextOpId(),
		});
		expect(sub.messages).toHaveLength(1);
	});
});

describe("ChannelEngine — durable, broadcastMode: full", () => {
	test("broadcasts full state instead of patches", async () => {
		const ch = channel
			.durable("game", { broadcastMode: "full" })
			.shard("world", v.object({ stage: v.string(), turn: v.number() }))
			.operation("advanceTurn", {
				execution: "optimistic",
				input: v.object({}),
				scope: () => [shard.ref("world")],
				apply(shards) {
					shards.world.turn += 1;
				},
			});

		const adapter = new MemoryStateAdapter();
		const engine = new ChannelEngine(ch["~data"], adapter);
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["world"]);

		await engine.submit({
			operationName: "advanceTurn",
			input: {},
			actor,
			opId: nextOpId(),
		});

		expect(sub.messages).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		expectToBeDefined(entry);
		// Full state, not patches
		expect("state" in entry).toBe(true);
		expect("patches" in entry).toBe(false);
		if ("state" in entry) {
			expect(entry.state).toEqual({ stage: "PLAYING", turn: 1 });
		}
		// causedBy still present
		expectToBeDefined(entry.causedBy);
		expect(entry.causedBy.operation).toBe("advanceTurn");
	});
});

describe("ChannelEngine — ephemeral, autoBroadcast: false", () => {
	test("submit marks dirty, broadcastDirtyShards sends full state", async () => {
		const { engine, adapter } = setupEphemeralPresence();

		// Seed initial state (ephemeral shards need existing state to mutate)
		await adapter.set("presence", "player:alice", { lat: 0, lng: 0 });

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["player:alice"]);

		await engine.submit({
			operationName: "updateGps",
			input: { playerId: "alice", lat: 48.8, lng: 2.3 },
			actor,
			opId: nextOpId(),
		});

		// autoBroadcast: false — nothing sent yet
		expect(sub.messages).toHaveLength(0);

		// Manual flush
		engine.broadcastDirtyShards();

		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.kind).toBe("ephemeral");
		const entry = sub.messages[0]?.shards[0];
		if (entry && "state" in entry) {
			expect((entry.state as { lat: number }).lat).toBe(48.8);
		}
	});

	test("multiple operations coalesce into one flush", async () => {
		const { engine, adapter } = setupEphemeralPresence();
		await adapter.set("presence", "player:alice", { lat: 0, lng: 0 });

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["player:alice"]);

		await engine.submit({
			operationName: "updateGps",
			input: { playerId: "alice", lat: 1, lng: 1 },
			actor,
			opId: nextOpId(),
		});
		await engine.submit({
			operationName: "updateGps",
			input: { playerId: "alice", lat: 2, lng: 2 },
			actor,
			opId: nextOpId(),
		});
		await engine.submit({
			operationName: "updateGps",
			input: { playerId: "alice", lat: 3, lng: 3 },
			actor,
			opId: nextOpId(),
		});

		engine.broadcastDirtyShards();

		expect(sub.messages).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		if (entry && "state" in entry) {
			expect((entry.state as { lat: number }).lat).toBe(3);
		}
	});

	test("selective flush by shard ID", async () => {
		const { engine, adapter } = setupEphemeralPresence();
		await adapter.set("presence", "player:alice", { lat: 0, lng: 0 });
		await adapter.set("presence", "player:carol", { lat: 0, lng: 0 });

		const sub = createSubscriber("bob");
		engine.addSubscriber(sub, ["player:alice", "player:carol"]);

		await engine.submit({
			operationName: "updateGps",
			input: { playerId: "alice", lat: 1, lng: 1 },
			actor,
			opId: nextOpId(),
		});
		await engine.submit({
			operationName: "updateGps",
			input: { playerId: "carol", lat: 2, lng: 2 },
			actor: { actorId: "player:carol" },
			opId: nextOpId(),
		});

		engine.broadcastDirtyShards(["player:alice"]);

		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.shards[0]?.shardId).toBe("player:alice");

		engine.broadcastDirtyShards();
		expect(sub.messages).toHaveLength(2);
		expect(sub.messages[1]?.shards[0]?.shardId).toBe("player:carol");
	});
});

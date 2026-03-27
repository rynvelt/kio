import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { channel, shard } from "./index";
import { MemoryStateAdapter } from "./persistence";
import {
	type Actor,
	MemoryDeduplicationTracker,
	OperationPipeline,
} from "./pipeline";
import { ShardStateManager } from "./shard-state-manager";

function setupGame() {
	const ch = channel
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
		.operation("useItem", {
			execution: "optimistic",
			input: v.object({ seatId: v.string(), itemId: v.string() }),
			errors: v.picklist(["ITEM_NOT_FOUND"]),
			scope: (input) => [shard.ref("seat", input.seatId)],
			apply(shards, input) {
				const items = shards.seat(input.seatId).items;
				const idx = items.findIndex((i) => i.id === input.itemId);
				if (idx >= 0) items.splice(idx, 1);
			},
		})
		.serverImpl("useItem", {
			validate(shards, input, _ctx, { reject }) {
				const item = shards
					.seat(input.seatId)
					.items.find((i) => i.id === input.itemId);
				if (!item) return reject("ITEM_NOT_FOUND", "Item not found");
			},
		})
		.operation("rollDice", {
			execution: "computed",
			input: v.object({ max: v.number() }),
			serverResult: v.object({ result: v.number() }),
			scope: () => [shard.ref("world")],
		})
		.serverImpl("rollDice", {
			compute(_shards, input) {
				return {
					result: Math.floor(Math.random() * (input.max as number)) + 1,
				};
			},
			apply(shards, _input, serverResult) {
				(shards.world as { stage: string; turn: number }).turn = (
					serverResult as { result: number }
				).result;
			},
		})
		.operation("chooseOption", {
			execution: "confirmed",
			input: v.object({ seatId: v.string(), option: v.string() }),
			errors: v.picklist(["INVALID_OPTION"]),
			scope: (input) => [shard.ref("seat", input.seatId)],
		})
		.serverImpl("chooseOption", {
			apply(shards, input) {
				const seat = shards.seat((input as { seatId: string }).seatId);
				(seat as { items: { id: string; name: string }[] }).items.push({
					id: "choice",
					name: (input as { option: string }).option,
				});
			},
		});

	const data = ch["~data"];
	const adapter = new MemoryStateAdapter();
	const stateManager = new ShardStateManager("game", data.shardDefs, adapter);
	const actor: Actor = { actorId: "player:alice" };

	return { data, adapter, stateManager, actor };
}

async function seedWorld(
	adapter: MemoryStateAdapter,
	state: { stage: string; turn: number },
) {
	await adapter.compareAndSwap("game", "world", 0, state);
}

async function seedSeat(
	adapter: MemoryStateAdapter,
	seatId: string,
	state: { items: { id: string; name: string }[] },
) {
	await adapter.compareAndSwap("game", `seat:${seatId}`, 0, state);
}

describe("OperationPipeline", () => {
	describe("optimistic operations", () => {
		test("applies and persists a simple mutation", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedWorld(adapter, { stage: "PLAYING", turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
			});

			expect(result.status).toBe("acknowledged");
			if (result.status === "acknowledged") {
				expect(result.shardVersions.get("world")).toBe(2);
				expect(result.patchesByShard.has("world")).toBe(true);
			}

			const persisted = await adapter.load("game", "world");
			expect((persisted?.state as { turn: number }).turn).toBe(1);
		});

		test("runs validate and rejects with typed error", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedSeat(adapter, "1", { items: [] });

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "useItem",
				input: { seatId: "1", itemId: "nonexistent" },
				actor,
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("ITEM_NOT_FOUND");
			}
		});

		test("applies per-resource shard mutation", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedSeat(adapter, "1", {
				items: [
					{ id: "sword", name: "Sword" },
					{ id: "shield", name: "Shield" },
				],
			});

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "useItem",
				input: { seatId: "1", itemId: "sword" },
				actor,
			});

			expect(result.status).toBe("acknowledged");

			const persisted = await adapter.load("game", "seat:1");
			const items = (persisted?.state as { items: { id: string }[] }).items;
			expect(items).toHaveLength(1);
			expect(items[0]?.id).toBe("shield");
		});
	});

	describe("computed operations", () => {
		test("runs compute and passes result to apply", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedWorld(adapter, { stage: "PLAYING", turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "rollDice",
				input: { max: 6 },
				actor,
			});

			expect(result.status).toBe("acknowledged");

			const persisted = await adapter.load("game", "world");
			const turn = (persisted?.state as { turn: number }).turn;
			expect(turn).toBeGreaterThanOrEqual(1);
			expect(turn).toBeLessThanOrEqual(6);
		});
	});

	describe("confirmed operations", () => {
		test("uses server impl apply", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedSeat(adapter, "1", { items: [] });

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "chooseOption",
				input: { seatId: "1", option: "explore" },
				actor,
			});

			expect(result.status).toBe("acknowledged");

			const persisted = await adapter.load("game", "seat:1");
			const items = (
				persisted?.state as { items: { id: string; name: string }[] }
			).items;
			expect(items).toHaveLength(1);
			expect(items[0]?.name).toBe("explore");
		});
	});

	describe("input validation", () => {
		test("rejects invalid input", async () => {
			const { data, stateManager, actor } = setupGame();
			const pipeline = new OperationPipeline(data, stateManager);

			const result = await pipeline.submit({
				operationName: "useItem",
				input: { seatId: 123 },
				actor,
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INVALID_INPUT");
			}
		});
	});

	describe("authorization", () => {
		test("rejects unauthorized operations", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedWorld(adapter, { stage: "PLAYING", turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager, {
				authorize: () => false,
			});

			const result = await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("UNAUTHORIZED");
			}
		});
	});

	describe("deduplication", () => {
		test("rejects duplicate operation IDs", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedWorld(adapter, { stage: "PLAYING", turn: 0 });

			const dedup = new MemoryDeduplicationTracker();
			const pipeline = new OperationPipeline(data, stateManager, {
				deduplication: dedup,
			});

			const first = await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
				opId: "op-1",
			});
			expect(first.status).toBe("acknowledged");

			const second = await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
				opId: "op-1",
			});
			expect(second.status).toBe("rejected");
			if (second.status === "rejected") {
				expect(second.code).toBe("DUPLICATE_OPERATION");
			}
		});
	});

	describe("version conflicts", () => {
		test("rejects on concurrent modification", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedWorld(adapter, { stage: "PLAYING", turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager);

			// Load into cache
			await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
			});

			// External write conflicts with cached version
			await adapter.compareAndSwap("game", "world", 2, {
				stage: "PLAYING",
				turn: 99,
			});

			const result = await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("VERSION_CONFLICT");
			}
		});
	});

	describe("unknown operations", () => {
		test("rejects non-existent operation name", async () => {
			const { data, stateManager, actor } = setupGame();
			const pipeline = new OperationPipeline(data, stateManager);

			const result = await pipeline.submit({
				operationName: "doesNotExist",
				input: {},
				actor,
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INVALID_OPERATION");
			}
		});
	});
});

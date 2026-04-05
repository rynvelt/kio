import { describe, expect, test } from "bun:test";
import { channel, shard } from "@kio/shared";
import { expectToBeDefined } from "@kio/shared/test";
import * as v from "valibot";
import { MemoryStateAdapter } from "./persistence";
import {
	type Actor,
	MemoryDeduplicationTracker,
	OperationPipeline,
} from "./pipeline";
import { ShardStateManager } from "./shard-state-manager";

let opCounter = 0;
function nextOpId(): string {
	return `test:${String(opCounter++)}`;
}

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
				opId: nextOpId(),
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
				opId: nextOpId(),
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
				opId: nextOpId(),
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
				opId: nextOpId(),
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
				opId: nextOpId(),
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
				opId: nextOpId(),
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
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("UNAUTHORIZED");
			}
		});

		test("authorize receives shardRefs from scope", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedSeat(adapter, "1", {
				items: [{ id: "sword", name: "Sword" }],
			});

			let receivedShardRefs: readonly { shardType: string; shardId: string }[] =
				[];
			const pipeline = new OperationPipeline(data, stateManager, {
				authorize: (_actor, _op, _ch, shardRefs) => {
					receivedShardRefs = shardRefs;
					return true;
				},
			});

			await pipeline.submit({
				operationName: "useItem",
				input: { seatId: "1", itemId: "sword" },
				actor,
				opId: nextOpId(),
			});

			expect(receivedShardRefs).toHaveLength(1);
			expect(receivedShardRefs[0]?.shardType).toBe("seat");
			expect(receivedShardRefs[0]?.shardId).toBe("seat:1");
		});

		test("authorize can reject based on shardRefs", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedSeat(adapter, "1", { items: [] });
			await seedSeat(adapter, "2", { items: [] });

			const pipeline = new OperationPipeline(data, stateManager, {
				authorize: (_actor, _op, _ch, shardRefs) => {
					// Only allow operations on seat:1
					return shardRefs.every((ref) => ref.shardId === "seat:1");
				},
			});

			const allowed = await pipeline.submit({
				operationName: "useItem",
				input: { seatId: "1", itemId: "x" },
				actor,
				opId: nextOpId(),
			});
			// Rejected by validate (item not found), not by authorize
			expect(allowed.status).toBe("rejected");
			if (allowed.status === "rejected") {
				expect(allowed.code).toBe("ITEM_NOT_FOUND");
			}

			const denied = await pipeline.submit({
				operationName: "useItem",
				input: { seatId: "2", itemId: "x" },
				actor,
				opId: nextOpId(),
			});
			expect(denied.status).toBe("rejected");
			if (denied.status === "rejected") {
				expect(denied.code).toBe("UNAUTHORIZED");
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
				opId: nextOpId(),
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
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("VERSION_CONFLICT");
				expectToBeDefined(result.shards);
				expect(result.shards).toHaveLength(1);
				const shard = result.shards[0];
				expectToBeDefined(shard);
				expect(shard.shardId).toBe("world");
				expect(shard.version).toBe(3);
				expect((shard.state as { turn: number }).turn).toBe(99);
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
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INVALID_OPERATION");
			}
		});
	});

	describe("versionChecked: false", () => {
		test("succeeds even after external modification", async () => {
			const ch = channel
				.durable("game")
				.shard("world", v.object({ status: v.string() }))
				.operation("setStatus", {
					execution: "optimistic",
					versionChecked: false,
					deduplicate: false,
					input: v.object({ status: v.string() }),
					scope: () => [shard.ref("world")],
					apply(shards, input) {
						shards.world.status = input.status;
					},
				});

			const data = ch["~data"];
			const adapter = new MemoryStateAdapter();
			const stateManager = new ShardStateManager(
				"game",
				data.shardDefs,
				adapter,
			);
			const actor: Actor = { actorId: "player:alice" };

			await adapter.compareAndSwap("game", "world", 0, {
				status: "idle",
			});

			const pipeline = new OperationPipeline(data, stateManager);

			// First write to prime the cache
			await pipeline.submit({
				operationName: "setStatus",
				input: { status: "busy" },
				actor,
				opId: nextOpId(),
			});

			// External modification
			await adapter.set("game", "world", { status: "external" });

			// versionChecked: false should succeed unconditionally
			const result = await pipeline.submit({
				operationName: "setStatus",
				input: { status: "away" },
				actor,
				opId: nextOpId(),
			});

			expect(result.status).toBe("acknowledged");

			const persisted = await adapter.load("game", "world");
			expect((persisted?.state as { status: string }).status).toBe("away");
		});
	});

	describe("ephemeral channels", () => {
		test("applies without persistence", async () => {
			const ch = channel
				.ephemeral("presence")
				.shardPerResource(
					"player",
					v.object({
						gps: v.object({ lat: v.number(), lng: v.number() }),
					}),
				)
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
						(p as { gps: { lat: number; lng: number } }).gps = {
							lat: input.lat,
							lng: input.lng,
						};
					},
				});

			const data = ch["~data"];
			const adapter = new MemoryStateAdapter();
			const stateManager = new ShardStateManager(
				"presence",
				data.shardDefs,
				adapter,
			);
			const actor: Actor = { actorId: "player:alice" };

			// Seed initial state in cache (ephemeral — no persistence)
			stateManager.setCached("player:alice", { gps: { lat: 0, lng: 0 } }, 0);

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "updateGps",
				input: { playerId: "alice", lat: 48.8, lng: 2.3 },
				actor,
				opId: nextOpId(),
			});

			expect(result.status).toBe("acknowledged");

			// State updated in cache
			const cached = stateManager.getCached("player:alice");
			expect((cached?.state as { gps: { lat: number } }).gps.lat).toBe(48.8);

			// Nothing written to persistence adapter
			const persisted = await adapter.load("presence", "player:alice");
			expect(persisted).toBeUndefined();
		});
	});

	describe("error boundaries", () => {
		test("apply throwing returns INTERNAL_ERROR", async () => {
			const ch = channel
				.durable("game")
				.shard("world", v.object({ turn: v.number() }))
				.operation("crashingOp", {
					execution: "optimistic",
					input: v.object({}),
					scope: () => [shard.ref("world")],
					apply() {
						throw new Error("consumer bug");
					},
				});

			const data = ch["~data"];
			const adapter = new MemoryStateAdapter();
			const stateManager = new ShardStateManager(
				"game",
				data.shardDefs,
				adapter,
			);
			await adapter.compareAndSwap("game", "world", 0, { turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "crashingOp",
				input: {},
				actor: { actorId: "alice" },
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INTERNAL_ERROR");
			}
		});

		test("scope throwing returns INTERNAL_ERROR", async () => {
			const ch = channel
				.durable("game")
				.shard("world", v.object({ turn: v.number() }))
				.operation("crashingScope", {
					execution: "optimistic",
					input: v.object({}),
					scope: () => {
						throw new Error("scope bug");
					},
					apply() {},
				});

			const data = ch["~data"];
			const adapter = new MemoryStateAdapter();
			const stateManager = new ShardStateManager(
				"game",
				data.shardDefs,
				adapter,
			);

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "crashingScope",
				input: {},
				actor: { actorId: "alice" },
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INTERNAL_ERROR");
			}
		});

		test("authorize throwing returns INTERNAL_ERROR", async () => {
			const { data, adapter, stateManager, actor } = setupGame();
			await seedWorld(adapter, { stage: "PLAYING", turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager, {
				authorize: () => {
					throw new Error("authorize bug");
				},
			});

			const result = await pipeline.submit({
				operationName: "advanceTurn",
				input: {},
				actor,
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INTERNAL_ERROR");
			}
		});

		test("compute throwing returns INTERNAL_ERROR", async () => {
			const ch = channel
				.durable("game")
				.shard("world", v.object({ turn: v.number() }))
				.operation("crashingCompute", {
					execution: "computed",
					input: v.object({}),
					scope: () => [shard.ref("world")],
				})
				.serverImpl("crashingCompute", {
					compute() {
						throw new Error("compute bug");
					},
					apply() {},
				});

			const data = ch["~data"];
			const adapter = new MemoryStateAdapter();
			const stateManager = new ShardStateManager(
				"game",
				data.shardDefs,
				adapter,
			);
			await adapter.compareAndSwap("game", "world", 0, { turn: 0 });

			const pipeline = new OperationPipeline(data, stateManager);
			const result = await pipeline.submit({
				operationName: "crashingCompute",
				input: {},
				actor: { actorId: "alice" },
				opId: nextOpId(),
			});

			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.code).toBe("INTERNAL_ERROR");
			}
		});
	});
});

import { describe, expect, test } from "bun:test";
import { type ShardDefinition, shard } from "@kiojs/shared";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { MemoryStateAdapter, type StateAdapter } from "./persistence";
import { ShardStateManager } from "./shard-state-manager";

/**
 * Minimal StandardSchema stub — shard defs require a schema, but these
 * tests never invoke validation, so a pass-through shim is sufficient.
 */
const stubSchema: StandardSchemaV1 = {
	"~standard": {
		version: 1,
		vendor: "test",
		validate: (value) => ({ value }),
	},
};

function createManager(
	shardDefs: Array<
		| [name: string, kind: "singleton" | "perResource"]
		| [
				name: string,
				kind: "singleton" | "perResource",
				defaultState: unknown | ((resourceId: string) => unknown),
		  ]
	>,
) {
	const defs = new Map<string, ShardDefinition>(
		shardDefs.map((entry) => [
			entry[0],
			{
				name: entry[0],
				kind: entry[1],
				schema: stubSchema,
				defaultState: entry[2],
			},
		]),
	);
	const adapter = new MemoryStateAdapter();
	return { manager: new ShardStateManager("game", defs, adapter), adapter };
}

describe("ShardStateManager", () => {
	describe("loadShards", () => {
		test("returns version 0 for missing shards", async () => {
			const { manager } = createManager([["world", "singleton"]]);
			const loaded = await manager.loadShards([shard.ref("world")]);
			const world = loaded.get("world");
			expect(world?.version).toBe(0);
			expect(world?.state).toBeUndefined();
		});

		test("loads persisted state", async () => {
			const { manager, adapter } = createManager([["world", "singleton"]]);
			await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });

			const loaded = await manager.loadShards([shard.ref("world")]);
			expect(loaded.get("world")?.state).toEqual({ stage: "PLAYING" });
			expect(loaded.get("world")?.version).toBe(1);
		});

		test("uses cache on second load", async () => {
			const { manager, adapter } = createManager([["world", "singleton"]]);
			await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });

			await manager.loadShards([shard.ref("world")]);
			// Modify persistence directly — cache should not see it
			await adapter.compareAndSwap("game", "world", 1, {
				stage: "FINISHED",
			});

			const loaded = await manager.loadShards([shard.ref("world")]);
			expect(loaded.get("world")?.state).toEqual({ stage: "PLAYING" });
		});

		test("uses defaultState for missing singleton", async () => {
			const { manager } = createManager([
				["world", "singleton", { stage: "WAITING", turn: 0 }],
			]);
			const loaded = await manager.loadShards([shard.ref("world")]);
			expect(loaded.get("world")?.state).toEqual({
				stage: "WAITING",
				turn: 0,
			});
			expect(loaded.get("world")?.version).toBe(0);
		});

		test("uses defaultState value for missing per-resource shard", async () => {
			const { manager } = createManager([
				["subscription", "perResource", { refs: [] }],
			]);
			const loaded = await manager.loadShards([
				shard.ref("subscription", "bob"),
			]);
			expect(loaded.get("subscription:bob")?.state).toEqual({ refs: [] });
		});

		test("invokes defaultState function with resourceId for per-resource shards", async () => {
			const init = (id: string) => ({ id, inventory: [] });
			const { manager } = createManager([["seat", "perResource", init]]);
			const loaded = await manager.loadShards([shard.ref("seat", "3")]);
			expect(loaded.get("seat:3")?.state).toEqual({ id: "3", inventory: [] });
		});

		test("persisted state takes precedence over defaultState", async () => {
			const { manager, adapter } = createManager([
				["world", "singleton", { stage: "WAITING" }],
			]);
			await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });
			const loaded = await manager.loadShards([shard.ref("world")]);
			expect(loaded.get("world")?.state).toEqual({ stage: "PLAYING" });
			expect(loaded.get("world")?.version).toBe(1);
		});

		test("no defaultState leaves state undefined (legacy behavior)", async () => {
			const { manager } = createManager([["world", "singleton"]]);
			const loaded = await manager.loadShards([shard.ref("world")]);
			expect(loaded.get("world")?.state).toBeUndefined();
		});
	});

	describe("buildAccessors", () => {
		test("singleton shard is a direct property", () => {
			const { manager } = createManager([["world", "singleton"]]);
			const root = { world: { stage: "PLAYING" } };
			const accessors = manager.buildAccessors(root, [shard.ref("world")]);

			expect((accessors as { world: { stage: string } }).world.stage).toBe(
				"PLAYING",
			);
		});

		test("per-resource shard is a function", () => {
			const { manager } = createManager([["seat", "perResource"]]);
			const root = { "seat:1": { items: ["sword"] } };
			const accessors = manager.buildAccessors(root, [shard.ref("seat", "1")]);

			const seatFn = (
				accessors as { seat: (id: string) => { items: string[] } }
			).seat;
			expect(typeof seatFn).toBe("function");
			expect(seatFn("1").items).toEqual(["sword"]);
		});
	});

	describe("applyMutation", () => {
		test("singleton mutation produces patches", () => {
			const { manager } = createManager([["world", "singleton"]]);
			const root = { world: { stage: "PLAYING", turn: 0 } };

			const { newRoot, patchesByShard } = manager.applyMutation(
				root,
				[shard.ref("world")],
				(shards) => {
					const world = shards.world as { stage: string; turn: number };
					world.turn = 1;
				},
			);

			expect((newRoot as { world: { turn: number } }).world.turn).toBe(1);
			expect(patchesByShard.has("world")).toBe(true);
			const worldPatches = patchesByShard.get("world") ?? [];
			expect(worldPatches.length).toBeGreaterThan(0);
			// Patches should have first path segment stripped
			expect(worldPatches[0]?.path[0]).toBe("turn");
		});

		test("per-resource mutation via accessor function", () => {
			const { manager } = createManager([["seat", "perResource"]]);
			const root = { "seat:1": { items: ["sword"] } };

			const { newRoot, patchesByShard } = manager.applyMutation(
				root,
				[shard.ref("seat", "1")],
				(shards) => {
					const seat = (shards.seat as (id: string) => { items: string[] })(
						"1",
					);
					seat.items.push("potion");
				},
			);

			expect(
				(newRoot as { "seat:1": { items: string[] } })["seat:1"].items,
			).toEqual(["sword", "potion"]);
			expect(patchesByShard.has("seat:1")).toBe(true);
		});

		test("multi-shard mutation in single apply", () => {
			const { manager } = createManager([["seat", "perResource"]]);
			const root = {
				"seat:1": { items: ["sword"] },
				"seat:2": { items: [] as string[] },
			};

			const { newRoot, patchesByShard } = manager.applyMutation(
				root,
				[shard.ref("seat", "1"), shard.ref("seat", "2")],
				(shards) => {
					const seatFn = shards.seat as (id: string) => { items: string[] };
					const from = seatFn("1");
					const to = seatFn("2");
					const item = from.items.pop();
					if (item) to.items.push(item);
				},
			);

			expect(
				(newRoot as Record<string, { items: string[] }>)["seat:1"]?.items,
			).toEqual([]);
			expect(
				(newRoot as Record<string, { items: string[] }>)["seat:2"]?.items,
			).toEqual(["sword"]);
			expect(patchesByShard.has("seat:1")).toBe(true);
			expect(patchesByShard.has("seat:2")).toBe(true);
		});

		test("original root is not mutated", () => {
			const { manager } = createManager([["world", "singleton"]]);
			const root = { world: { turn: 0 } };

			manager.applyMutation(root, [shard.ref("world")], (shards) => {
				(shards.world as { turn: number }).turn = 99;
			});

			expect(root.world.turn).toBe(0);
		});
	});

	describe("persist", () => {
		test("single shard CAS succeeds and updates cache", async () => {
			const { manager } = createManager([["world", "singleton"]]);
			const shards = await manager.loadShards([shard.ref("world")]);
			const newRoot = { world: { stage: "PLAYING" } };

			const result = await manager.persist(shards, newRoot);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.versions.get("world")).toBe(1);
			}

			// Cache updated
			const cached = manager.getCached("world");
			expect(cached?.state).toEqual({ stage: "PLAYING" });
			expect(cached?.version).toBe(1);
		});

		test("single shard CAS fails on version conflict", async () => {
			const { manager, adapter } = createManager([["world", "singleton"]]);
			const shards = await manager.loadShards([shard.ref("world")]);

			// Someone else writes first
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "FINISHED",
			});

			const newRoot = { world: { stage: "PLAYING" } };
			const result = await manager.persist(shards, newRoot);
			expect(result.success).toBe(false);

			// Cache updated with current state from conflict
			const cached = manager.getCached("world");
			expect(cached?.state).toEqual({ stage: "FINISHED" });
			expect(cached?.version).toBe(1);
		});

		test("multi shard CAS failure refreshes cache for failed shard", async () => {
			const { manager, adapter } = createManager([["seat", "perResource"]]);
			await adapter.compareAndSwap("game", "seat:1", 0, { items: ["sword"] });
			await adapter.compareAndSwap("game", "seat:2", 0, { items: [] });

			const shards = await manager.loadShards([
				shard.ref("seat", "1"),
				shard.ref("seat", "2"),
			]);

			// Someone else bumps seat:2 so our CAS will fail on it
			await adapter.compareAndSwap("game", "seat:2", 1, {
				items: ["shield"],
			});

			const newRoot = {
				"seat:1": { items: [] },
				"seat:2": { items: ["sword"] },
			};

			const result = await manager.persist(shards, newRoot);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.failedShardId).toBe("seat:2");
			}

			// Cache for the conflicting shard must now hold fresh state so the
			// next loadShards call returns the truth, not the stale attempted value.
			const cached = manager.getCached("seat:2");
			expect(cached?.state).toEqual({ items: ["shield"] });
			expect(cached?.version).toBe(2);
		});

		test("multi shard CAS succeeds", async () => {
			const { manager, adapter } = createManager([["seat", "perResource"]]);
			await adapter.compareAndSwap("game", "seat:1", 0, {
				items: ["sword"],
			});
			await adapter.compareAndSwap("game", "seat:2", 0, { items: [] });

			const shards = await manager.loadShards([
				shard.ref("seat", "1"),
				shard.ref("seat", "2"),
			]);
			const newRoot = {
				"seat:1": { items: [] },
				"seat:2": { items: ["sword"] },
			};

			const result = await manager.persist(shards, newRoot);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.versions.get("seat:1")).toBe(2);
				expect(result.versions.get("seat:2")).toBe(2);
			}
		});
	});

	describe("persistUnconditional", () => {
		test("single shard uses adapter.set", async () => {
			const { manager } = createManager([["world", "singleton"]]);
			const { versions } = await manager.persistUnconditional(["world"], {
				world: { stage: "PLAYING" },
			});
			expect(versions.get("world")).toBe(1);
			expect(manager.getCached("world")).toEqual({
				state: { stage: "PLAYING" },
				version: 1,
			});
		});

		test("multi shard writes atomically via setMulti", async () => {
			const { manager, adapter } = createManager([["seat", "perResource"]]);

			const newRoot = {
				"seat:1": { items: ["sword"] },
				"seat:2": { items: ["shield"] },
			};
			const { versions } = await manager.persistUnconditional(
				["seat:1", "seat:2"],
				newRoot,
			);

			expect(versions.get("seat:1")).toBe(1);
			expect(versions.get("seat:2")).toBe(1);

			// Both cache and adapter reflect the write
			expect(manager.getCached("seat:1")?.version).toBe(1);
			expect(manager.getCached("seat:2")?.version).toBe(1);
			expect((await adapter.load("game", "seat:1"))?.state).toEqual({
				items: ["sword"],
			});
			expect((await adapter.load("game", "seat:2"))?.state).toEqual({
				items: ["shield"],
			});
		});

		test("multi shard setMulti failure leaves no partial writes", async () => {
			const { adapter } = createManager([["seat", "perResource"]]);
			await adapter.set("game", "seat:1", { items: ["existing"] });

			// Fault-injecting adapter wrapper: throws from setMulti. Delegated
			// explicitly because spreading a class instance drops prototype methods.
			const throwingAdapter: StateAdapter = {
				load: (c, s) => adapter.load(c, s),
				set: (c, s, n) => adapter.set(c, s, n),
				compareAndSwap: (c, s, v, n) => adapter.compareAndSwap(c, s, v, n),
				compareAndSwapMulti: (ops) => adapter.compareAndSwapMulti(ops),
				setMulti: async () => {
					throw new Error("infra down");
				},
			};
			const faultyManager = new ShardStateManager(
				"game",
				new Map([
					[
						"seat",
						{
							name: "seat",
							kind: "perResource" as const,
							schema: stubSchema,
							defaultState: undefined,
						},
					],
				]),
				throwingAdapter,
			);

			await expect(
				faultyManager.persistUnconditional(["seat:1", "seat:2"], {
					"seat:1": { items: ["new"] },
					"seat:2": { items: ["also-new"] },
				}),
			).rejects.toThrow("infra down");

			// The real adapter still holds only the pre-existing seat:1
			expect((await adapter.load("game", "seat:1"))?.state).toEqual({
				items: ["existing"],
			});
			expect(await adapter.load("game", "seat:2")).toBeUndefined();
		});
	});
});

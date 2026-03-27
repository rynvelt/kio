import { describe, expect, test } from "bun:test";
import type { ShardDefinition } from "./channel";
import { MemoryStateAdapter } from "./persistence";
import { ref } from "./shard";
import { ShardStateManager } from "./shard-state-manager";

function createManager(shardDefs: [string, "singleton" | "perResource"][]) {
	const defs = new Map<string, ShardDefinition>(
		shardDefs.map(([name, kind]) => [
			name,
			// biome-ignore lint/suspicious/noExplicitAny: test helper
			{ name, kind, schema: {} as any },
		]),
	);
	const adapter = new MemoryStateAdapter();
	return { manager: new ShardStateManager("game", defs, adapter), adapter };
}

describe("ShardStateManager", () => {
	describe("loadShards", () => {
		test("returns version 0 for missing shards", async () => {
			const { manager } = createManager([["world", "singleton"]]);
			const loaded = await manager.loadShards([ref("world")]);
			const world = loaded.get("world");
			expect(world?.version).toBe(0);
			expect(world?.state).toBeUndefined();
		});

		test("loads persisted state", async () => {
			const { manager, adapter } = createManager([["world", "singleton"]]);
			await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });

			const loaded = await manager.loadShards([ref("world")]);
			expect(loaded.get("world")?.state).toEqual({ stage: "PLAYING" });
			expect(loaded.get("world")?.version).toBe(1);
		});

		test("uses cache on second load", async () => {
			const { manager, adapter } = createManager([["world", "singleton"]]);
			await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });

			await manager.loadShards([ref("world")]);
			// Modify persistence directly — cache should not see it
			await adapter.compareAndSwap("game", "world", 1, {
				stage: "FINISHED",
			});

			const loaded = await manager.loadShards([ref("world")]);
			expect(loaded.get("world")?.state).toEqual({ stage: "PLAYING" });
		});
	});

	describe("buildAccessors", () => {
		test("singleton shard is a direct property", () => {
			const { manager } = createManager([["world", "singleton"]]);
			const root = { world: { stage: "PLAYING" } };
			const accessors = manager.buildAccessors(root, [ref("world")]);

			expect((accessors as { world: { stage: string } }).world.stage).toBe(
				"PLAYING",
			);
		});

		test("per-resource shard is a function", () => {
			const { manager } = createManager([["seat", "perResource"]]);
			const root = { "seat:1": { items: ["sword"] } };
			const accessors = manager.buildAccessors(root, [ref("seat", "1")]);

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
				[ref("world")],
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
				[ref("seat", "1")],
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
				[ref("seat", "1"), ref("seat", "2")],
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

			manager.applyMutation(root, [ref("world")], (shards) => {
				(shards.world as { turn: number }).turn = 99;
			});

			expect(root.world.turn).toBe(0);
		});
	});

	describe("persist", () => {
		test("single shard CAS succeeds and updates cache", async () => {
			const { manager } = createManager([["world", "singleton"]]);
			const shards = await manager.loadShards([ref("world")]);
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
			const shards = await manager.loadShards([ref("world")]);

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

		test("multi shard CAS succeeds", async () => {
			const { manager, adapter } = createManager([["seat", "perResource"]]);
			await adapter.compareAndSwap("game", "seat:1", 0, {
				items: ["sword"],
			});
			await adapter.compareAndSwap("game", "seat:2", 0, { items: [] });

			const shards = await manager.loadShards([
				ref("seat", "1"),
				ref("seat", "2"),
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
});

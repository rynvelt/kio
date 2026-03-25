import { describe, expect, test } from "bun:test";
import { enableMapSet, enablePatches, produceWithPatches } from "immer";

enablePatches();
enableMapSet();

describe("immer composed root object", () => {
	test("single shard mutation produces patches", () => {
		const root = {
			"seat:1": { inventory: ["sword", "shield"], visited: new Set(["a"]) },
		};

		const [next, patches] = produceWithPatches(root, (draft) => {
			const seat = draft["seat:1"];
			if (seat) {
				seat.inventory.push("potion");
				seat.visited.add("b");
			}
		});

		expect(next["seat:1"]?.inventory).toEqual(["sword", "shield", "potion"]);
		expect(next["seat:1"]?.visited.has("b")).toBe(true);
		expect(patches.length).toBeGreaterThan(0);
		// Original unchanged
		expect(root["seat:1"]?.inventory).toEqual(["sword", "shield"]);
	});

	test("multi-shard mutation in single produce call", () => {
		const root = {
			"seat:1": { inventory: ["sword"] },
			"seat:2": { inventory: ["shield"] },
		};

		const [next, patches] = produceWithPatches(root, (draft) => {
			const from = draft["seat:1"];
			const to = draft["seat:2"];
			if (from && to) {
				const item = from.inventory.pop();
				if (item) to.inventory.push(item);
			}
		});

		expect(next["seat:1"]?.inventory).toEqual([]);
		expect(next["seat:2"]?.inventory).toEqual(["shield", "sword"]);
		expect(patches.length).toBeGreaterThan(0);
	});

	test("singleton + per-resource shards in one root", () => {
		const root = {
			world: { gameStage: "PLAYING" as string, turnCount: 0 },
			"seat:1": { inventory: ["sword"] },
		};

		const [next, patches] = produceWithPatches(root, (draft) => {
			const world = draft.world;
			const seat = draft["seat:1"];
			if (world && seat) {
				world.turnCount += 1;
				seat.inventory.push("potion");
			}
		});

		expect(next.world?.turnCount).toBe(1);
		expect(next["seat:1"]?.inventory).toEqual(["sword", "potion"]);
		expect(patches.length).toBeGreaterThan(0);
	});

	test("patches can be decomposed per shard", () => {
		const root = {
			world: { turnCount: 0 },
			"seat:1": { inventory: ["sword"] },
			"seat:2": { inventory: ["shield"] },
		};

		const [_next, patches] = produceWithPatches(root, (draft) => {
			const world = draft.world;
			const seat1 = draft["seat:1"];
			if (world && seat1) {
				world.turnCount += 1;
				seat1.inventory.push("potion");
			}
		});

		// Patches should be decomposable by first path segment (shard key)
		const patchesByShard = new Map<string, typeof patches>();
		for (const patch of patches) {
			const shardKey = patch.path[0];
			if (typeof shardKey === "string") {
				const existing = patchesByShard.get(shardKey) ?? [];
				existing.push(patch);
				patchesByShard.set(shardKey, existing);
			}
		}

		expect(patchesByShard.has("world")).toBe(true);
		expect(patchesByShard.has("seat:1")).toBe(true);
		expect(patchesByShard.has("seat:2")).toBe(false);
	});

	test("Set mutations produce patches", () => {
		enablePatches();

		const root = {
			fog: { cells: new Set(["a", "b"]) },
		};

		const [next, patches] = produceWithPatches(root, (draft) => {
			draft.fog?.cells.add("c");
		});

		expect(next.fog?.cells.has("c")).toBe(true);
		expect(next.fog?.cells.size).toBe(3);
		expect(patches.length).toBeGreaterThan(0);
	});
});

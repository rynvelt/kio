import { describe, expect, test } from "bun:test";
import { MemoryStateAdapter } from "./persistence";

describe("MemoryStateAdapter", () => {
	test("load returns undefined for missing shard", async () => {
		const adapter = new MemoryStateAdapter();
		const result = await adapter.load("game", "world");
		expect(result).toBeUndefined();
	});

	test("CAS succeeds on version 0 for new shard", async () => {
		const adapter = new MemoryStateAdapter();
		const result = await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.version).toBe(1);
		}
	});

	test("load returns state after CAS", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });
		const loaded = await adapter.load("game", "world");
		expect(loaded).toEqual({ state: { stage: "PLAYING" }, version: 1 });
	});

	test("CAS fails on version mismatch", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });
		const result = await adapter.compareAndSwap("game", "world", 0, {
			stage: "FINISHED",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.currentVersion).toBe(1);
			expect(result.currentState).toEqual({ stage: "PLAYING" });
		}
	});

	test("CAS succeeds with correct version", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });
		const result = await adapter.compareAndSwap("game", "world", 1, {
			stage: "FINISHED",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.version).toBe(2);
		}
	});

	test("CAS multi succeeds when all versions match", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "seat:1", 0, { items: ["sword"] });
		await adapter.compareAndSwap("game", "seat:2", 0, { items: ["shield"] });

		const result = await adapter.compareAndSwapMulti([
			{
				channelId: "game",
				shardId: "seat:1",
				expectedVersion: 1,
				newState: { items: [] },
			},
			{
				channelId: "game",
				shardId: "seat:2",
				expectedVersion: 1,
				newState: { items: ["shield", "sword"] },
			},
		]);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.versions.get("seat:1")).toBe(2);
			expect(result.versions.get("seat:2")).toBe(2);
		}

		const s1 = await adapter.load("game", "seat:1");
		expect(s1?.state).toEqual({ items: [] });
		expect(s1?.version).toBe(2);

		const s2 = await adapter.load("game", "seat:2");
		expect(s2?.state).toEqual({ items: ["shield", "sword"] });
		expect(s2?.version).toBe(2);
	});

	test("CAS multi fails atomically and identifies failed shard", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "seat:1", 0, { items: ["sword"] });
		await adapter.compareAndSwap("game", "seat:2", 0, { items: ["shield"] });

		// Stale version for seat:2
		const result = await adapter.compareAndSwapMulti([
			{
				channelId: "game",
				shardId: "seat:1",
				expectedVersion: 1,
				newState: { items: [] },
			},
			{
				channelId: "game",
				shardId: "seat:2",
				expectedVersion: 0,
				newState: { items: ["shield", "sword"] },
			},
		]);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.failedShardId).toBe("seat:2");
			expect(result.currentVersion).toBe(1);
		}

		// Neither shard was modified
		const s1 = await adapter.load("game", "seat:1");
		expect(s1?.state).toEqual({ items: ["sword"] });
		expect(s1?.version).toBe(1);

		const s2 = await adapter.load("game", "seat:2");
		expect(s2?.state).toEqual({ items: ["shield"] });
		expect(s2?.version).toBe(1);
	});

	test("CAS multi with empty array succeeds with empty versions", async () => {
		const adapter = new MemoryStateAdapter();
		const result = await adapter.compareAndSwapMulti([]);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.versions.size).toBe(0);
		}
	});

	test("different channels are independent", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING" });
		await adapter.compareAndSwap("presence", "world", 0, { online: true });

		const game = await adapter.load("game", "world");
		const presence = await adapter.load("presence", "world");

		expect(game?.state).toEqual({ stage: "PLAYING" });
		expect(presence?.state).toEqual({ online: true });
	});
});

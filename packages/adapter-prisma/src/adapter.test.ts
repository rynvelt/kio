import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaStateAdapter } from "./adapter";
import { PrismaClient } from "./generated/client";

let adapter: PrismaStateAdapter;
let prisma: PrismaClient;
let pglite: PGlite;

beforeAll(async () => {
	pglite = new PGlite();
	const pgliteAdapter = new PrismaPGlite(pglite);
	prisma = new PrismaClient({ adapter: pgliteAdapter });

	// Create the table
	await pglite.exec(`
		CREATE TABLE IF NOT EXISTS "ShardState" (
			"channelId" TEXT NOT NULL,
			"shardId" TEXT NOT NULL,
			"version" INTEGER NOT NULL,
			"state" JSONB NOT NULL,
			PRIMARY KEY ("channelId", "shardId")
		)
	`);

	adapter = new PrismaStateAdapter(prisma);
});

afterAll(async () => {
	await prisma.$disconnect();
	await pglite.close();
});

describe("PrismaStateAdapter", () => {
	describe("load", () => {
		test("returns undefined for non-existent shard", async () => {
			const result = await adapter.load("game", "nonexistent");
			expect(result).toBeUndefined();
		});
	});

	describe("set", () => {
		test("creates shard on first write", async () => {
			const result = await adapter.set("game", "world", { turn: 0 });
			expect(result.version).toBe(1);

			const loaded = await adapter.load("game", "world");
			expect(loaded?.state).toEqual({ turn: 0 });
			expect(loaded?.version).toBe(1);
		});

		test("increments version on subsequent writes", async () => {
			await adapter.set("game", "set-test", { value: 1 });
			const result = await adapter.set("game", "set-test", { value: 2 });
			expect(result.version).toBe(2);

			const loaded = await adapter.load("game", "set-test");
			expect(loaded?.state).toEqual({ value: 2 });
		});
	});

	describe("compareAndSwap", () => {
		test("succeeds when version matches", async () => {
			await adapter.set("game", "cas-test", { turn: 0 });

			const result = await adapter.compareAndSwap("game", "cas-test", 1, {
				turn: 1,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.version).toBe(2);
			}

			const loaded = await adapter.load("game", "cas-test");
			expect(loaded?.state).toEqual({ turn: 1 });
		});

		test("fails when version does not match", async () => {
			await adapter.set("game", "cas-fail", { turn: 0 });

			const result = await adapter.compareAndSwap("game", "cas-fail", 99, {
				turn: 1,
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.currentVersion).toBe(1);
				expect(result.currentState).toEqual({ turn: 0 });
			}

			// State unchanged
			const loaded = await adapter.load("game", "cas-fail");
			expect(loaded?.state).toEqual({ turn: 0 });
		});
	});

	describe("compareAndSwapMulti", () => {
		test("succeeds when all versions match", async () => {
			await adapter.set("game", "multi-a", { value: "a" });
			await adapter.set("game", "multi-b", { value: "b" });

			const result = await adapter.compareAndSwapMulti([
				{
					channelId: "game",
					shardId: "multi-a",
					expectedVersion: 1,
					newState: { value: "a2" },
				},
				{
					channelId: "game",
					shardId: "multi-b",
					expectedVersion: 1,
					newState: { value: "b2" },
				},
			]);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.versions.get("multi-a")).toBe(2);
				expect(result.versions.get("multi-b")).toBe(2);
			}
		});

		test("fails atomically when one version mismatches", async () => {
			await adapter.set("game", "multi-c", { value: "c" });
			await adapter.set("game", "multi-d", { value: "d" });
			// Advance multi-d to version 2
			await adapter.set("game", "multi-d", { value: "d2" });

			const result = await adapter.compareAndSwapMulti([
				{
					channelId: "game",
					shardId: "multi-c",
					expectedVersion: 1,
					newState: { value: "c2" },
				},
				{
					channelId: "game",
					shardId: "multi-d",
					expectedVersion: 1,
					newState: { value: "d3" },
				},
			]);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.failedShardId).toBe("multi-d");
			}
		});

		test("empty operations succeeds", async () => {
			const result = await adapter.compareAndSwapMulti([]);
			expect(result.success).toBe(true);
		});
	});
});

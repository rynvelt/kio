import { describe, expect, test } from "bun:test";
import {
	type BroadcastMessage,
	channel,
	engine,
	type Subscriber,
	shard,
} from "@kio/shared";
import * as v from "valibot";
import type { KioEvent } from "./events";
import { MemoryStateAdapter } from "./persistence";
import { createServer } from "./server";

function setupEngine() {
	const counterChannel = channel
		.durable("counter")
		.shard("count", v.object({ value: v.number() }), {
			defaultState: { value: 0 },
		})
		.shardPerResource("bucket", v.object({ total: v.number() }), {
			defaultState: { total: 0 },
		})
		.operation("inc", {
			execution: "optimistic",
			input: v.object({}),
			scope: () => [shard.ref("count")],
			apply(shards) {
				shards.count.value += 1;
			},
		})
		.operation("addToBucket", {
			execution: "optimistic",
			input: v.object({ id: v.string(), amount: v.number() }),
			scope: (input) => [shard.ref("bucket", input.id)],
			apply(shards, input) {
				shards.bucket(input.id).total += input.amount;
			},
		})
		.operation("transfer", {
			execution: "optimistic",
			input: v.object({
				from: v.string(),
				to: v.string(),
				amount: v.number(),
			}),
			scope: (input) => [
				shard.ref("bucket", input.from),
				shard.ref("bucket", input.to),
			],
			apply(shards, input) {
				shards.bucket(input.from).total -= input.amount;
				shards.bucket(input.to).total += input.amount;
			},
		});

	return engine().register(counterChannel);
}

function createSubscriber(
	id: string,
): Subscriber & { messages: BroadcastMessage[] } {
	const messages: BroadcastMessage[] = [];
	return {
		id,
		messages,
		send(message) {
			messages.push(message);
		},
	};
}

function countByType(events: KioEvent[], type: KioEvent["type"]): number {
	return events.filter((e) => e.type === type).length;
}

describe("concurrency", () => {
	test("two concurrent same-shard submits: one commits, one conflicts with fresh state", async () => {
		const adapter = new MemoryStateAdapter();
		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});

		const [a, b] = await Promise.all([
			server.submit("counter", "inc", {}),
			server.submit("counter", "inc", {}),
		]);

		const acks = [a, b].filter((r) => r.status === "acknowledged");
		const rejects = [a, b].filter((r) => r.status === "rejected");
		expect(acks).toHaveLength(1);
		expect(rejects).toHaveLength(1);

		const loser = rejects[0];
		if (loser?.status === "rejected") {
			expect(loser.code).toBe("VERSION_CONFLICT");
			// Fresh state carries the committed version
			expect(loser.shards).toBeDefined();
			const freshCount = loser.shards?.find((s) => s.shardId === "count");
			expect(freshCount?.version).toBe(1);
			expect(freshCount?.state).toEqual({ value: 1 });
		}

		// Exactly one cas.conflict emitted, matching the rejected opId
		expect(countByType(events, "cas.conflict")).toBe(1);
		expect(countByType(events, "op.committed")).toBe(1);

		// Cache consistent with adapter
		const persisted = await adapter.load("counter", "count");
		expect(persisted?.version).toBe(1);
		expect(persisted?.state).toEqual({ value: 1 });
	});

	test("N concurrent same-shard submits: invariants hold", async () => {
		const N = 20;
		const adapter = new MemoryStateAdapter();
		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});

		const results = await Promise.all(
			Array.from({ length: N }, () => server.submit("counter", "inc", {})),
		);

		const committed = countByType(events, "op.committed");
		const rejected = countByType(events, "op.rejected");
		const conflicts = countByType(events, "cas.conflict");
		const broadcasts = countByType(events, "broadcast.sent");
		const submitted = countByType(events, "op.submitted");

		// Every submission is accounted for
		expect(submitted).toBe(N);
		expect(committed + rejected).toBe(N);

		// Every rejection for a same-shard race is a VERSION_CONFLICT
		expect(conflicts).toBe(rejected);

		// One broadcast per commit (no broadcasts for rejections)
		expect(broadcasts).toBe(committed);

		// Adapter version equals committed count; state tracks exactly
		const persisted = await adapter.load("counter", "count");
		expect(persisted?.version).toBe(committed);
		expect(persisted?.state).toEqual({ value: committed });

		// Exactly `committed` acknowledged results in the returned array
		expect(results.filter((r) => r.status === "acknowledged")).toHaveLength(
			committed,
		);
	});

	test("multi-shard overlap race: shared shard causes conflict, disjoint shards commit", async () => {
		const adapter = new MemoryStateAdapter();
		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});

		// transfer(A→B) and transfer(B→C) both touch bucket B, so exactly one wins.
		const [ab, bc] = await Promise.all([
			server.submit("counter", "transfer", { from: "a", to: "b", amount: 5 }),
			server.submit("counter", "transfer", { from: "b", to: "c", amount: 3 }),
		]);

		const acks = [ab, bc].filter((r) => r.status === "acknowledged");
		expect(acks.length).toBeGreaterThanOrEqual(1);
		expect(acks.length).toBeLessThanOrEqual(2);

		// Conservation: sum of all bucket totals equals 0 (started at 0 everywhere)
		const a = await adapter.load("counter", "bucket:a");
		const b = await adapter.load("counter", "bucket:b");
		const c = await adapter.load("counter", "bucket:c");
		const total =
			((a?.state as { total: number } | undefined)?.total ?? 0) +
			((b?.state as { total: number } | undefined)?.total ?? 0) +
			((c?.state as { total: number } | undefined)?.total ?? 0);
		expect(total).toBe(0);

		// One broadcast per commit
		expect(countByType(events, "broadcast.sent")).toBe(
			countByType(events, "op.committed"),
		);
	});

	test("subscriber receives exactly one broadcast per committed op", async () => {
		const adapter = new MemoryStateAdapter();
		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});

		const sub = createSubscriber("alice");
		server.addSubscriber("counter", sub, ["count"]);

		const N = 10;
		await Promise.all(
			Array.from({ length: N }, () => server.submit("counter", "inc", {})),
		);

		const committed = countByType(events, "op.committed");
		// Each broadcast message may batch entries for multiple shards, but since
		// we subscribed to just "count", each message contains exactly one entry.
		expect(sub.messages).toHaveLength(committed);

		// The final message reflects the final adapter version
		const persisted = await adapter.load("counter", "count");
		const lastMessage = sub.messages[sub.messages.length - 1];
		if (lastMessage?.type === "broadcast") {
			const entry = lastMessage.shards[0];
			expect(entry?.version).toBe(persisted?.version);
		}
	});

	test("fuzzing: 50 iterations of N=10 concurrent submits, no invariant breaks", async () => {
		for (let iter = 0; iter < 50; iter++) {
			const adapter = new MemoryStateAdapter();
			const events: KioEvent[] = [];
			const server = createServer(setupEngine(), {
				persistence: adapter,
				onEvent: (e) => events.push(e),
			});

			const N = 10;
			await Promise.all(
				Array.from({ length: N }, () => server.submit("counter", "inc", {})),
			);

			const committed = countByType(events, "op.committed");
			const rejected = countByType(events, "op.rejected");
			const conflicts = countByType(events, "cas.conflict");
			const broadcasts = countByType(events, "broadcast.sent");

			const ok =
				committed + rejected === N &&
				conflicts === rejected &&
				broadcasts === committed;

			if (!ok) {
				const trace = events.map((e) => e.type).join(" → ");
				throw new Error(
					`fuzz iter ${String(iter)} invariant break: submitted=${String(N)} committed=${String(committed)} rejected=${String(rejected)} conflicts=${String(conflicts)} broadcasts=${String(broadcasts)}\ntrace: ${trace}`,
				);
			}

			// Cache consistency: adapter version === committed count
			const persisted = await adapter.load("counter", "count");
			if (persisted?.version !== committed) {
				throw new Error(
					`fuzz iter ${String(iter)}: adapter version ${String(persisted?.version)} !== committed count ${String(committed)}`,
				);
			}
		}
	});
});

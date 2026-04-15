import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { channel, shard } from "./index";

describe("channel builder runtime data", () => {
	test("collects shard definitions", () => {
		const ch = channel
			.durable("game")
			.shard("world", v.object({ stage: v.string() }))
			.shardPerResource("seat", v.object({ items: v.array(v.string()) }));

		const data = ch["~data"];
		expect(data.kind).toBe("durable");
		expect(data.name).toBe("game");
		expect(data.shardDefs.size).toBe(2);

		const world = data.shardDefs.get("world");
		expect(world?.kind).toBe("singleton");

		const seat = data.shardDefs.get("seat");
		expect(seat?.kind).toBe("perResource");
	});

	test("collects operation definitions", () => {
		const ch = channel
			.durable("game")
			.shardPerResource("seat", v.object({ items: v.array(v.string()) }))
			.operation("useItem", {
				execution: "optimistic",
				versionChecked: true,
				deduplicate: true,
				input: v.object({ seatId: v.string(), itemId: v.string() }),
				errors: v.picklist(["NOT_FOUND"]),
				scope: (input) => [shard.ref("seat", input.seatId)],
				apply(shards, input) {
					shards.seat(input.seatId);
				},
			});

		const data = ch["~data"];
		expect(data.operations.size).toBe(1);

		const op = data.operations.get("useItem");
		expect(op?.execution).toBe("optimistic");
		expect(op?.versionChecked).toBe(true);
		expect(op?.deduplicate).toBe(true);
		expect(op?.inputSchema).toBeDefined();
		expect(op?.errorsSchema).toBeDefined();
		expect(op?.apply).toBeFunction();
		expect(op?.scope).toBeFunction();
	});

	test("collects server impl definitions", () => {
		const ch = channel
			.durable("game")
			.shard("world", v.object({ stage: v.string() }))
			.operation("start", {
				execution: "confirmed",
				versionChecked: true,
				deduplicate: true,
				input: v.object({}),
				errors: v.picklist(["NOT_READY"]),
				scope: () => [shard.ref("world")],
			})
			.serverImpl("start", {
				validate(_shards, _input, _ctx, { reject }) {
					return reject("NOT_READY", "Game not ready");
				},
				apply(shards) {
					shards.world.stage = "PLAYING";
				},
			});

		const data = ch["~data"];
		expect(data.serverImpls.size).toBe(1);

		const impl = data.serverImpls.get("start");
		expect(impl?.validate).toBeFunction();
		expect(impl?.apply).toBeFunction();
		expect(impl?.compute).toBeUndefined();
	});

	test("collects client impl definitions", () => {
		const ch = channel
			.durable("game")
			.shardPerResource("seat", v.object({ items: v.array(v.string()) }))
			.operation("use", {
				execution: "optimistic",
				versionChecked: true,
				deduplicate: true,
				input: v.object({ seatId: v.string() }),
				scope: (input) => [shard.ref("seat", input.seatId)],
				apply() {},
			})
			.clientImpl("use", {
				canRetry: () => true,
			});

		const data = ch["~data"];
		expect(data.clientImpls.size).toBe(1);

		const impl = data.clientImpls.get("use");
		expect(impl?.canRetry).toBeFunction();
	});

	test("stores channel options", () => {
		const ch = channel.ephemeral("presence", {
			autoBroadcast: false,
			broadcastMode: "patch",
		});

		const data = ch["~data"];
		expect(data.kind).toBe("ephemeral");
		expect(data.options.autoBroadcast).toBe(false);
		expect(data.options.broadcastMode).toBe("patch");
	});

	test("stores defaultState on singleton shard", () => {
		const ch = channel
			.durable("game")
			.shard("world", v.object({ stage: v.string() }), {
				defaultState: { stage: "WAITING" },
			});

		const world = ch["~data"].shardDefs.get("world");
		expect(world?.defaultState).toEqual({ stage: "WAITING" });
	});

	test("stores defaultState value on per-resource shard", () => {
		const ch = channel
			.ephemeral("subscriptions")
			.shardPerResource(
				"subscription",
				v.object({ refs: v.array(v.string()) }),
				{ defaultState: { refs: [] } },
			);

		const sub = ch["~data"].shardDefs.get("subscription");
		expect(sub?.defaultState).toEqual({ refs: [] });
	});

	test("stores defaultState function on per-resource shard", () => {
		const init = (id: string) => ({ id, value: 0 });
		const ch = channel
			.durable("counters")
			.shardPerResource(
				"counter",
				v.object({ id: v.string(), value: v.number() }),
				{ defaultState: init },
			);

		const counter = ch["~data"].shardDefs.get("counter");
		expect(counter?.defaultState).toBe(init);
	});

	test("confirmed operation has no shared apply", () => {
		const ch = channel
			.durable("game")
			.shard("world", v.object({ stage: v.string() }))
			.operation("confirm", {
				execution: "confirmed",
				versionChecked: true,
				deduplicate: true,
				input: v.object({}),
				scope: () => [shard.ref("world")],
			});

		const op = ch["~data"].operations.get("confirm");
		expect(op?.apply).toBeUndefined();
	});
});

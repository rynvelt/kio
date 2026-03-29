import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ClientChannelEngine } from "./client-channel-engine";
import { createDirectTransport } from "./direct-transport";
import { channel, shard } from "./index";
import { expectToBeDefined } from "./test-helpers";
import type { ClientMessage } from "./transport";

function setupGameEngine() {
	const ch = channel
		.durable("game")
		.shard("world", v.object({ stage: v.string(), turn: v.number() }))
		.operation("advanceTurn", {
			execution: "optimistic",
			input: v.object({}),
			scope: () => [shard.ref("world")],
			apply(shards) {
				shards.world.turn += 1;
			},
		});

	const { client, server } = createDirectTransport();
	const engine = new ClientChannelEngine(ch["~data"], client);
	return { engine, client, server };
}

describe("ClientChannelEngine", () => {
	describe("state message handling", () => {
		test("creates ShardStore and applies initial state", () => {
			const { engine } = setupGameEngine();

			engine.handleStateMessage({
				type: "state",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 1,
						state: { stage: "PLAYING", turn: 0 },
					},
				],
			});

			const snap = engine.shardState("world");
			expect(snap.syncStatus).toBe("latest");
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 0 });
		});

		test("unknown shard returns unavailable", () => {
			const { engine } = setupGameEngine();
			const snap = engine.shardState("nonexistent");
			expect(snap.syncStatus).toBe("unavailable");
		});

		test("handles multiple shards in one message", () => {
			const { engine } = setupGameEngine();

			engine.handleStateMessage({
				type: "state",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 1,
						state: { stage: "PLAYING", turn: 0 },
					},
					{ shardId: "seat:1", version: 1, state: { items: [] } },
				],
			});

			expect(engine.shardState("world").syncStatus).toBe("latest");
			expect(engine.shardState("seat:1").syncStatus).toBe("latest");
		});
	});

	describe("broadcast message handling", () => {
		test("updates existing ShardStore", () => {
			const { engine } = setupGameEngine();

			// Initial state
			engine.handleStateMessage({
				type: "state",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 1,
						state: { stage: "PLAYING", turn: 0 },
					},
				],
			});

			// Broadcast update
			engine.handleBroadcastMessage({
				type: "broadcast",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 2,
						state: { stage: "PLAYING", turn: 1 },
					},
				],
			});

			const snap = engine.shardState("world");
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 1 });
		});

		test("ignores broadcast for unknown shard", () => {
			const { engine } = setupGameEngine();

			// No error thrown
			engine.handleBroadcastMessage({
				type: "broadcast",
				channelId: "game",
				kind: "durable",
				shards: [{ shardId: "nonexistent", version: 1, state: {} }],
			});
		});

		test("notifies shard subscribers on broadcast", () => {
			const { engine } = setupGameEngine();

			engine.handleStateMessage({
				type: "state",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 1,
						state: { stage: "PLAYING", turn: 0 },
					},
				],
			});

			let notified = false;
			engine.subscribeToShard("world", () => {
				notified = true;
			});

			engine.handleBroadcastMessage({
				type: "broadcast",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 2,
						state: { stage: "PLAYING", turn: 1 },
					},
				],
			});

			expect(notified).toBe(true);
		});
	});

	describe("submit", () => {
		test("sends submit message via transport", async () => {
			const { engine, server } = setupGameEngine();
			const received: ClientMessage[] = [];

			server.onMessage((_connId, msg) => received.push(msg));

			const promise = engine.submit("advanceTurn", {});

			expect(received).toHaveLength(1);
			const msg = received[0];
			expectToBeDefined(msg);
			expect(msg.type).toBe("submit");
			if (msg.type === "submit") {
				expect(msg.channelId).toBe("game");
				expect(msg.operationName).toBe("advanceTurn");
			}

			// Simulate server acknowledge
			engine.handleSubmitResponse({
				type: "acknowledge",
				opId: msg.type === "submit" ? msg.opId : "",
			});

			const result = await promise;
			expect(result.type).toBe("acknowledge");
		});

		test("resolves with reject on server rejection", async () => {
			const { engine, server } = setupGameEngine();
			const received: ClientMessage[] = [];

			server.onMessage((_connId, msg) => received.push(msg));

			const promise = engine.submit("advanceTurn", {});

			const msg = received[0];
			expectToBeDefined(msg);
			if (msg.type === "submit") {
				engine.handleSubmitResponse({
					type: "reject",
					opId: msg.opId,
					code: "UNAUTHORIZED",
					message: "Not allowed",
				});
			}

			const result = await promise;
			expect(result.type).toBe("reject");
			if (result.type === "reject") {
				expect(result.code).toBe("UNAUTHORIZED");
			}
		});

		test("generates unique opIds", async () => {
			const { engine, server } = setupGameEngine();
			const received: ClientMessage[] = [];

			server.onMessage((_connId, msg) => received.push(msg));

			engine.submit("advanceTurn", {});
			engine.submit("advanceTurn", {});

			expect(received).toHaveLength(2);
			const op1 = received[0];
			const op2 = received[1];
			expectToBeDefined(op1);
			expectToBeDefined(op2);
			if (op1.type === "submit" && op2.type === "submit") {
				expect(op1.opId).not.toBe(op2.opId);
			}
		});
	});
});

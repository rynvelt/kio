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

	describe("optimistic submit", () => {
		function setupWithState() {
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
				.operation("addItem", {
					execution: "optimistic",
					input: v.object({ seatId: v.string(), item: v.string() }),
					scope: (input) => [shard.ref("seat", input.seatId)],
					apply(shards, input) {
						shards.seat(input.seatId).items.push({
							id: input.item,
							name: input.item,
						});
					},
				});

			const { client, server } = createDirectTransport();
			const eng = new ClientChannelEngine(ch["~data"], client);

			// Register server handler so transport doesn't throw
			const sent: ClientMessage[] = [];
			server.onMessage((_connId, msg) => sent.push(msg));

			// Seed initial state
			eng.handleStateMessage({
				type: "state",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 1,
						state: { stage: "PLAYING", turn: 0 },
					},
					{
						shardId: "seat:1",
						version: 1,
						state: { items: [{ id: "sword", name: "Sword" }] },
					},
				],
			});

			return { engine: eng, sent, server };
		}

		test("shows predicted state immediately", () => {
			const { engine } = setupWithState();

			engine.submit("advanceTurn", {});

			const snap = engine.shardState("world");
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 1 });
			expect(snap.pending).toEqual({ operationName: "advanceTurn", input: {} });
		});

		test("prediction works for per-resource shards", () => {
			const { engine } = setupWithState();

			engine.submit("addItem", { seatId: "1", item: "shield" });

			const snap = engine.shardState("seat:1");
			expect(snap.state).toEqual({
				items: [
					{ id: "sword", name: "Sword" },
					{ id: "shield", name: "shield" },
				],
			});
		});

		test("blocks second submit on same shard", async () => {
			const { engine } = setupWithState();

			engine.submit("advanceTurn", {});
			const result = await engine.submit("advanceTurn", {});

			expect(result.type).toBe("reject");
			if (result.type === "reject") {
				expect(result.code).toBe("PENDING_OPERATION");
			}
		});

		test("broadcast from someone else drops prediction, keeps in-flight", () => {
			const { engine } = setupWithState();

			engine.submit("advanceTurn", {});
			expect(engine.shardState("world").state).toEqual({
				stage: "PLAYING",
				turn: 1,
			});

			// Someone else's broadcast
			engine.handleBroadcastMessage({
				type: "broadcast",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 2,
						state: { stage: "PLAYING", turn: 99 },
						causedBy: { opId: "other:0", operation: "x", actor: "bob" },
					},
				],
			});

			const snap = engine.shardState("world");
			// Prediction dropped — shows authoritative
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 99 });
			// in-flight still present (pending reflects it)
			expect(snap.pending).toEqual({ operationName: "advanceTurn", input: {} });
		});

		test("broadcast confirming our op clears in-flight", async () => {
			const { engine, sent } = setupWithState();

			const promise = engine.submit("advanceTurn", {});
			const msg = sent[0];
			expectToBeDefined(msg);
			const opId = msg.type === "submit" ? msg.opId : "";

			// Server broadcast confirms our operation
			engine.handleBroadcastMessage({
				type: "broadcast",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 2,
						state: { stage: "PLAYING", turn: 1 },
						causedBy: { opId, operation: "advanceTurn", actor: "alice" },
					},
				],
			});

			const snap = engine.shardState("world");
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 1 });
			expect(snap.pending).toBeNull();

			// Server acknowledge resolves promise
			engine.handleSubmitResponse({ type: "acknowledge", opId });
			const result = await promise;
			expect(result.type).toBe("acknowledge");
		});

		test("server reject clears in-flight, reverts to authoritative", async () => {
			const { engine, sent } = setupWithState();

			const promise = engine.submit("advanceTurn", {});
			const msg = sent[0];
			expectToBeDefined(msg);
			const opId = msg.type === "submit" ? msg.opId : "";

			engine.handleSubmitResponse({
				type: "reject",
				opId,
				code: "VERSION_CONFLICT",
				message: "conflict",
			});

			const result = await promise;
			expect(result.type).toBe("reject");

			const snap = engine.shardState("world");
			// Reverted to authoritative
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 0 });
			expect(snap.pending).toBeNull();
		});

		test("after in-flight clears, new submit is allowed", async () => {
			const { engine, sent } = setupWithState();

			const promise1 = engine.submit("advanceTurn", {});
			const msg1 = sent[0];
			expectToBeDefined(msg1);
			const opId1 = msg1.type === "submit" ? msg1.opId : "";

			// Confirm first operation
			engine.handleBroadcastMessage({
				type: "broadcast",
				channelId: "game",
				kind: "durable",
				shards: [
					{
						shardId: "world",
						version: 2,
						state: { stage: "PLAYING", turn: 1 },
						causedBy: {
							opId: opId1,
							operation: "advanceTurn",
							actor: "alice",
						},
					},
				],
			});
			engine.handleSubmitResponse({ type: "acknowledge", opId: opId1 });
			await promise1;

			// Second submit should work
			engine.submit("advanceTurn", {});
			const snap = engine.shardState("world");
			expect(snap.state).toEqual({ stage: "PLAYING", turn: 2 });
		});
		test("reject only clears in-flight on the correct shard", async () => {
			const { engine, sent } = setupWithState();

			// Submit on world shard
			const promise = engine.submit("advanceTurn", {});
			const msg = sent[0];
			expectToBeDefined(msg);
			const opId = msg.type === "submit" ? msg.opId : "";

			// Verify world has prediction, seat:1 does not
			expect(engine.shardState("world").pending).not.toBeNull();
			expect(engine.shardState("seat:1").pending).toBeNull();

			// Reject the world operation
			engine.handleSubmitResponse({
				type: "reject",
				opId,
				code: "VERSION_CONFLICT",
				message: "conflict",
			});
			await promise;

			// World cleared
			expect(engine.shardState("world").pending).toBeNull();
			expect(engine.shardState("world").state).toEqual({
				stage: "PLAYING",
				turn: 0,
			});

			// seat:1 unaffected — still shows its original state, no pending
			expect(engine.shardState("seat:1").pending).toBeNull();
			expect(engine.shardState("seat:1").state).toEqual({
				items: [{ id: "sword", name: "Sword" }],
			});
		});

		test("operations on different shards are independent", async () => {
			const { engine, sent } = setupWithState();

			// Submit on world
			const promise1 = engine.submit("advanceTurn", {});
			const msg1 = sent[0];
			expectToBeDefined(msg1);
			const opId1 = msg1.type === "submit" ? msg1.opId : "";

			// Submit on seat:1 — different shard, should not be blocked
			engine.submit("addItem", { seatId: "1", item: "shield" });

			// Both shards show predictions
			expect(engine.shardState("world").state).toEqual({
				stage: "PLAYING",
				turn: 1,
			});
			expect(engine.shardState("seat:1").state).toEqual({
				items: [
					{ id: "sword", name: "Sword" },
					{ id: "shield", name: "shield" },
				],
			});

			// Reject world — only world reverts
			engine.handleSubmitResponse({
				type: "reject",
				opId: opId1,
				code: "VERSION_CONFLICT",
				message: "conflict",
			});
			await promise1;

			expect(engine.shardState("world").state).toEqual({
				stage: "PLAYING",
				turn: 0,
			});
			// seat:1 still has its prediction
			expect(engine.shardState("seat:1").state).toEqual({
				items: [
					{ id: "sword", name: "Sword" },
					{ id: "shield", name: "shield" },
				],
			});
		});
	});
});

import { describe, expect, test } from "bun:test";
import {
	type BroadcastMessage,
	channel,
	engine,
	type Subscriber,
	shard,
} from "@kiojs/shared";
import {
	createDirectTransport,
	createTypedTestClient,
} from "@kiojs/shared/test";
import * as v from "valibot";
import type { KioEvent } from "./events";
import { MemoryStateAdapter } from "./persistence";
import { createServer } from "./server";

function setupEngine() {
	const gameChannel = channel
		.durable("game")
		.shard("world", v.object({ stage: v.string(), turn: v.number() }), {
			defaultState: { stage: "PLAYING", turn: 0 },
		})
		.operation("advanceTurn", {
			execution: "optimistic",
			input: v.object({}),
			scope: () => [shard.ref("world")],
			apply(shards) {
				shards.world.turn += 1;
			},
		})
		.operation("fail", {
			execution: "optimistic",
			input: v.object({ reason: v.string() }),
			errors: v.picklist(["BUSINESS_RULE"]),
			scope: () => [shard.ref("world")],
			apply() {},
		})
		.serverImpl("fail", {
			validate(_shards, _input, _ctx, { reject }) {
				return reject("BUSINESS_RULE", "bounced");
			},
		});

	return engine().register(gameChannel);
}

function createSubscriber(
	id: string,
): Subscriber & { messages: BroadcastMessage[] } {
	const messages: BroadcastMessage[] = [];
	return {
		id,
		messages,
		send(message: BroadcastMessage) {
			messages.push(message);
		},
	};
}

describe("onEvent observability", () => {
	test("happy path emits op.submitted → broadcast.sent → op.committed", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});
		server.addSubscriber("game", createSubscriber("alice"), ["world"]);

		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("acknowledged");

		// Commit fires before the broadcast manager fans out.
		const types = events.map((e) => e.type);
		expect(types).toEqual(["op.submitted", "op.committed", "broadcast.sent"]);

		const committed = events.find((e) => e.type === "op.committed");
		if (committed?.type === "op.committed") {
			expect(committed.operationName).toBe("advanceTurn");
			expect(committed.shardIds).toEqual(["world"]);
			expect(committed.durationMs).toBeGreaterThanOrEqual(0);
		}

		const broadcast = events.find((e) => e.type === "broadcast.sent");
		if (broadcast?.type === "broadcast.sent") {
			expect(broadcast.subscriberCount).toBe(1);
			expect(broadcast.shardCount).toBe(1);
			expect(broadcast.opId).toBeDefined();
		}
	});

	test("rejected op emits op.submitted → op.rejected (no broadcast, no commit)", async () => {
		// serverImpl.validate is skipped for server-as-actor, so we drive this
		// through the channel runtime directly with a client actorId.
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});

		const ch = server.getChannel("game");
		expect(ch).toBeDefined();
		if (!ch) return;
		await ch.submit({
			operationName: "fail",
			input: { reason: "nope" },
			actor: { actorId: "client:alice" },
			opId: "op-1",
		});

		const types = events.map((e) => e.type);
		expect(types).toEqual(["op.submitted", "op.rejected"]);

		const rejected = events.find((e) => e.type === "op.rejected");
		if (rejected?.type === "op.rejected") {
			expect(rejected.code).toBe("BUSINESS_RULE");
			expect(rejected.message).toBe("bounced");
		}
	});

	test("CAS conflict emits cas.conflict alongside op.rejected", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const events: KioEvent[] = [];
		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: (e) => events.push(e),
		});

		// Warm the server's cache by submitting once — adapter is now at v=2
		await server.submit("game", "advanceTurn", {});
		events.length = 0;

		// Concurrent writer bumps the shard to v=3 behind the server's back
		const swap = await adapter.compareAndSwap("game", "world", 2, {
			stage: "PLAYING",
			turn: 99,
		});
		expect(swap.success).toBe(true);

		// Next submit: server's cache still says v=2, adapter has v=3 → CAS fails
		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("rejected");

		const conflict = events.find((e) => e.type === "cas.conflict");
		expect(conflict).toBeDefined();
		if (conflict?.type === "cas.conflict") {
			expect(conflict.failedShardId).toBe("world");
			expect(conflict.expectedVersion).toBe(2);
			expect(conflict.currentVersion).toBe(3);
		}

		const rejected = events.find((e) => e.type === "op.rejected");
		if (rejected?.type === "op.rejected") {
			expect(rejected.code).toBe("VERSION_CONFLICT");
		}
	});

	test("connection.opened and connection.closed fire on transport connect/disconnect", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const {
			client: rawClient,
			server: serverTransport,
			connect,
			disconnect,
		} = createDirectTransport();
		const client = createTypedTestClient(rawClient);
		// Register a handler so the server's initial sends have somewhere to go.
		client.onMessage(() => {});

		const events: KioEvent[] = [];
		createServer(setupEngine(), {
			persistence: adapter,
			transport: serverTransport,
			onEvent: (e) => events.push(e),
		});

		// Full handshake: connect → server sends welcome → client replies with
		// versions → server sends ready + fires onConnect.
		connect({ actorId: "alice" });
		await new Promise((r) => setTimeout(r, 10));
		client.send({ type: "versions", shards: {} });
		await new Promise((r) => setTimeout(r, 10));

		disconnect("client closed");
		await new Promise((r) => setTimeout(r, 10));

		const opened = events.find((e) => e.type === "connection.opened");
		const closed = events.find((e) => e.type === "connection.closed");
		expect(opened).toBeDefined();
		expect(closed).toBeDefined();
		if (opened?.type === "connection.opened") {
			expect(opened.actor.actorId).toBe("alice");
		}
		if (closed?.type === "connection.closed") {
			expect(closed.reason).toBe("client closed");
		}
	});

	test("listener errors are isolated — throws do not fail the op", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupEngine(), {
			persistence: adapter,
			onEvent: () => {
				throw new Error("bad listener");
			},
		});

		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("acknowledged");

		const persisted = await adapter.load("game", "world");
		expect((persisted?.state as { turn: number }).turn).toBe(1);
	});
});

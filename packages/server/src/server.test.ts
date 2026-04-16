import { describe, expect, test } from "bun:test";
import {
	type BroadcastMessage,
	channel,
	engine,
	type ServerMessage,
	SUBSCRIPTIONS_CHANNEL_NAME,
	type Subscriber,
	shard,
} from "@kio/shared";
import {
	createDirectTransport,
	createTypedTestClient,
	expectToBeDefined,
} from "@kio/shared/test";
import * as v from "valibot";
import { MemoryStateAdapter } from "./persistence";
import { type AfterCommitErrorContext, createServer } from "./server";

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

function setupServerEngine() {
	const gameChannel = channel
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

	const presenceChannel = channel
		.ephemeral("presence", { autoBroadcast: false })
		.shardPerResource("player", v.object({ online: v.boolean() }))
		.operation("setOnline", {
			execution: "optimistic",
			versionChecked: false,
			deduplicate: false,
			input: v.object({ playerId: v.string() }),
			scope: (input) => [shard.ref("player", input.playerId)],
			apply(shards, input) {
				(shards.player(input.playerId) as { online: boolean }).online = true;
			},
		});

	const serverEngine = engine({
		subscriptions: { kind: "ephemeral" },
	})
		.register(gameChannel)
		.register(presenceChannel);

	return serverEngine;
}

describe("createServer", () => {
	test("server-as-actor submits operations", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("acknowledged");

		const persisted = await adapter.load("game", "world");
		expect((persisted?.state as { turn: number }).turn).toBe(1);
	});

	test("server-as-actor broadcasts to subscribers", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const sub = createSubscriber("alice");
		server.addSubscriber("game", sub, ["world"]);

		await server.submit("game", "advanceTurn", {});

		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.channelId).toBe("game");
	});

	test("broadcastDirtyShards flushes ephemeral channel", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.set("presence", "player:alice", { online: false });

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const sub = createSubscriber("bob");
		server.addSubscriber("presence", sub, ["player:alice"]);

		await server.submit("presence", "setOnline", {
			playerId: "alice",
		});

		// autoBroadcast: false — nothing sent yet
		expect(sub.messages).toHaveLength(0);

		server.broadcastDirtyShards("presence");

		expect(sub.messages).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		if (entry && "state" in entry) {
			expect((entry.state as { online: boolean }).online).toBe(true);
		}
	});

	test("server-as-actor skips authorize", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
			authorize: () => false,
		});

		// Server-as-actor should succeed even though authorize returns false
		const result = await server.submit("game", "advanceTurn", {});
		expect(result.status).toBe("acknowledged");
	});

	test("removeSubscriber stops broadcasts", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const sub = createSubscriber("alice");
		server.addSubscriber("game", sub, ["world"]);

		await server.submit("game", "advanceTurn", {});
		expect(sub.messages).toHaveLength(1);

		server.removeSubscriber("game", "alice");

		await server.submit("game", "advanceTurn", {});
		expect(sub.messages).toHaveLength(1);
	});

	test("multiple channels work independently", async () => {
		const adapter = new MemoryStateAdapter();
		await adapter.compareAndSwap("game", "world", 0, {
			stage: "PLAYING",
			turn: 0,
		});
		await adapter.set("presence", "player:alice", { online: false });

		const server = createServer(setupServerEngine(), {
			persistence: adapter,
		});

		const gameSub = createSubscriber("game-watcher");
		const presSub = createSubscriber("pres-watcher");
		server.addSubscriber("game", gameSub, ["world"]);
		server.addSubscriber("presence", presSub, ["player:alice"]);

		await server.submit("game", "advanceTurn", {});
		await server.submit("presence", "setOnline", { playerId: "alice" });

		// game is autoBroadcast — sent immediately
		expect(gameSub.messages).toHaveLength(1);

		// presence is manual — nothing yet
		expect(presSub.messages).toHaveLength(0);

		server.broadcastDirtyShards("presence");
		expect(presSub.messages).toHaveLength(1);
	});

	describe("transport wiring", () => {
		test("client submit via transport returns acknowledge", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client: rawClient,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			const client = createTypedTestClient(rawClient);
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [{ channelId: "game", shardId: "world" }],
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			// Complete handshake
			connect({ actorId: "test-player" });
			await new Promise((r) => setTimeout(r, 10));
			client.send({ type: "versions", shards: {} });

			const handshakeCount = received.length;

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: {},
				opId: "op-1",
			});

			await new Promise((r) => setTimeout(r, 10));

			const newMessages = received.slice(handshakeCount);
			const ack = newMessages.find((m) => m.type === "acknowledge");
			expectToBeDefined(ack);
			if (ack.type === "acknowledge") {
				expect(ack.opId).toBe("op-1");
			}
		});

		test("client submit via transport returns reject for bad input", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const { client: rawClient, server: serverTransport } =
				createDirectTransport();
			const client = createTypedTestClient(rawClient);
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: "invalid",
				opId: "op-2",
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(received).toHaveLength(1);
			expectToBeDefined(received[0]);
			expect(received[0].type).toBe("reject");
		});

		test("transport subscriber receives broadcasts", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client: rawClient,
				server: serverTransport,
				connectionId,
			} = createDirectTransport();
			const client = createTypedTestClient(rawClient);
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			server.addTransportSubscriber("game", connectionId, ["world"]);

			await server.submit("game", "advanceTurn", {});

			const broadcasts = received.filter((m) => m.type === "broadcast");
			expect(broadcasts).toHaveLength(1);
			const bc = broadcasts[0];
			expectToBeDefined(bc);
			if (bc.type === "broadcast") {
				expect(bc.channelId).toBe("game");
				expect(bc.shards).toHaveLength(1);
			}
		});

		test("transport rejects unknown channel", async () => {
			const { client: rawClient, server: serverTransport } =
				createDirectTransport();
			const client = createTypedTestClient(rawClient);
			createServer(setupServerEngine(), {
				persistence: new MemoryStateAdapter(),
				transport: serverTransport,
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			client.send({
				type: "submit",
				channelId: "nonexistent",
				operationName: "op",
				input: {},
				opId: "op-3",
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(received).toHaveLength(1);
			const reject = received[0];
			expectToBeDefined(reject);
			expect(reject.type).toBe("reject");
			if (reject.type === "reject") {
				expect(reject.code).toBe("INVALID_CHANNEL");
			}
		});
	});

	describe("connection handshake", () => {
		test("connect sends server versions, client responds, gets state + ready", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client: rawClient,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			const client = createTypedTestClient(rawClient);
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [{ channelId: "game", shardId: "world" }],
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			connect();
			await new Promise((r) => setTimeout(r, 10));

			// Step 1: server sends welcome with actor + versions
			const welcome = received.find((m) => m.type === "welcome");
			expectToBeDefined(welcome);
			if (welcome.type === "welcome") {
				expect(welcome.shards.world).toBe(1);
				expect(welcome.actor).toBeDefined();
			}

			// Step 2: client responds with its versions (empty = first connect)
			client.send({ type: "versions", shards: {} });

			// Assert on what matters: game state was delivered, handshake
			// completed. The subscription shard delivers too but it's not
			// what this test is about.
			const gameState = received.find(
				(m) => m.type === "state" && m.channelId === "game",
			);
			expectToBeDefined(gameState);
			if (gameState.type === "state") {
				const entry = gameState.shards.find((s) => s.shardId === "world");
				expectToBeDefined(entry);
				if ("state" in entry) {
					expect(entry.state).toEqual({ stage: "PLAYING", turn: 0 });
				}
			}
			expect(received.some((m) => m.type === "ready")).toBe(true);
		});

		test("client with up-to-date version receives no state for that shard", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client: rawClient,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			const client = createTypedTestClient(rawClient);
			createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [{ channelId: "game", shardId: "world" }],
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			connect();
			await new Promise((r) => setTimeout(r, 10));

			// Client reports already having game's world at version 1.
			client.send({ type: "versions", shards: { world: 1 } });

			// Intent: the server does not re-send state for the shard the
			// client already has. Other shards (e.g. the auto-appended
			// subscription shard) may still flow — not our concern here.
			const gameStateSent = received.some(
				(m) => m.type === "state" && m.channelId === "game",
			);
			expect(gameStateSent).toBe(false);
			expect(received.some((m) => m.type === "ready")).toBe(true);
		});

		test("after handshake, subscriber receives future broadcasts", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const {
				client: rawClient,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			const client = createTypedTestClient(rawClient);
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				defaultSubscriptions: () => [{ channelId: "game", shardId: "world" }],
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			// Complete handshake
			connect();
			await new Promise((r) => setTimeout(r, 10));
			client.send({ type: "versions", shards: {} });

			const handshakeCount = received.length;

			// Server submits — should broadcast to connected client
			await server.submit("game", "advanceTurn", {});

			const newMessages = received.slice(handshakeCount);
			const broadcasts = newMessages.filter((m) => m.type === "broadcast");
			expect(broadcasts).toHaveLength(1);
		});
	});

	describe("type + runtime safety", () => {
		test("rejects invalid channel name", async () => {
			const server = createServer(setupServerEngine(), {
				persistence: new MemoryStateAdapter(),
			});

			// @ts-expect-error: "nonexistent" is not a valid channel
			const promise = server.submit("nonexistent", "advanceTurn", {});
			await expect(promise).rejects.toThrow(
				'Channel "nonexistent" is not registered',
			);
		});

		test("rejects invalid operation name", async () => {
			const adapter = new MemoryStateAdapter();
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});

			const server = createServer(setupServerEngine(), {
				persistence: adapter,
			});

			// @ts-expect-error: "nonexistent" is not a valid operation on "game"
			const result = await server.submit("game", "nonexistent", {});
			expect(result.status).toBe("rejected");
		});

		test("rejects invalid channel for broadcastDirtyShards", () => {
			const server = createServer(setupServerEngine(), {
				persistence: new MemoryStateAdapter(),
			});

			expect(() => {
				// @ts-expect-error: "nonexistent" is not a valid channel
				server.broadcastDirtyShards("nonexistent");
			}).toThrow('Channel "nonexistent" is not registered');
		});
	});

	describe("afterCommit (fire-and-forget)", () => {
		async function seedGame(adapter: MemoryStateAdapter) {
			await adapter.compareAndSwap("game", "world", 0, {
				stage: "PLAYING",
				turn: 0,
			});
		}

		test("hook throw does not affect acknowledge status (server path)", async () => {
			const adapter = new MemoryStateAdapter();
			await seedGame(adapter);

			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				onAfterCommitError: () => {},
			});
			server.afterCommit("game", "advanceTurn", () => {
				throw new Error("hook fail");
			});

			const result = await server.submit("game", "advanceTurn", {});
			expect(result.status).toBe("acknowledged");
		});

		test("hook throw routes to onAfterCommitError with context", async () => {
			const adapter = new MemoryStateAdapter();
			await seedGame(adapter);

			const errors: Array<{
				error: unknown;
				ctx: AfterCommitErrorContext;
			}> = [];
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				onAfterCommitError: (error, ctx) => errors.push({ error, ctx }),
			});
			server.afterCommit("game", "advanceTurn", () => {
				throw new Error("hook fail");
			});

			await server.submit("game", "advanceTurn", {});
			// Hook is fire-and-forget; drain microtasks
			await new Promise((r) => setTimeout(r, 0));

			expect(errors).toHaveLength(1);
			expect((errors[0]?.error as Error).message).toBe("hook fail");
			expect(errors[0]?.ctx.channelName).toBe("game");
			expect(errors[0]?.ctx.operationName).toBe("advanceTurn");
			expect(errors[0]?.ctx.input).toEqual({});
			expect(errors[0]?.ctx.actor.actorId).toBe("__kio:server__");
			expect(errors[0]?.ctx.opId).toMatch(/^server:/);
		});

		test("Server.submit does not await the hook's async work", async () => {
			const adapter = new MemoryStateAdapter();
			await seedGame(adapter);

			let hookFinished = false;
			let resolveHook!: () => void;
			const hookFinishedSignal = new Promise<void>((r) => {
				resolveHook = r;
			});

			const server = createServer(setupServerEngine(), {
				persistence: adapter,
			});
			server.afterCommit("game", "advanceTurn", async () => {
				await new Promise((r) => setTimeout(r, 20));
				hookFinished = true;
				resolveHook();
			});

			await server.submit("game", "advanceTurn", {});
			expect(hookFinished).toBe(false);

			await hookFinishedSignal;
			expect(hookFinished).toBe(true);
		});

		test("depth-limit error is reported via onAfterCommitError, not thrown from Server.submit", async () => {
			const adapter = new MemoryStateAdapter();
			await seedGame(adapter);

			const errors: Array<{
				error: unknown;
				ctx: AfterCommitErrorContext;
			}> = [];
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				onAfterCommitError: (error, ctx) => errors.push({ error, ctx }),
			});
			// Infinite self-chain
			server.afterCommit("game", "advanceTurn", async ({ submit }) => {
				await submit("game", "advanceTurn", {});
			});

			// Should resolve normally; depth limit surfaces as an async error
			const result = await server.submit("game", "advanceTurn", {});
			expect(result.status).toBe("acknowledged");

			// Wait long enough for the chain to unwind to the depth limit
			await new Promise((r) => setTimeout(r, 50));

			const depthErr = errors.find((e) =>
				(e.error as Error).message?.includes("depth limit"),
			);
			expect(depthErr).toBeDefined();
		});

		test("client path: hook throw does not affect acknowledge, routes to onAfterCommitError", async () => {
			const adapter = new MemoryStateAdapter();
			await seedGame(adapter);

			const errors: Array<{
				error: unknown;
				ctx: AfterCommitErrorContext;
			}> = [];
			const {
				client: rawClient,
				server: serverTransport,
				connect,
			} = createDirectTransport();
			const client = createTypedTestClient(rawClient);
			const server = createServer(setupServerEngine(), {
				persistence: adapter,
				transport: serverTransport,
				onAfterCommitError: (error, ctx) => errors.push({ error, ctx }),
			});
			server.afterCommit("game", "advanceTurn", () => {
				throw new Error("hook fail");
			});

			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));

			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 10));
			client.send({ type: "versions", shards: {} });

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: {},
				opId: "op-1",
			});

			await new Promise((r) => setTimeout(r, 10));

			const ack = received.find((m) => m.type === "acknowledge");
			expectToBeDefined(ack);
			if (ack.type === "acknowledge") {
				expect(ack.opId).toBe("op-1");
			}
			expect(errors).toHaveLength(1);
			expect(errors[0]?.ctx.opId).toBe("op-1");
			expect(errors[0]?.ctx.channelName).toBe("game");
		});
	});

	describe("subscriptions config", () => {
		// The subscriptions channel is hidden from the consumer's TChannels —
		// the tests cast through `any` to introspect the internal runtime map.
		// biome-ignore lint/suspicious/noExplicitAny: test-time introspection
		type AnyServer = { getChannel(name: string): any };

		async function readSubscriptionShard(
			anyServer: AnyServer,
			actorId: string,
		) {
			const subsRuntime = anyServer.getChannel(SUBSCRIPTIONS_CHANNEL_NAME);
			const loaded = (await subsRuntime?.loadShardStates?.([
				`subscription:${actorId}`,
			])) as
				| Map<
						string,
						{
							state: { refs: Array<{ channelId: string; shardId: string }> };
						}
				  >
				| undefined;
			return loaded?.get(`subscription:${actorId}`)?.state;
		}

		test("engine without subscriptions config: built-in channel not registered", () => {
			const appEngine = engine().register(
				channel.durable("game").shard("world", v.object({ turn: v.number() })),
			);
			const server = createServer(appEngine, {
				persistence: new MemoryStateAdapter(),
			}) as unknown as AnyServer;

			expect(server.getChannel("game")).toBeDefined();
			expect(server.getChannel(SUBSCRIPTIONS_CHANNEL_NAME)).toBeUndefined();
		});

		test("engine with ephemeral subscriptions: built-in channel is registered", () => {
			const appEngine = engine({
				subscriptions: { kind: "ephemeral" },
			}).register(
				channel.durable("game").shard("world", v.object({ turn: v.number() })),
			);
			const server = createServer(appEngine, {
				persistence: new MemoryStateAdapter(),
			}) as unknown as AnyServer;

			expect(server.getChannel("game")).toBeDefined();
			const subsRuntime = server.getChannel(SUBSCRIPTIONS_CHANNEL_NAME);
			expect(subsRuntime).toBeDefined();
			expect(subsRuntime?.kind).toBe("ephemeral");
		});

		test("engine with durable subscriptions: built-in channel is durable", () => {
			const appEngine = engine({ subscriptions: { kind: "durable" } });
			const server = createServer(appEngine, {
				persistence: new MemoryStateAdapter(),
			}) as unknown as AnyServer;
			expect(server.getChannel(SUBSCRIPTIONS_CHANNEL_NAME)?.kind).toBe(
				"durable",
			);
		});

		test("grantSubscription adds the ref to the actor's subscription shard", async () => {
			const appEngine = engine({ subscriptions: { kind: "ephemeral" } });
			const server = createServer(appEngine, {
				persistence: new MemoryStateAdapter(),
			});

			const result = await server.grantSubscription("bob", {
				channelId: "game",
				shardId: "world",
			});
			expect(result.status).toBe("acknowledged");

			const state = await readSubscriptionShard(
				server as unknown as AnyServer,
				"bob",
			);
			expect(state?.refs).toEqual([{ channelId: "game", shardId: "world" }]);
		});

		test("grantSubscription is idempotent", async () => {
			const appEngine = engine({ subscriptions: { kind: "ephemeral" } });
			const server = createServer(appEngine, {
				persistence: new MemoryStateAdapter(),
			});
			const ref = { channelId: "game", shardId: "world" };

			await server.grantSubscription("bob", ref);
			await server.grantSubscription("bob", ref);

			const state = await readSubscriptionShard(
				server as unknown as AnyServer,
				"bob",
			);
			expect(state?.refs).toHaveLength(1);
		});

		test("revokeSubscription removes an existing ref", async () => {
			const appEngine = engine({ subscriptions: { kind: "ephemeral" } });
			const server = createServer(appEngine, {
				persistence: new MemoryStateAdapter(),
			});
			const refA = { channelId: "game", shardId: "world" };
			const refB = { channelId: "presence", shardId: "player:alice" };

			await server.grantSubscription("bob", refA);
			await server.grantSubscription("bob", refB);
			await server.revokeSubscription("bob", refA);

			const state = await readSubscriptionShard(
				server as unknown as AnyServer,
				"bob",
			);
			expect(state?.refs).toEqual([refB]);
		});
	});
});

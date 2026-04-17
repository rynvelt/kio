import { describe, expect, test } from "bun:test";
import {
	type BaseActor,
	channel,
	type ServerMessage,
	shard,
} from "@kiojs/shared";
import {
	createDirectTransport,
	createTypedTestClient,
	expectToBeDefined,
	jsonCodec,
} from "@kiojs/shared/test";
import * as v from "valibot";
import { ActorRegistry } from "./actor-registry";
import { ChannelRuntime } from "./channel-runtime";
import { MemoryStateAdapter } from "./persistence";
import type { PipelineResult, Submission } from "./pipeline";
import { TransportProtocol } from "./transport-protocol";

function setupGameChannel() {
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
	return ch["~data"];
}

function setupPresenceChannel() {
	const ch = channel
		.ephemeral("presence")
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
	return ch["~data"];
}

async function seedGame(adapter: MemoryStateAdapter): Promise<void> {
	await adapter.compareAndSwap("game", "world", 0, {
		stage: "PLAYING",
		turn: 0,
	});
}

/** Build a real TransportProtocol against a direct transport + real channels. */
function setupProtocol(
	opts: {
		actorSchema?: v.GenericSchema<BaseActor>;
		/**
		 * Neutral handshake callback: given the actor, return the shards the
		 * connection should subscribe to (grouped by channel). The real server
		 * delegates this to SubscriptionResolver; tests can supply a simple
		 * map directly.
		 */
		resolveInitialShards?: (
			actor: BaseActor,
		) => Promise<ReadonlyMap<string, readonly string[]>>;
		onConnect?: (actor: BaseActor) => void;
		onDisconnect?: (actor: BaseActor, reason: string) => void;
		submitOverride?: (
			channelName: string,
			submission: Submission,
		) => Promise<PipelineResult>;
		afterCommitCalls?: Array<{
			channelName: string;
			actor: BaseActor;
			input: unknown;
			opId: string;
		}>;
	} = {},
) {
	const {
		client: rawClient,
		server,
		connect,
		disconnect,
		connectionId,
	} = createDirectTransport();
	const client = createTypedTestClient(rawClient);
	const adapter = new MemoryStateAdapter();
	const gameRuntime = new ChannelRuntime(setupGameChannel(), adapter);
	const presenceRuntime = new ChannelRuntime(setupPresenceChannel(), adapter);
	const channels = new Map<string, ChannelRuntime>([
		["game", gameRuntime],
		["presence", presenceRuntime],
	]);
	const actorRegistry = new ActorRegistry<BaseActor>(opts.actorSchema);
	const submitCalls: Array<{ channelName: string; submission: Submission }> =
		[];

	const defaultSubmit = async (
		channelName: string,
		submission: Submission,
	): Promise<PipelineResult> => {
		submitCalls.push({ channelName, submission });
		const ch = channels.get(channelName);
		if (!ch) throw new Error(`unknown channel ${channelName}`);
		return ch.submit(submission);
	};

	const protocol = new TransportProtocol<BaseActor>({
		transport: server,
		codec: jsonCodec,
		actorRegistry,
		channels,
		submit: opts.submitOverride ?? defaultSubmit,
		runAfterCommit: (channelName, _result, actor, input) => {
			const latest = submitCalls[submitCalls.length - 1];
			opts.afterCommitCalls?.push({
				channelName,
				actor,
				input,
				opId: latest?.submission.opId ?? "",
			});
		},
		resolveInitialShards: opts.resolveInitialShards ?? (async () => new Map()),
		onConnect: opts.onConnect,
		onDisconnect: opts.onDisconnect,
	});

	return {
		protocol,
		client,
		server,
		connect,
		disconnect,
		connectionId,
		adapter,
		channels,
		gameRuntime,
		presenceRuntime,
		submitCalls,
	};
}

function collectClientMessages(client: {
	onMessage(handler: (msg: ServerMessage) => void): void;
}): ServerMessage[] {
	const messages: ServerMessage[] = [];
	client.onMessage((msg) => messages.push(msg));
	return messages;
}

describe("TransportProtocol", () => {
	describe("handshake step 1 (connect → welcome)", () => {
		test("welcome contains validated actor and server shard versions", async () => {
			const { client, connect, adapter } = setupProtocol({
				resolveInitialShards: async () => new Map([["game", ["world"]]]),
			});
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));

			expect(messages).toHaveLength(1);
			const welcome = messages[0];
			expectToBeDefined(welcome);
			expect(welcome.type).toBe("welcome");
			if (welcome.type === "welcome") {
				expect(welcome.actor).toEqual({ actorId: "alice" });
				expect(welcome.shards).toEqual({ world: 1 });
			}
		});

		test("INVALID_ACTOR + close when actor fails schema validation", async () => {
			const { client, connect } = setupProtocol({
				actorSchema: v.object({ actorId: v.string() }),
			});

			const messages = collectClientMessages(client);
			let disconnectedReason: string | undefined;
			client.onDisconnected((r) => {
				disconnectedReason = r;
			});

			connect({ notAnActor: true });
			await new Promise((r) => setTimeout(r, 0));

			expect(messages).toHaveLength(1);
			const err = messages[0];
			expectToBeDefined(err);
			expect(err.type).toBe("error");
			if (err.type === "error") {
				expect(err.code).toBe("INVALID_ACTOR");
			}
			expect(disconnectedReason).toBe("closed by server");
		});

		test("welcome has empty shards when resolveInitialShards returns empty", async () => {
			const { client, connect, adapter } = setupProtocol();
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "bob" });
			await new Promise((r) => setTimeout(r, 0));

			const welcome = messages[0];
			expectToBeDefined(welcome);
			if (welcome.type === "welcome") {
				expect(welcome.shards).toEqual({});
			}
		});
	});

	describe("handshake step 2 (versions → state + ready)", () => {
		test("state sent only for stale shards, then ready", async () => {
			const { client, connect, adapter } = setupProtocol({
				resolveInitialShards: async () => new Map([["game", ["world"]]]),
			});
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			expect(messages).toHaveLength(3);
			const stateMsg = messages[1];
			expectToBeDefined(stateMsg);
			expect(stateMsg.type).toBe("state");
			if (stateMsg.type === "state") {
				expect(stateMsg.channelId).toBe("game");
				expect(stateMsg.shards).toHaveLength(1);
			}
			const ready = messages[2];
			expectToBeDefined(ready);
			expect(ready.type).toBe("ready");
		});

		test("up-to-date client receives only ready", async () => {
			const { client, connect, adapter } = setupProtocol({
				resolveInitialShards: async () => new Map([["game", ["world"]]]),
			});
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: { world: 1 } });

			expect(messages).toHaveLength(2);
			const ready = messages[1];
			expectToBeDefined(ready);
			expect(ready.type).toBe("ready");
		});

		test("onConnect fires after ready with the validated actor", async () => {
			const order: string[] = [];
			const onConnect = (actor: BaseActor) => {
				order.push(`connect:${actor.actorId}`);
			};
			const { client, connect, adapter } = setupProtocol({
				resolveInitialShards: async () => new Map([["game", ["world"]]]),
				onConnect,
			});
			await seedGame(adapter);

			client.onMessage((msg) => {
				if (msg.type === "ready") order.push("ready");
			});
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			expect(order).toEqual(["ready", "connect:alice"]);
		});

		test("versions message before connect is ignored (no pending handshake)", async () => {
			const { client } = setupProtocol();
			const messages = collectClientMessages(client);

			client.send({ type: "versions", shards: {} });
			await new Promise((r) => setTimeout(r, 0));

			expect(messages).toHaveLength(0);
		});
	});

	describe("submit routing", () => {
		test("acknowledges successful submit and calls submit seam with actor + opId", async () => {
			const { client, connect, adapter, submitCalls } = setupProtocol();
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: {},
				opId: "op-1",
			});
			await new Promise((r) => setTimeout(r, 0));

			const ack = messages.find((m) => m.type === "acknowledge");
			expectToBeDefined(ack);
			if (ack.type === "acknowledge") {
				expect(ack.opId).toBe("op-1");
			}
			expect(submitCalls).toHaveLength(1);
			expect(submitCalls[0]?.channelName).toBe("game");
			expect(submitCalls[0]?.submission.actor).toEqual({ actorId: "alice" });
			expect(submitCalls[0]?.submission.opId).toBe("op-1");
			expect(submitCalls[0]?.submission.operationName).toBe("advanceTurn");
		});

		test("fires afterCommit after sending acknowledge", async () => {
			const afterCommitCalls: Array<{
				channelName: string;
				actor: BaseActor;
				input: unknown;
				opId: string;
			}> = [];
			const order: string[] = [];

			const { client, connect, adapter } = setupProtocol({ afterCommitCalls });
			await seedGame(adapter);

			client.onMessage((msg) => {
				if (msg.type === "acknowledge") order.push("ack");
			});

			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: { hint: 1 },
				opId: "op-1",
			});
			await new Promise((r) => setTimeout(r, 0));

			expect(afterCommitCalls).toHaveLength(1);
			expect(afterCommitCalls[0]?.channelName).toBe("game");
			expect(afterCommitCalls[0]?.actor).toEqual({ actorId: "alice" });
			expect(afterCommitCalls[0]?.input).toEqual({ hint: 1 });
			expect(afterCommitCalls[0]?.opId).toBe("op-1");

			expect(order[0]).toBe("ack");
		});

		test("rejects with result code when pipeline rejects", async () => {
			const rejectResult: PipelineResult = {
				status: "rejected",
				code: "VERSION_CONFLICT",
				message: "boom",
				shards: [{ shardId: "world", version: 99, state: {} }],
			};
			const afterCommitCalls: Array<{
				channelName: string;
				actor: BaseActor;
				input: unknown;
				opId: string;
			}> = [];

			const { client, connect } = setupProtocol({
				submitOverride: async () => rejectResult,
				afterCommitCalls,
			});

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: {},
				opId: "op-2",
			});
			await new Promise((r) => setTimeout(r, 0));

			const reject = messages.find((m) => m.type === "reject");
			expectToBeDefined(reject);
			if (reject.type === "reject") {
				expect(reject.code).toBe("VERSION_CONFLICT");
				expect(reject.message).toBe("boom");
				expect(reject.shards).toHaveLength(1);
			}
			expect(afterCommitCalls).toHaveLength(0);
		});

		test("INVALID_CHANNEL reject for unknown channel, submit seam not called", async () => {
			const { client, connect, submitCalls } = setupProtocol();

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));

			client.send({
				type: "submit",
				channelId: "missing",
				operationName: "op",
				input: {},
				opId: "op-3",
			});
			await new Promise((r) => setTimeout(r, 0));

			const reject = messages.find((m) => m.type === "reject");
			expectToBeDefined(reject);
			if (reject.type === "reject") {
				expect(reject.code).toBe("INVALID_CHANNEL");
				expect(reject.opId).toBe("op-3");
			}
			expect(submitCalls).toHaveLength(0);
		});

		test("INTERNAL_ERROR reject when connection has no actor", async () => {
			const { client } = setupProtocol();

			const messages = collectClientMessages(client);

			// Submit without connecting → no actor registered
			client.send({
				type: "submit",
				channelId: "game",
				operationName: "advanceTurn",
				input: {},
				opId: "op-4",
			});
			await new Promise((r) => setTimeout(r, 0));

			const reject = messages.find((m) => m.type === "reject");
			expectToBeDefined(reject);
			if (reject.type === "reject") {
				expect(reject.code).toBe("INTERNAL_ERROR");
				expect(reject.opId).toBe("op-4");
			}
		});
	});

	describe("disconnection", () => {
		test("actor removed, channel subscribers cleaned, onDisconnect fired", async () => {
			const disconnects: Array<{ actor: BaseActor; reason: string }> = [];
			const { client, connect, disconnect, adapter, gameRuntime, protocol } =
				setupProtocol({
					resolveInitialShards: async () => new Map([["game", ["world"]]]),
					onDisconnect: (actor, reason) => {
						disconnects.push({ actor, reason });
					},
				});
			await seedGame(adapter);

			collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			// Track calls to ch.removeSubscriber
			const removed: string[] = [];
			const originalRemove = gameRuntime.removeSubscriber.bind(gameRuntime);
			gameRuntime.removeSubscriber = (id: string) => {
				removed.push(id);
				originalRemove(id);
			};
			// suppress unused lint
			void protocol;

			disconnect("client gone");
			await new Promise((r) => setTimeout(r, 0));

			expect(disconnects).toEqual([
				{ actor: { actorId: "alice" }, reason: "client gone" },
			]);
			expect(removed).toContain("direct");
		});

		test("cleans pending handshake if disconnect happens before versions", async () => {
			const connects: BaseActor[] = [];
			const disconnects: Array<{ actor: BaseActor; reason: string }> = [];
			const { client, connect, disconnect, adapter } = setupProtocol({
				resolveInitialShards: async () => new Map([["game", ["world"]]]),
				onConnect: (a) => connects.push(a),
				onDisconnect: (a, r) => disconnects.push({ actor: a, reason: r }),
			});
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));

			// disconnect before sending versions
			disconnect("drop");
			await new Promise((r) => setTimeout(r, 0));

			// onConnect never fires (step 2 never ran)
			expect(connects).toHaveLength(0);
			// onDisconnect still fires
			expect(disconnects).toHaveLength(1);

			// Sending versions now does nothing (pending cleared)
			const beforeCount = messages.length;
			client.send({ type: "versions", shards: {} });
			await new Promise((r) => setTimeout(r, 0));
			expect(messages).toHaveLength(beforeCount);
		});

		test("disconnect without prior connect is a no-op", async () => {
			const disconnects: Array<{ actor: BaseActor; reason: string }> = [];
			const { disconnect } = setupProtocol({
				onDisconnect: (a, r) => disconnects.push({ actor: a, reason: r }),
			});

			disconnect("never connected");
			await new Promise((r) => setTimeout(r, 0));

			expect(disconnects).toHaveLength(0);
		});
	});

	describe("transport subscriber management", () => {
		test("addTransportSubscriber subscribes connection to channel broadcasts", async () => {
			const { protocol, client, connect, adapter, gameRuntime, connectionId } =
				setupProtocol();
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			protocol.addTransportSubscriber("game", connectionId, ["world"]);

			await gameRuntime.submit({
				operationName: "advanceTurn",
				input: {},
				actor: { actorId: "server" },
				opId: "srv-1",
			});

			const broadcasts = messages.filter((m) => m.type === "broadcast");
			expect(broadcasts).toHaveLength(1);
			if (broadcasts[0]?.type === "broadcast") {
				expect(broadcasts[0].channelId).toBe("game");
			}
		});

		test("removeTransportSubscriber stops further broadcasts", async () => {
			const { protocol, client, connect, adapter, gameRuntime, connectionId } =
				setupProtocol();
			await seedGame(adapter);

			const messages = collectClientMessages(client);
			connect({ actorId: "alice" });
			await new Promise((r) => setTimeout(r, 0));
			client.send({ type: "versions", shards: {} });

			protocol.addTransportSubscriber("game", connectionId, ["world"]);
			await gameRuntime.submit({
				operationName: "advanceTurn",
				input: {},
				actor: { actorId: "server" },
				opId: "srv-1",
			});

			protocol.removeTransportSubscriber("game", connectionId);
			const countAfterRemove = messages.filter(
				(m) => m.type === "broadcast",
			).length;

			await gameRuntime.submit({
				operationName: "advanceTurn",
				input: {},
				actor: { actorId: "server" },
				opId: "srv-2",
			});

			const countAfterSecond = messages.filter(
				(m) => m.type === "broadcast",
			).length;
			expect(countAfterSecond).toBe(countAfterRemove);
		});

		test("addTransportSubscriber throws for unknown channel", () => {
			const { protocol } = setupProtocol();
			expect(() =>
				protocol.addTransportSubscriber("missing", "conn-1", []),
			).toThrow('Channel "missing" is not registered');
		});

		test("removeTransportSubscriber throws for unknown channel", () => {
			const { protocol } = setupProtocol();
			expect(() =>
				protocol.removeTransportSubscriber("missing", "conn-1"),
			).toThrow('Channel "missing" is not registered');
		});
	});
});

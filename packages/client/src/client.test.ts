import { describe, expect, test } from "bun:test";
import { type ClientMessage, channel, engine, shard } from "@kio/shared";
import {
	createDirectTransport,
	createTypedTestServer,
	expectToBeDefined,
} from "@kio/shared/test";
import * as v from "valibot";
import { createClient } from "./client";

function setupClientEngine() {
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

	return engine().register(gameChannel).register(presenceChannel);
}

describe("createClient", () => {
	test("routes state messages to correct channel engine", () => {
		const { client: transport, server: rawServer } = createDirectTransport();
		const server = createTypedTestServer(rawServer);
		const clientInstance = createClient(setupClientEngine(), {
			transport,
		});

		const captured: ClientMessage[] = [];
		server.onMessage((_id, msg) => captured.push(msg));

		// Simulate server sending state
		server.send("direct", {
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

		const snap = clientInstance.channel("game").shardState("world");
		expect(snap.syncStatus).toBe("latest");
		expect(snap.state).toEqual({ stage: "PLAYING", turn: 0 });
	});

	test("routes broadcast messages to correct channel engine", () => {
		const { client: transport, server: rawServer } = createDirectTransport();
		const server = createTypedTestServer(rawServer);
		const clientInstance = createClient(setupClientEngine(), {
			transport,
		});

		// Initial state
		server.send("direct", {
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
		server.send("direct", {
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

		const snap = clientInstance.channel("game").shardState("world");
		expect(snap.state).toEqual({ stage: "PLAYING", turn: 1 });
	});

	test("responds to server welcome with client versions", () => {
		const { client: transport, server: rawServer } = createDirectTransport();
		const server = createTypedTestServer(rawServer);
		createClient(setupClientEngine(), { transport });

		const captured: ClientMessage[] = [];
		server.onMessage((_id, msg) => captured.push(msg));

		// Server sends welcome
		server.send("direct", {
			type: "welcome",
			actor: { actorId: "player:alice" },
			shards: { world: 5 },
		});

		const versionsMsg = captured.find((m) => m.type === "versions");
		expectToBeDefined(versionsMsg);
		expect(versionsMsg.type).toBe("versions");
	});

	test("sets ready flag after ready message", () => {
		const { client: transport, server: rawServer } = createDirectTransport();
		const server = createTypedTestServer(rawServer);
		const clientInstance = createClient(setupClientEngine(), {
			transport,
		});

		expect(clientInstance.ready).toBe(false);

		server.send("direct", { type: "ready" });

		expect(clientInstance.ready).toBe(true);
	});

	test("submit routes through transport and resolves on acknowledge", async () => {
		const { client: transport, server: rawServer } = createDirectTransport();
		const server = createTypedTestServer(rawServer);
		const clientInstance = createClient(setupClientEngine(), {
			transport,
		});

		const captured: ClientMessage[] = [];
		server.onMessage((_id, msg) => captured.push(msg));

		// Set up initial state so engine has the channel
		server.send("direct", {
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

		const promise = clientInstance.channel("game").submit("advanceTurn", {});

		// Find the submit message
		const submitMsg = captured.find((m) => m.type === "submit");
		expectToBeDefined(submitMsg);
		if (submitMsg.type === "submit") {
			server.send("direct", {
				type: "acknowledge",
				opId: submitMsg.opId,
			});
		}

		const result = await promise;
		expect(result.status).toBe("acknowledged");
	});

	test("throws on unknown channel name", () => {
		const { client: transport } = createDirectTransport();
		const clientInstance = createClient(setupClientEngine(), {
			transport,
		});

		expect(() => {
			// @ts-expect-error: "nonexistent" is not a valid channel
			clientInstance.channel("nonexistent");
		}).toThrow('Channel "nonexistent" is not registered');
	});
});

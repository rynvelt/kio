import { describe, expect, test } from "bun:test";
import { channel, engine, type ServerMessage, shard } from "@kiojs/shared";
import {
	createDirectTransport,
	createTypedTestClient,
	expectToBeDefined,
} from "@kiojs/shared/test";
import * as v from "valibot";
import { MemoryStateAdapter } from "./persistence";
import { createServer } from "./server";

/**
 * Integration tests for SubscriptionSyncer — exercises the full
 * createServer path with a transport. The syncer runs as an internal
 * afterCommit handler; these tests verify the observable effects: that
 * a connected client receives (or stops receiving) broadcasts and state
 * messages after runtime grant/revoke.
 */

function setupServer() {
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
		});

	const appEngine = engine({ subscriptions: { kind: "ephemeral" } }).register(
		gameChannel,
	);

	const adapter = new MemoryStateAdapter();
	// Seed the game shard.
	adapter.compareAndSwap("game", "world", 0, { stage: "PLAYING", turn: 0 });

	const {
		client: rawClient,
		server: serverTransport,
		connect,
	} = createDirectTransport();
	const client = createTypedTestClient(rawClient);

	const server = createServer(appEngine, {
		persistence: adapter,
		transport: serverTransport,
		// No defaultSubscriptions — bob starts with nothing, we'll grant at runtime.
	});

	return { server, client, connect, adapter };
}

async function completeHandshake(
	client: ReturnType<typeof createTypedTestClient>,
	connect: (actor: { actorId: string }) => void,
	actorId: string,
): Promise<ServerMessage[]> {
	const received: ServerMessage[] = [];
	client.onMessage((m) => received.push(m));

	connect({ actorId });
	await tick();
	client.send({ type: "versions", shards: {} });
	await tick();

	return received;
}

function tick(ms = 20): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("SubscriptionSyncer (integration)", () => {
	test("runtime grant: connected client receives state message for newly-granted shard", async () => {
		const { server, client, connect } = setupServer();

		const received = await completeHandshake(client, connect, "bob");

		// Bob is connected but has no game subscriptions yet.
		// No game-state message in the handshake.
		const gameStateBefore = received.find(
			(m) => m.type === "state" && m.channelId === "game",
		);
		expect(gameStateBefore).toBeUndefined();

		// Grant bob access to game/world while connected.
		await server.grantSubscription("bob", {
			channelId: "game",
			shardId: "world",
		});
		await tick();

		// Bob should have received a point-to-point state message for game/world.
		const gameStateAfter = received.find(
			(m) => m.type === "state" && m.channelId === "game",
		);
		expectToBeDefined(gameStateAfter);
		if (gameStateAfter.type === "state") {
			const entry = gameStateAfter.shards.find((s) => s.shardId === "world");
			expectToBeDefined(entry);
			if ("state" in entry) {
				expect(entry.state).toEqual({ stage: "PLAYING", turn: 0 });
			}
		}
	});

	test("runtime grant: connected client receives future broadcasts for granted shard", async () => {
		const { server, client, connect } = setupServer();

		const received = await completeHandshake(client, connect, "bob");

		// Grant bob access to game/world.
		await server.grantSubscription("bob", {
			channelId: "game",
			shardId: "world",
		});
		await tick();

		const countBefore = received.length;

		// Advance the game. Bob should receive the broadcast.
		await server.submit("game", "advanceTurn", {});
		await tick();

		const newMessages = received.slice(countBefore);
		const broadcast = newMessages.find(
			(m) => m.type === "broadcast" && m.channelId === "game",
		);
		expectToBeDefined(broadcast);
	});

	test("runtime revoke: connected client stops receiving broadcasts", async () => {
		const { server, client, connect } = setupServer();

		// Connect bob with game/world via defaultSubscriptions-equivalent:
		// grant before connecting would mean the shard is there at connect time.
		// Instead, grant after connect so we control the flow.
		const received = await completeHandshake(client, connect, "bob");

		await server.grantSubscription("bob", {
			channelId: "game",
			shardId: "world",
		});
		await tick();

		// Verify bob receives broadcasts.
		const countAfterGrant = received.length;
		await server.submit("game", "advanceTurn", {});
		await tick();
		const broadcastsAfterGrant = received
			.slice(countAfterGrant)
			.filter((m) => m.type === "broadcast" && m.channelId === "game");
		expect(broadcastsAfterGrant.length).toBeGreaterThan(0);

		// Revoke bob's access.
		await server.revokeSubscription("bob", {
			channelId: "game",
			shardId: "world",
		});
		await tick();

		const countAfterRevoke = received.length;
		await server.submit("game", "advanceTurn", {});
		await tick();

		// Bob should NOT receive a game broadcast after revoke.
		const broadcastsAfterRevoke = received
			.slice(countAfterRevoke)
			.filter((m) => m.type === "broadcast" && m.channelId === "game");
		expect(broadcastsAfterRevoke).toHaveLength(0);
	});

	test("grant for disconnected actor is a no-op (shard persists for next connect)", async () => {
		const { server } = setupServer();

		// Nobody connected. Grant should succeed (shard update) but no state push.
		const result = await server.grantSubscription("ghost", {
			channelId: "game",
			shardId: "world",
		});
		expect(result.status).toBe("acknowledged");
		// No error, no crash — the grant landed in the shard for when ghost connects.
	});
});

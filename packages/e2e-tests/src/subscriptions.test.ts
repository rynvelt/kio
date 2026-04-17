import { describe, expect, test } from "bun:test";
import { createClient } from "@kiojs/client";
import { createServer, MemoryStateAdapter } from "@kiojs/server";
import {
	channel,
	engine,
	shard,
	type TypedSubscriptionRef,
} from "@kiojs/shared";
import { createDirectTransport } from "@kiojs/shared/test";
import * as v from "valibot";

const gameChannel = channel
	.durable("game")
	.shard("world", v.object({ stage: v.string(), turn: v.number() }), {
		defaultState: { stage: "PLAYING", turn: 0 },
	})
	.shardPerResource("room", v.object({ occupants: v.array(v.string()) }), {
		defaultState: { occupants: [] },
	})
	.operation("advanceTurn", {
		execution: "optimistic",
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply(shards) {
			shards.world.turn += 1;
		},
	})
	.operation("enter", {
		execution: "optimistic",
		input: v.object({ roomId: v.string(), who: v.string() }),
		scope: (input) => [shard.ref("room", input.roomId)],
		apply(shards, input) {
			shards.room(input.roomId).occupants.push(input.who);
		},
	});

const serverEngine = engine({
	subscriptions: { kind: "ephemeral" },
}).register(gameChannel);

const clientEngine = engine({
	subscriptions: { kind: "ephemeral" },
}).register(gameChannel);

type ServerChannels = { game: typeof gameChannel };
type ServerSubRef = TypedSubscriptionRef<ServerChannels>;

async function setup(opts: {
	defaultSubs?: (actor: { actorId: string }) => readonly ServerSubRef[];
	actorId?: string;
}) {
	const adapter = new MemoryStateAdapter();
	const {
		client: clientTransport,
		server: serverTransport,
		connect,
		disconnect,
	} = createDirectTransport();

	const server = createServer(serverEngine, {
		persistence: adapter,
		transport: serverTransport,
		defaultSubscriptions: opts.defaultSubs,
	});
	const client = createClient(clientEngine, { transport: clientTransport });

	connect({ actorId: opts.actorId ?? "alice" });
	await new Promise((r) => setTimeout(r, 10));

	return { server, client, adapter, connect, disconnect };
}

describe("subscriptions e2e", () => {
	test("default seed delivers initial state for seeded shards on first connect", async () => {
		const { client } = await setup({
			defaultSubs: () => [
				{ channelId: "game", shardId: "world" },
				{ channelId: "game", shardId: "room:lobby" },
			],
		});

		expect(client.ready).toBe(true);
		// Seeded shards are synced
		expect(client.channel("game").shardState("world").state).toEqual({
			stage: "PLAYING",
			turn: 0,
		});
		expect(client.channel("game").shardState("room:lobby").state).toEqual({
			occupants: [],
		});
	});

	test("runtime grant delivers state for the new ref without reconnect", async () => {
		const { server, client } = await setup({
			defaultSubs: () => [{ channelId: "game", shardId: "world" }],
		});

		// Before grant: client has no view on room:lobby
		expect(client.channel("game").shardState("room:lobby").syncStatus).not.toBe(
			"latest",
		);

		// Server writes to room:lobby so there's real state to ship
		await server.submit("game", "enter", { roomId: "lobby", who: "bob" });

		// Grant the subscription — should trigger a state push
		await server.grantSubscription("alice", {
			channelId: "game",
			shardId: "room:lobby",
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(client.channel("game").shardState("room:lobby").syncStatus).toBe(
			"latest",
		);
		expect(client.channel("game").shardState("room:lobby").state).toEqual({
			occupants: ["bob"],
		});

		// Subsequent updates on room:lobby flow through to the client
		await server.submit("game", "enter", { roomId: "lobby", who: "carol" });
		await new Promise((r) => setTimeout(r, 10));
		expect(
			(
				client.channel("game").shardState("room:lobby").state as {
					occupants: string[];
				}
			).occupants,
		).toEqual(["bob", "carol"]);
	});

	test("runtime revoke drops client access and blocks further broadcasts", async () => {
		const { server, client } = await setup({
			defaultSubs: () => [
				{ channelId: "game", shardId: "world" },
				{ channelId: "game", shardId: "room:lobby" },
			],
		});

		// Baseline: client sees lobby state
		await server.submit("game", "enter", { roomId: "lobby", who: "bob" });
		await new Promise((r) => setTimeout(r, 10));
		expect(client.channel("game").shardState("room:lobby").syncStatus).toBe(
			"latest",
		);

		// Count how many times the lobby shard notifies the client — we'll
		// verify no further notifications after revoke.
		let lobbyNotifyCount = 0;
		client.channel("game").subscribeToShard("room:lobby", () => {
			lobbyNotifyCount++;
		});

		// Revoke room:lobby — the client should drop access for that shard.
		await server.revokeSubscription("alice", {
			channelId: "game",
			shardId: "room:lobby",
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(client.channel("game").shardState("room:lobby").syncStatus).not.toBe(
			"latest",
		);

		const notifiesAfterRevoke = lobbyNotifyCount;

		// Server mutates the revoked shard — client must not see it.
		await server.submit("game", "enter", { roomId: "lobby", who: "carol" });
		await new Promise((r) => setTimeout(r, 10));

		expect(lobbyNotifyCount).toBe(notifiesAfterRevoke);
		expect(client.channel("game").shardState("room:lobby").syncStatus).not.toBe(
			"latest",
		);

		// The still-subscribed shard continues to receive broadcasts.
		await server.submit("game", "advanceTurn", {});
		await new Promise((r) => setTimeout(r, 10));
		expect(
			(
				client.channel("game").shardState("world").state as {
					stage: string;
					turn: number;
				}
			).turn,
		).toBe(1);
	});

	test("client.mySubscriptions() returns the actor's ref set and updates on grant/revoke", async () => {
		const { server, client } = await setup({
			defaultSubs: () => [{ channelId: "game", shardId: "world" }],
		});

		// Narrowed shape: state.refs is typed as readonly SubscriptionRef[].
		// A miscast in readMySubsSnapshot would manifest here at runtime.
		const initial = client.mySubscriptions();
		expect(initial.syncStatus).toBe("latest");
		if (initial.syncStatus === "latest" || initial.syncStatus === "stale") {
			expect(initial.state.refs).toEqual([
				{ channelId: "game", shardId: "world" },
			]);
		}

		// subscribeToMySubscriptions fires on shard changes
		let notifyCount = 0;
		const unsubscribe = client.subscribeToMySubscriptions(() => {
			notifyCount++;
		});

		await server.grantSubscription("alice", {
			channelId: "game",
			shardId: "room:lobby",
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(notifyCount).toBeGreaterThan(0);
		const afterGrant = client.mySubscriptions();
		if (
			afterGrant.syncStatus === "latest" ||
			afterGrant.syncStatus === "stale"
		) {
			const shardIds = afterGrant.state.refs.map((r) => r.shardId).sort();
			expect(shardIds).toEqual(["room:lobby", "world"]);
		}

		await server.revokeSubscription("alice", {
			channelId: "game",
			shardId: "room:lobby",
		});
		await new Promise((r) => setTimeout(r, 10));

		const afterRevoke = client.mySubscriptions();
		if (
			afterRevoke.syncStatus === "latest" ||
			afterRevoke.syncStatus === "stale"
		) {
			expect(afterRevoke.state.refs).toEqual([
				{ channelId: "game", shardId: "world" },
			]);
		}

		unsubscribe();
	});
});

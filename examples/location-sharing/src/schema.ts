import { engine, KIO_SERVER_ACTOR_ID } from "@kio/shared";
import * as v from "valibot";

// ── Actor ──────────────────────────────────────────────────────────────

const actorSchema = v.object({
	actorId: v.string(),
	name: v.string(),
});

export type Actor = v.InferOutput<typeof actorSchema>;

// ── Engine ─────────────────────────────────────────────────────────────

const app = engine({
	actor: actorSchema,
	serverActor: { actorId: KIO_SERVER_ACTOR_ID, name: "Server" },
	subscriptions: { kind: "ephemeral" },
});

// ── Room channel (ephemeral) ───────────────────────────────────────────
// Tracks who is online. Single shard visible to everyone.

const playerEntry = v.object({
	actorId: v.string(),
	name: v.string(),
});

const roomState = v.object({
	players: v.array(playerEntry),
});

export type RoomState = v.InferOutput<typeof roomState>;

export const roomChannel = app.channel
	.ephemeral("room")
	.shard("room", roomState, { defaultState: { players: [] } })
	.operation("join", {
		execution: "confirmed",
		serverOnly: true,
		versionChecked: false,
		deduplicate: false,
		input: v.object({ actorId: v.string(), name: v.string() }),
		scope: () => [app.shard.ref("room")],
	})
	.serverImpl("join", {
		apply(shards, input) {
			if (!shards.room.players.some((p) => p.actorId === input.actorId)) {
				shards.room.players.push({
					actorId: input.actorId,
					name: input.name,
				});
			}
		},
	})
	.operation("leave", {
		execution: "confirmed",
		serverOnly: true,
		versionChecked: false,
		deduplicate: false,
		input: v.object({ actorId: v.string() }),
		scope: () => [app.shard.ref("room")],
	})
	.serverImpl("leave", {
		apply(shards, input) {
			const idx = shards.room.players.findIndex(
				(p) => p.actorId === input.actorId,
			);
			if (idx >= 0) shards.room.players.splice(idx, 1);
		},
	});

// ── Presence channel (ephemeral) ───────────────────────────────────────
// Each player's location. Per-resource shard keyed by actorId.
// autoBroadcast: false so we can control flush timing.

const locationState = v.object({
	name: v.string(),
	x: v.number(),
	y: v.number(),
});

export type LocationState = v.InferOutput<typeof locationState>;

export const presenceChannel = app.channel
	.ephemeral("presence")
	.shardPerResource("player", locationState, {
		defaultState: { name: "", x: 0, y: 0 },
	})
	.operation("initPresence", {
		execution: "confirmed",
		serverOnly: true,
		versionChecked: false,
		deduplicate: false,
		input: v.object({ actorId: v.string(), name: v.string() }),
		scope: (input) => [app.shard.ref("player", input.actorId)],
	})
	.serverImpl("initPresence", {
		apply(shards, input) {
			shards.player(input.actorId).name = input.name;
		},
	})
	.operation("updateLocation", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ x: v.number(), y: v.number() }),
		scope: (_input, ctx) => [app.shard.ref("player", ctx.actor.actorId)],
		apply(shards, input, _sr, ctx) {
			const me = shards.player(ctx.actor.actorId);
			me.name = ctx.actor.name;
			me.x = input.x;
			me.y = input.y;
		},
	});

// ── Sharing channel (ephemeral) ────────────────────────────────────────
// Each player's outgoing shares. startShare/stopShare trigger
// grantSubscription/revokeSubscription on the server via afterCommit.

const sharingState = v.object({
	sharedWith: v.array(v.string()),
});

export type SharingState = v.InferOutput<typeof sharingState>;

export const sharingChannel = app.channel
	.ephemeral("sharing")
	.shardPerResource("actor", sharingState, {
		defaultState: { sharedWith: [] },
	})
	.operation("startShare", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({ targetActorId: v.string() }),
		scope: (_input, ctx) => [app.shard.ref("actor", ctx.actor.actorId)],
	})
	.serverImpl("startShare", {
		apply(shards, input, _sr, ctx) {
			const actor = shards.actor(ctx.actor.actorId);
			if (!actor.sharedWith.includes(input.targetActorId)) {
				actor.sharedWith.push(input.targetActorId);
			}
		},
	})
	.operation("stopShare", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({ targetActorId: v.string() }),
		scope: (_input, ctx) => [app.shard.ref("actor", ctx.actor.actorId)],
	})
	.serverImpl("stopShare", {
		apply(shards, input, _sr, ctx) {
			const actor = shards.actor(ctx.actor.actorId);
			const idx = actor.sharedWith.indexOf(input.targetActorId);
			if (idx >= 0) actor.sharedWith.splice(idx, 1);
		},
	});

// ── App engine ─────────────────────────────────────────────────────────

export const appEngine = app
	.register(roomChannel)
	.register(presenceChannel)
	.register(sharingChannel);

export { app };

import { defineApp } from "@kio/shared";
import * as v from "valibot";

const actorSchema = v.object({
	actorId: v.string(),
	name: v.string(),
});

export type Actor = v.InferOutput<typeof actorSchema>;

const kio = defineApp({
	actor: actorSchema,
	serverActor: { actorId: "__kio:server__", name: "Server" },
});

const roomState = v.object({
	phase: v.picklist(["waiting", "countdown", "started"]),
	/** Unix timestamp ms when countdown ends. null if not counting down. */
	countdownEndsAt: v.nullable(v.number()),
	players: v.array(
		v.object({
			actorId: v.string(),
			name: v.string(),
			ready: v.boolean(),
		}),
	),
});

export type RoomState = v.InferOutput<typeof roomState>;

export const lobbyChannel = kio.channel
	.durable("lobby")
	.shard("room", roomState)
	.operation("join", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ actorId: v.string(), name: v.string() }),
		scope: () => [kio.shard.ref("room")],
		apply(shards, input) {
			if (!shards.room.players.some((p) => p.actorId === input.actorId)) {
				shards.room.players.push({
					actorId: input.actorId,
					name: input.name,
					ready: false,
				});
			}
		},
	})
	.operation("leave", {
		execution: "confirmed",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ actorId: v.string() }),
		scope: () => [kio.shard.ref("room")],
	})
	.serverImpl("leave", {
		apply(shards, input) {
			const idx = shards.room.players.findIndex(
				(p) => p.actorId === input.actorId,
			);
			if (idx >= 0) shards.room.players.splice(idx, 1);
			// Cancel countdown if it was active
			if (shards.room.phase === "countdown") {
				shards.room.phase = "waiting";
				shards.room.countdownEndsAt = null;
			}
		},
	})
	.operation("setReady", {
		execution: "optimistic",
		input: v.object({ actorId: v.string(), ready: v.boolean() }),
		scope: () => [kio.shard.ref("room")],
		apply(shards, input) {
			const player = shards.room.players.find(
				(p) => p.actorId === input.actorId,
			);
			if (player) player.ready = input.ready;
		},
	})
	.operation("setPhase", {
		execution: "confirmed",
		versionChecked: false,
		deduplicate: false,
		input: v.object({
			phase: v.picklist(["waiting", "countdown", "started"]),
			countdownEndsAt: v.nullable(v.number()),
		}),
		scope: () => [kio.shard.ref("room")],
	})
	.serverImpl("setPhase", {
		apply(shards, input) {
			shards.room.phase = input.phase;
			shards.room.countdownEndsAt = input.countdownEndsAt;
		},
	});

export const appEngine = kio.engine().channel(lobbyChannel);

export { kio };

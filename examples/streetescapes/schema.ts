import { channel, shard } from "@kio/shared";
import * as v from "valibot";

// ── State schemas ────────────────────────────────────────────────────

const worldState = v.object({
	gameStage: v.picklist(["LOBBY", "BRIEFING", "PLAYING", "PAUSED", "FINISHED"]),
	turnCount: v.number(),
});

const seatState = v.object({
	playerId: v.string(),
	inventory: v.array(
		v.object({ id: v.string(), name: v.string(), quantity: v.number() }),
	),
	visitedLocations: v.set(v.string()),
});

const presenceState = v.object({
	gps: v.optional(v.object({ lat: v.number(), lng: v.number() })),
	status: v.picklist(["ok", "unavailable", "timeout", "unknown"]),
	lastSeen: v.number(),
});

const fogState = v.object({
	revealedCells: v.set(v.string()),
});

// ── Game channel (durable) ───────────────────────────────────────────

export const gameChannel = channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)

	// Optimistic: apply runs on client immediately
	.operation("visitLocation", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string(), locationSlug: v.string() }),
		errors: v.picklist(["ALREADY_VISITED", "NOT_PLAYING"]),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			shards.seat(input.seatId).visitedLocations.add(input.locationSlug);
		},
	})

	.operation("useItem", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string(), itemId: v.string() }),
		errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			const inv = shards.seat(input.seatId).inventory;
			const idx = inv.findIndex((i) => i.id === input.itemId);
			if (idx >= 0) inv.splice(idx, 1);
		},
	})

	// Confirmed: client waits for server before showing result
	.operation("chooseDialogueOption", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({
			seatId: v.string(),
			dialogueId: v.string(),
			optionIndex: v.number(),
		}),
		errors: v.picklist(["DIALOGUE_NOT_ACTIVE", "INVALID_OPTION"]),
		scope: (input) => [shard.ref("seat", input.seatId)],
	})

	// Confirmed + cross-shard
	.operation("transferItem", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({
			fromSeatId: v.string(),
			toSeatId: v.string(),
			itemId: v.string(),
		}),
		errors: v.picklist(["ITEM_NOT_FOUND", "INVENTORY_FULL"]),
		scope: (input) => [
			shard.ref("seat", input.fromSeatId),
			shard.ref("seat", input.toSeatId),
		],
	})

	// Computed: server generates data the client doesn't have
	.operation("rollDice", {
		execution: "computed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({
			dice: v.array(v.object({ max: v.number() })),
			target: v.string(),
		}),
		errors: v.picklist(["NOT_PLAYING"]),
		serverResult: v.object({ results: v.array(v.number()) }),
		scope: () => [shard.ref("world")],
	});

// ── Presence channel (ephemeral, coalesced broadcast) ────────────────

export const presenceChannel = channel
	.ephemeral("presence", { autoBroadcast: false })
	.shardPerResource("player", presenceState)

	.operation("updateLocation", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({
			gps: v.object({ lat: v.number(), lng: v.number() }),
			status: v.picklist(["ok", "unavailable", "timeout"]),
		}),
		scope: (_input, ctx) => [shard.ref("player", ctx.actor.actorId)],
		apply(shards, input, _serverResult, ctx) {
			const me = shards.player(ctx.actor.actorId);
			me.gps = input.gps;
			me.status = input.status;
			me.lastSeen = Date.now();
		},
	});

// ── Fog of war channel (durable, patch broadcast) ────────────────────

export const fogChannel = channel
	.durable("fog", { broadcastMode: "patch" })
	.shardPerResource("region", fogState)

	.operation("revealCells", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({
			regionId: v.string(),
			cells: v.array(v.string()),
		}),
		scope: (input) => [shard.ref("region", input.regionId)],
		apply(shards, input) {
			const region = shards.region(input.regionId);
			for (const cell of input.cells) {
				region.revealedCells.add(cell);
			}
		},
	});

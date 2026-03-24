/**
 * Type-level tests — no runtime, pure compile-time assertions.
 * These run as part of `just typecheck` (tsgo), not `bun test`.
 */

import * as v from "valibot";
import { channel, shard } from "./index";

// ── Type assertion helpers ───────────────────────────────────────────

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ── State schemas ────────────────────────────────────────────────────

const worldState = v.object({
	gameStage: v.picklist(["PLAYING", "PAUSED", "FINISHED"]),
});

const seatState = v.object({
	inventory: v.array(v.object({ id: v.string(), name: v.string() })),
	visitedLocations: v.set(v.string()),
});

const presenceState = v.object({
	gps: v.optional(v.object({ lat: v.number(), lng: v.number() })),
	status: v.picklist(["ok", "unavailable", "timeout", "unknown"]),
});

// ── 1. Basic channel creation ────────────────────────────────────────

const durableChannel = channel.durable("game");
type _1a = Expect<Equal<typeof durableChannel.kind, "durable">>;
type _1b = Expect<Equal<typeof durableChannel.name, "game">>;

const ephemeralChannel = channel.ephemeral("presence");
type _1c = Expect<Equal<typeof ephemeralChannel.kind, "ephemeral">>;
type _1d = Expect<Equal<typeof ephemeralChannel.name, "presence">>;

// ── 2. Shard accumulation ────────────────────────────────────────────

const gameChannel = channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState);

// After chaining, the channel should still be durable with name "game"
type _2a = Expect<Equal<typeof gameChannel.kind, "durable">>;
type _2b = Expect<Equal<typeof gameChannel.name, "game">>;

// ── 3. Shard accessor types ─────────────────────────────────────────

// Build a channel and verify the ShardAccessors type
const _ch = channel
	.durable("test")
	.shard("world", worldState)
	.shardPerResource("seat", seatState);

// Extract ShardDefs from the builder (using a helper operation to test)
// We verify this indirectly through the operation's apply function

// ── 4. Optimistic operation — apply required, receives correct types ─

channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)
	.operation("visitLocation", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string(), locationSlug: v.string() }),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			// shards.seat should be a function (per-resource)
			const seat = shards.seat(input.seatId);
			seat.visitedLocations.add(input.locationSlug);

			// shards.world should be a direct property (singleton)
			const _stage: "PLAYING" | "PAUSED" | "FINISHED" = shards.world.gameStage;
		},
	});

// ── 5. Confirmed operation — apply NOT allowed in shared schema ──────

channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)
	.operation("chooseDialogue", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ dialogueId: v.string(), optionIndex: v.number() }),
		scope: (_input) => [shard.ref("world")],
		// No apply — correct for confirmed
	});

// ── 6. Computed operation — apply NOT allowed in shared schema ───────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("rollDice", {
		execution: "computed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ dice: v.array(v.object({ max: v.number() })) }),
		serverResult: v.object({ results: v.array(v.number()) }),
		scope: () => [shard.ref("world")],
		// No apply — correct for computed
	});

// ── 7. Ephemeral channel with operation ──────────────────────────────

channel
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
		},
	});

// ── 8. Negative: wrong property type in apply should fail ────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("badApply", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply(shards) {
			// @ts-expect-error: gameStage is not a number
			const _bad: number = shards.world.gameStage;
		},
	});

// ── 9. Negative: accessing non-existent shard should fail ────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("badShard", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply(shards) {
			// @ts-expect-error: "inventory" shard does not exist
			shards.inventory;
		},
	});

// ── 10. Negative: confirmed must NOT accept apply ────────────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("badConfirmed", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ id: v.string() }),
		scope: () => [shard.ref("world")],
		// @ts-expect-error: apply not allowed for confirmed operations
		apply() {},
	});

// ── 11. Negative: computed must NOT accept apply ─────────────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("badComputed", {
		execution: "computed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ id: v.string() }),
		scope: () => [shard.ref("world")],
		// @ts-expect-error: apply not allowed for computed operations
		apply() {},
	});

// ── 12. Negative: optimistic must REQUIRE apply ──────────────────────

channel
	.durable("game")
	.shard("world", worldState)
	// @ts-expect-error: apply is required for optimistic operations
	.operation("missingApply", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
	});

// ── 13. Operation with typed errors ──────────────────────────────────

channel
	.durable("game")
	.shardPerResource("seat", seatState)
	.operation("useItem", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string(), itemId: v.string() }),
		errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			const inv = shards.seat(input.seatId).inventory;
			inv.splice(
				inv.findIndex((i) => i.id === input.itemId),
				1,
			);
		},
	});

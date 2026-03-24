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
		// @ts-expect-error: apply not allowed for confirmed — no overload matches
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ id: v.string() }),
		scope: () => [shard.ref("world")],
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
		// @ts-expect-error: apply not allowed for computed — no overload matches
		apply() {},
	});

// ── 12. Negative: optimistic must REQUIRE apply ──────────────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("missingApply", {
		// @ts-expect-error: apply is required for optimistic — no overload matches
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
	});

// ── 13. serverImpl for optimistic — validate with typed reject ───────

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
	})
	.serverImpl("useItem", {
		validate(shards, input, _ctx, { reject }) {
			const item = shards
				.seat(input.seatId)
				.inventory.find((i) => i.id === input.itemId);
			if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory");
			if (item.name.length < 1)
				return reject("INSUFFICIENT_QUANTITY", "No uses left");
		},
	});

// ── 14. serverImpl for confirmed — apply required ────────────────────

channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)
	.operation("chooseDialogue", {
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
	.serverImpl("chooseDialogue", {
		validate(_shards, _input, _ctx, { reject }) {
			// reject is typed — only declared codes allowed
			return reject("DIALOGUE_NOT_ACTIVE", "No active dialogue");
		},
		apply(shards, input) {
			// shards and input are correctly typed
			const _seat = shards.seat(input.seatId);
		},
	});

// ── 15. serverImpl for computed — compute + apply ────────────────────

channel
	.durable("game")
	.shard("world", worldState)
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
	})
	.serverImpl("rollDice", {
		validate(shards, _input, _ctx, { reject }) {
			if (shards.world.gameStage !== "PLAYING")
				return reject("NOT_PLAYING", "Game is not active");
		},
		compute(_shards, input) {
			return {
				results: input.dice.map((d) => Math.floor(Math.random() * d.max) + 1),
			};
		},
		apply(shards, input, serverResult) {
			const _stage = shards.world.gameStage;
			const _target = input.target;
			const _results: number[] = serverResult.results;
		},
	});

// ── 16. Negative: serverImpl reject() rejects undeclared error codes ─

channel
	.durable("game")
	.shard("world", worldState)
	.operation("typed", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ id: v.string() }),
		errors: v.picklist(["NOT_FOUND", "EXPIRED"]),
		scope: () => [shard.ref("world")],
	})
	.serverImpl("typed", {
		validate(_shards, _input, _ctx, { reject }) {
			reject("NOT_FOUND", "ok"); // valid
			// @ts-expect-error: "INVALID" is not in the errors picklist
			reject("INVALID", "bad");
		},
		apply() {},
	});

// ── 17. Negative: serverImpl for optimistic must NOT accept apply ────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("optOp", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply() {},
	})
	.serverImpl("optOp", {
		// @ts-expect-error: apply not allowed in serverImpl for optimistic
		apply() {},
	});

// ── 18. Negative: serverImpl for confirmed must REQUIRE apply ────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("confOp", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
	})
	// @ts-expect-error: apply is required in serverImpl for confirmed
	.serverImpl("confOp", {
		validate() {},
	});

// ── 19. Negative: serverImpl for non-existent operation ──────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("exists", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply() {},
	})
	// @ts-expect-error: "doesNotExist" is not a defined operation
	.serverImpl("doesNotExist", {});

// ── 20. clientImpl with typed canRetry ───────────────────────────────

channel
	.durable("game")
	.shardPerResource("seat", seatState)
	.operation("useItem", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string(), itemId: v.string() }),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			shards.seat(input.seatId).inventory.splice(0, 1);
		},
	})
	.clientImpl("useItem", {
		canRetry(input, freshShards) {
			// input is typed as { seatId: string; itemId: string }
			const _id: string = input.itemId;
			// freshShards has seat accessor
			return freshShards
				.seat(input.seatId)
				.inventory.some((i) => i.id === input.itemId);
		},
	});

// ── 21. clientImpl with no canRetry (empty config) ───────────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("simple", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply() {},
	})
	.clientImpl("simple", {});

// ── 22. Negative: clientImpl for non-existent operation ──────────────

channel
	.durable("game")
	.shard("world", worldState)
	.operation("exists", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({}),
		scope: () => [shard.ref("world")],
		apply() {},
	})
	// @ts-expect-error: "nope" is not a defined operation
	.clientImpl("nope", {});

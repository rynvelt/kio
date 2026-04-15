/**
 * Type-level tests — no runtime, pure compile-time assertions.
 * These run as part of `just typecheck` (tsgo), not `bun test`.
 */

import { createServer, MemoryStateAdapter } from "@kio/server";
import type { ShardState, SubmitResult } from "@kio/shared";
import { channel, engine, shard } from "@kio/shared";
import * as v from "valibot";

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
			// shards.seat should be a function (per-resource) — in scope
			const seat = shards.seat(input.seatId);
			seat.visitedLocations.add(input.locationSlug);

			// @ts-expect-error: world is not in scope (scope only declares "seat")
			shards.world;
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

// ── 19. clientImpl with typed canRetry ────────────────────────────────

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

// ── 20. clientImpl with no canRetry (empty config) ───────────────────

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

// ── 21. Multi-shard scope — apply receives both shard types ──────────

channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)
	.operation("transferItem", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: true,
		input: v.object({
			fromSeatId: v.string(),
			toSeatId: v.string(),
			itemId: v.string(),
		}),
		scope: (input) => [
			shard.ref("seat", input.fromSeatId),
			shard.ref("seat", input.toSeatId),
		],
	})
	.serverImpl("transferItem", {
		apply(shards, input) {
			// Both "seat" refs are in scope — seat accessor is available
			const from = shards.seat(input.fromSeatId);
			const to = shards.seat(input.toSeatId);
			const idx = from.inventory.findIndex((i) => i.id === input.itemId);
			const item = from.inventory[idx];
			if (item) {
				from.inventory.splice(idx, 1);
				to.inventory.push(item);
			}
		},
	});

// ── 22. Mixed scope — world + seat both accessible ───────────────────

channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)
	.operation("mixedScope", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string() }),
		scope: (input) => [shard.ref("world"), shard.ref("seat", input.seatId)],
		apply(shards, input) {
			// Both world and seat are in scope
			const _stage = shards.world.gameStage;
			const _seat = shards.seat(input.seatId);
		},
	});

// ── 23. engine() accumulates channels ────────────────────────────────

const gameChannelForEngine = channel
	.durable("game")
	.shard("world", worldState)
	.shardPerResource("seat", seatState)
	.operation("visit", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: true,
		input: v.object({ seatId: v.string() }),
		scope: (input) => [shard.ref("seat", input.seatId)],
		apply(shards, input) {
			shards.seat(input.seatId).visitedLocations.add("test");
		},
	});

const presChannel = channel
	.ephemeral("presence", { autoBroadcast: false })
	.shardPerResource("player", presenceState)
	.operation("updateLocation", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({
			gps: v.object({ lat: v.number(), lng: v.number() }),
		}),
		scope: (_input, ctx) => [shard.ref("player", ctx.actor.actorId)],
		apply(shards, input, _sr, ctx) {
			const me = shards.player(ctx.actor.actorId);
			me.gps = input.gps;
		},
	});

const _serverEngine = engine()
	.channel(gameChannelForEngine)
	.channel(presChannel);
const _clientEngine = engine()
	.channel(gameChannelForEngine)
	.channel(presChannel);

// ── 24. SubmitResult discriminated union ─────────────────────────────

function _handleResult(result: SubmitResult<"NOT_FOUND" | "EXPIRED">) {
	if (result.status === "acknowledged") {
		// no error
	} else if (result.status === "rejected") {
		const _code: "NOT_FOUND" | "EXPIRED" | string = result.error.code;
		const _msg: string = result.error.message;
	} else if (result.status === "blocked") {
		const _code: "PENDING_OPERATION" = result.error.code;
	}
}

// ── 25. ShardState discriminated union ───────────────────────────────

function _handleShardState(s: ShardState<{ items: string[] }>) {
	if (s.syncStatus === "unavailable" || s.syncStatus === "loading") {
		const _null: null = s.state;
		const _noPending: null = s.pending;
	} else {
		// stale or latest — state is T
		const _items: string[] = s.state.items;
	}
}

// ── 26. Server type safety ───────────────────────────────────────────

const _serverForTypes = createServer(
	engine()
		.channel(
			channel
				.durable("game")
				.shard("world", v.object({ turn: v.number() }))
				.operation("advanceTurn", {
					execution: "optimistic",
					input: v.object({}),
					scope: () => [shard.ref("world")],
					apply(shards) {
						shards.world.turn += 1;
					},
				}),
		)
		.channel(
			channel
				.ephemeral("presence")
				.shardPerResource("player", v.object({ online: v.boolean() }))
				.operation("setOnline", {
					execution: "optimistic",
					versionChecked: false,
					deduplicate: false,
					input: v.object({ playerId: v.string() }),
					scope: (input) => [shard.ref("player", input.playerId)],
					apply(shards, input) {
						(shards.player(input.playerId) as { online: boolean }).online =
							true;
					},
				}),
		),
	{ persistence: new MemoryStateAdapter() },
);

// Valid calls
_serverForTypes.submit("game", "advanceTurn", {});
_serverForTypes.submit("presence", "setOnline", { playerId: "alice" });

// @ts-expect-error: wrong input type (playerId should be string, not number)
_serverForTypes.submit("presence", "setOnline", { playerId: 123 });

// @ts-expect-error: missing required field for setOnline
_serverForTypes.submit("presence", "setOnline", {});

// ── 27. defineApp creates pre-typed builders ────────────────────────

import { defineApp, type InferActor } from "@kio/shared";

const kio = defineApp({
	actor: v.object({ actorId: v.string(), name: v.string() }),
	serverActor: { actorId: "__kio:server__", name: "System" },
});

// InferActor extracts the actor type from an engine builder
const _kioEngine = kio.engine();
type _KioActor = InferActor<typeof _kioEngine>;
type _27a = Expect<Equal<_KioActor, { actorId: string; name: string }>>;

defineApp({
	actor: v.object({ actorId: v.string(), name: v.string() }),
	// @ts-expect-error: serverActor missing "name" field
	serverActor: { actorId: "__kio:server__" },
});

// Channels built from kio work normally
const _kioChannel = kio.channel
	.durable("test")
	.shard("world", v.object({ turn: v.number() }))
	.operation("tick", {
		execution: "optimistic",
		input: v.object({}),
		scope: () => [kio.shard.ref("world")],
		apply(shards) {
			shards.world.turn += 1;
		},
	});

const _kioAppEngine = kio.engine().channel(_kioChannel);

// ── 28. defineApp ctx.actor carries full actor type ─────────────────

kio.channel
	.durable("typed-actor")
	.shard("world", v.object({ turn: v.number() }))
	.operation("move", {
		execution: "optimistic",
		input: v.object({}),
		scope: (_input, ctx) => {
			// ctx.actor.name is typed — this is the key test
			const _name: string = ctx.actor.name;
			return [kio.shard.ref("world")];
		},
		apply(_shards, _input, _sr, ctx) {
			const _name: string = ctx.actor.name;
			const _id: string = ctx.actor.actorId;
		},
	})
	.serverImpl("move", {
		validate(_shards, _input, ctx) {
			const _name: string = ctx.actor.name;
		},
	});

// ── 29. Standalone channel uses default actor (backward compat) ─────

channel
	.durable("default-actor")
	.shard("world", v.object({ turn: v.number() }))
	.operation("tick", {
		execution: "optimistic",
		input: v.object({}),
		scope: (_input, ctx) => {
			// Default actor only has actorId
			const _id: string = ctx.actor.actorId;
			// @ts-expect-error: "name" does not exist on default actor
			ctx.actor.name;
			return [shard.ref("world")];
		},
		apply() {},
	});

// ── 30. Engine.channel() is contravariant in actor type ──────────────
//
// A channel whose handlers only read base actor fields (actorId) can be
// added to any engine, regardless of what extra fields that engine's
// actor carries. Conversely, a channel that demands fields the engine's
// actor doesn't have is rejected at compile time via ChannelActorMismatch.

import type { ChannelActorMismatch } from "@kio/shared";
import { createChannelBuilder } from "@kio/shared";

// Positive: bare-`channel.durable(...)` channel (TActor = BaseActor)
// can be added to a defineApp engine with a richer actor type.
const _baseChannel = channel
	.durable("library")
	.shard("data", v.object({ value: v.string() }));

const _kioEngineWithLib = kio.engine().channel(_baseChannel);

// The result is an EngineBuilder, not a ChannelActorMismatch.
type _30a = Expect<
	Equal<
		typeof _kioEngineWithLib extends ChannelActorMismatch<unknown, unknown>
			? false
			: true,
		true
	>
>;

// Chaining further .channel() calls still works.
_kioEngineWithLib.channel(_kioChannel);

// Negative: a channel typed with an actor that has fields the engine's
// actor doesn't have yields ChannelActorMismatch. Chaining .channel()
// on that result is a type error.
const _strictChannel = createChannelBuilder<
	"durable",
	"strict",
	{ actorId: string; role: "admin" }
>("durable", "strict").shard("data", v.object({ value: v.string() }));

// `engine()` defaults to TActor = BaseActor, which lacks `role`.
const _mismatchResult = engine().channel(_strictChannel);

// The result IS a ChannelActorMismatch (not an EngineBuilder).
type _30b = Expect<
	Equal<
		typeof _mismatchResult extends ChannelActorMismatch<unknown, unknown>
			? true
			: false,
		true
	>
>;

// Chaining .channel() on the mismatch fails — proof that the error
// surfaces at the next call site.
// @ts-expect-error: Property 'channel' does not exist on ChannelActorMismatch
_mismatchResult.channel(_kioChannel);

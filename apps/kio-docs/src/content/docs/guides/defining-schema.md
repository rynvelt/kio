---
title: Defining a Schema
description: "How to define channels, shards, operations, and state shapes in schema.ts"
sidebar:
  order: 1
---

:::note[Status: Design Only]
This guide describes the target API. The builder pattern is partially implemented in @kio/core.
:::

Your schema file is the shared contract between client and server. Both sides import it, so everything defined here must be safe to run in either environment. This is where you declare channels, shards, state shapes, and operations.

By the end of this guide you will have a complete `schema.ts` that defines a durable game channel with multiple operation types and an ephemeral presence channel.

## State schemas

Start by defining the shape of each shard's state. Kio uses [StandardSchema](https://github.com/standard-schema/standard-schema), so any compatible validation library works — Valibot, Zod, ArkType, etc. These examples use Valibot.

A game might have three distinct kinds of state: world-level state visible to everyone, per-seat state for each player, and presence state for real-time location tracking.

```ts
import { channel, shard } from "kio/core"
import * as v from "valibot"

const worldState = v.object({
  gameStage: v.picklist(["PLAYING", "PAUSED", "FINISHED"]),
  diceResults: v.record(v.string(), v.object({
    sum: v.number(),
    rolls: v.array(v.object({ max: v.number(), result: v.number() })),
  })),
})

const seatState = v.object({
  inventory: v.array(v.object({ id: v.string(), name: v.string(), quantity: v.number() })),
  visitedLocations: v.set(v.string()),
})

const presenceState = v.object({
  gps: v.optional(v.object({ lat: v.number(), lng: v.number() })),
  status: v.picklist(["ok", "unavailable", "timeout", "unknown"]),
})
```

Each schema describes the state for one shard type. `worldState` is a singleton (one per channel), while `seatState` is per-resource (one instance per seat). This distinction matters when you define the channel.

## Channel definitions

With the state schemas in place, you can define channels. The builder pattern starts with a channel constructor and chains shard declarations onto it.

```ts
export const gameChannel = channel.durable("game")
  .shard("world", worldState)
  .shardPerResource("seat", seatState)
```

`channel.durable("game")` creates a durable channel named "game" — versioned, conflict-detected, and persisted. The `.shard("world", worldState)` call registers a singleton shard: there is exactly one "world" shard per channel instance. The `.shardPerResource("seat", seatState)` call registers a per-resource shard: there will be one "seat" shard for each resource ID (e.g., `seat:1`, `seat:2`).

This channel now knows its state shape, but it has no operations yet. Operations are chained next.

## Optimistic operations

Optimistic operations are the most common kind. The client applies them immediately (before the server responds), giving users instant feedback. The key requirement: the `apply()` function must live in the shared schema because both client and server need it.

```ts
  .operation("visitLocation", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: v.object({ seatId: v.string(), locationSlug: v.string() }),
    errors: v.picklist(["ALREADY_VISITED"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {
      seat(input.seatId).visitedLocations.add(input.locationSlug)
    },
  })
```

Walk through each field:

- **`execution: "optimistic"`** — the client applies this operation immediately, then sends it to the server for confirmation. If the server rejects it, the client rolls back.
- **`versionChecked: true`** — the server will compare shard versions and reject the operation if state has changed since the client last saw it. This catches conflicts.
- **`deduplicate: true`** — if the same operation is submitted twice (e.g., a network retry), the server recognizes and ignores the duplicate.
- **`input`** — a StandardSchema for the operation's payload. Type-safe on both sides.
- **`errors`** — the set of typed error codes this operation can produce. Only the server's `validate()` hook can return these (see [Server Setup](/guides/server-setup/)).
- **`scope(input)`** — declares which shards this operation touches. The engine uses this to load the right shard state, check versions, and determine broadcast targets. Here, it touches one seat shard.
- **`apply(shards, input)`** — the state mutation. The first argument is an object keyed by shard type name. Since `seat` is a per-resource shard, `seat(input.seatId)` returns the state for that specific seat. Inside `apply()`, state is an [Immer](https://immerjs.github.io/immer/) draft — you write mutative code, and the engine produces immutable results.

Here is another optimistic operation that removes an item from a player's inventory:

```ts
  .operation("useItem", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: v.object({ seatId: v.string(), itemId: v.string() }),
    errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {
      const inv = seat(input.seatId).inventory
      inv.splice(inv.findIndex(i => i.id === input.itemId), 1)
    },
  })
```

The pattern is the same: declare scope, write the mutation in `apply()`. The client applies it immediately so the item disappears from the UI without waiting for a round trip. If the server rejects (item not found, insufficient quantity), the engine rolls back.

## Computed operations

Some operations need data the client does not have. A dice roll, for instance, requires server-generated random numbers. These use `execution: "computed"`.

```ts
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
```

Notice what is different from an optimistic operation:

- **No `apply()` in the schema.** The client cannot predict the result because it depends on server-side computation. If you try to add `apply()` to a computed operation, you will get a type error. The `apply()` for computed operations lives in the server-only schema file (`schema.server.ts`), where it receives the computed `serverResult`.
- **`serverResult`** — a schema for the data the server's `compute()` hook will return. This result is broadcast to clients along with the state update, so both sides can replay the exact same transition.

The client submits the roll and waits. The server runs `compute()` to generate random results, then runs `apply()` with those results, persists, and broadcasts. The client receives the authoritative state.

## Confirmed operations

Confirmed operations are similar to computed operations in that the client does not apply them locally. The difference is that confirmed operations do not need server-side computation — the server just needs to validate and apply.

```ts
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
```

Again, no `apply()` in the schema. The client submits and waits for the server to confirm. This is the right choice when:

- The mutation logic is complex and you do not want the client to predict it.
- The operation touches state the client should not see (like hidden game rules).
- Optimistic rollback would be confusing to the user.

The server-side `apply()` for confirmed operations lives in `schema.server.ts`.

## Cross-shard operations

Operations can touch multiple shards. An item transfer between two players needs to update both inventories atomically:

```ts
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
```

The `scope()` function returns two shard references. The engine loads both, checks both versions, and applies the mutation atomically. In persistence, this becomes a multi-row atomic write.

This operation is `confirmed` rather than `optimistic` because cross-shard mutations are more likely to conflict and more disruptive to roll back.

## Ephemeral channels

Not all state needs durability. Player presence — GPS coordinates, online status — is disposable. If the server restarts, clients just re-send their location. There is no meaningful "conflict" because the latest value is always correct.

```ts
export const presenceChannel = channel.ephemeral("presence", { autoBroadcast: false })
  .shardPerResource("player", presenceState)

  .operation("updateLocation", {
    execution: "optimistic",
    versionChecked: false,
    deduplicate: false,
    input: v.object({
      gps: v.object({ lat: v.number(), lng: v.number() }),
      status: v.picklist(["ok", "unavailable", "timeout"]),
    }),
    scope: (_input, ctx) => [shard.ref("player", ctx.actorId)],
    apply({ player }, input, _serverResult, ctx) {
      const me = player(ctx.actorId)
      me.gps = input.gps
      me.status = input.status
    },
  })
```

Several things are different from the durable game channel:

- **`channel.ephemeral("presence", { autoBroadcast: false })`** — ephemeral channels are unversioned, unpersisted, and held in memory only. The `autoBroadcast: false` option means state updates are not broadcast immediately. Instead, the server controls when broadcasts happen (e.g., every 5 seconds via `server.broadcastDirtyShards("presence")`). See [Channels](/concepts/channels/) for details on broadcast control.
- **`versionChecked: false`** — no conflict detection. The latest value always wins, which is the right model for frequently-updating data like GPS.
- **`deduplicate: false`** — no deduplication. A duplicate location update is harmless.
- **`scope` uses `ctx.actorId`** — each player writes only to their own presence shard. The `ctx` argument provides the operation context, including the actor's identity.
- **`apply` uses `ctx`** — the mutation uses `ctx.actorId` to look up the correct player shard. This is the same `apply()` that runs on both client and server.

## Putting it all together

Here is the complete `schema.ts`:

```ts
import { channel, shard } from "kio/core"
import * as v from "valibot"

// --- State schemas ---

const worldState = v.object({
  gameStage: v.picklist(["PLAYING", "PAUSED", "FINISHED"]),
  diceResults: v.record(v.string(), v.object({
    sum: v.number(),
    rolls: v.array(v.object({ max: v.number(), result: v.number() })),
  })),
})

const seatState = v.object({
  inventory: v.array(v.object({ id: v.string(), name: v.string(), quantity: v.number() })),
  visitedLocations: v.set(v.string()),
})

const presenceState = v.object({
  gps: v.optional(v.object({ lat: v.number(), lng: v.number() })),
  status: v.picklist(["ok", "unavailable", "timeout", "unknown"]),
})

// --- Durable game channel ---

export const gameChannel = channel.durable("game")
  .shard("world", worldState)
  .shardPerResource("seat", seatState)

  // Optimistic: client applies immediately
  .operation("visitLocation", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: v.object({ seatId: v.string(), locationSlug: v.string() }),
    errors: v.picklist(["ALREADY_VISITED"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {
      seat(input.seatId).visitedLocations.add(input.locationSlug)
    },
  })

  .operation("useItem", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: v.object({ seatId: v.string(), itemId: v.string() }),
    errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {
      const inv = seat(input.seatId).inventory
      inv.splice(inv.findIndex(i => i.id === input.itemId), 1)
    },
  })

  // Computed: server generates data the client can't predict
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

  // Confirmed: server validates and applies, no client prediction
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

  // Confirmed, cross-shard: touches two seat shards atomically
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

// --- Ephemeral presence channel ---

export const presenceChannel = channel.ephemeral("presence", { autoBroadcast: false })
  .shardPerResource("player", presenceState)

  .operation("updateLocation", {
    execution: "optimistic",
    versionChecked: false,
    deduplicate: false,
    input: v.object({
      gps: v.object({ lat: v.number(), lng: v.number() }),
      status: v.picklist(["ok", "unavailable", "timeout"]),
    }),
    scope: (_input, ctx) => [shard.ref("player", ctx.actorId)],
    apply({ player }, input, _serverResult, ctx) {
      const me = player(ctx.actorId)
      me.gps = input.gps
      me.status = input.status
    },
  })
```

This file is imported by both the client and the server. The client uses it to apply optimistic operations locally and to type-check `submit()` calls. The server uses it as the source of truth for operation definitions, then layers on server-only logic in `schema.server.ts` (see [Server Setup](/guides/server-setup/)).

## Choosing an execution mode

When deciding which execution mode to use for an operation, consider:

| Mode | Client prediction | Server computation | Best for |
|---|---|---|---|
| `optimistic` | Yes (`apply()` runs immediately) | No | Most mutations where rollback is acceptable |
| `computed` | No (waits for server) | Yes (`compute()` + `apply()`) | Operations needing server-generated data |
| `confirmed` | No (waits for server) | No (`apply()` only) | Complex mutations, hidden logic, cross-shard |

If in doubt, start with `confirmed`. You can always move to `optimistic` later by adding a shared `apply()` to the schema. Moving the other direction (removing `apply()` from the schema) is also safe since the type system will catch any code that depended on client-side prediction.

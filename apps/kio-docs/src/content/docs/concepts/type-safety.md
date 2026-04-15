---
title: Type Safety & Schema Split
description: Builder pattern, three-file split, and compiler-enforced correctness
sidebar:
  order: 10
---

:::note[Status: Exploratory]
Core builder types are partially implemented. The full three-file split is design-only.
:::

A central design goal of Kio: the type system enforces correctness across client and server, while ensuring each side only bundles the code it needs.

The naive approach — one schema file that defines everything — breaks down in two ways. First, `validate()` and `compute()` are server-only code, and `canRetry()` is client-only. If the client imports the schema, it bundles server logic (wasteful, and a potential security leak). Second, when everything lives in one big config object, TypeScript often can't infer the types correctly because parts of the config reference types from other parts.

Kio solves both problems with the builder pattern and a three-file split.

## Builder pattern for type inference

Channels are built incrementally. Each `.shard()` call returns a new typed channel that includes that shard. By the time `.operation()` is called, all shard types are fully resolved — TypeScript doesn't need to infer everything at once.

```ts
channel.durable("game")
  .shard("world", worldState)               // → Channel<{ world: WorldState }>
  .shardPerResource("seat", seatState)      // → Channel<{ ..., seat: (id) => SeatState }>
  .operation("useItem", {
    input: v.object({ seatId: v.string(), itemId: v.string() }),
    // TypeScript already knows seat's type from the chain above.
    // Input type is inferred from the Valibot schema.
    apply({ seat }, input) { ... },
  })
```

Operations use config objects (not chaining) because at that point the shard types and input schema are independent inference problems that TypeScript handles well within a single object.

## Three-file split

The `execution` flag on each operation determines where `apply()` goes — and the type system enforces the placement:

- **`execution: "optimistic"`** — `apply()` must be in the shared schema. The client needs it to pre-compute the optimistic state. The type requires it; omitting it is a compile error.
- **`execution: "confirmed"` or `"computed"`** — `apply()` must be in `.serverImpl()`. The client doesn't need it (it receives the state from the server broadcast). The type rejects it in the shared schema.

This leads to three files, each with a clear role.

### `schema.ts` — the shared contract

Imported by both client and server. Contains state schemas, operation flags, input/output schemas, scope declarations, and `apply()` for optimistic operations only.

```ts
import { channel, shard, operation } from "kio/core"

export const gameChannel = channel.durable("game")
  .shard("world", worldState)
  .shardPerResource("seat", seatState)

  .operation("useItem", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: useItemInput,
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {                     // ✓ required here
      const inv = seat(input.seatId).inventory
      inv.splice(inv.findIndex(i => i.id === input.itemId), 1)
    },
  })

  .operation("rollDice", {
    execution: "computed",
    versionChecked: true,
    deduplicate: true,
    input: rollDiceInput,
    serverResult: rollDiceResult,
    scope: () => [shard.ref("world")],
    // No apply() here — type error if you try
  })
```

Because `useItem` is optimistic, `apply()` belongs in the shared schema — both client and server need it. Because `rollDice` is computed, the type system forbids `apply()` here. The client doesn't run `apply()` for computed operations; it waits for the server's result and broadcast.

### `schema.server.ts` — server-only logic

Never imported by the client. Adds `validate()`, `compute()`, and `apply()` for non-optimistic operations.

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const serverEngine = engine()
  .register(
    gameChannel
      .serverImpl("useItem", {
        validate({ seat }, input, ctx, { reject }) {     // ✓ server-only
          if (!seat(input.seatId).inventory.some(i => i.id === input.itemId)) {
            return reject("ITEM_NOT_FOUND", "Item not in inventory")
          }
        },
        // No apply() — type error, already in shared schema
      })
      .serverImpl("rollDice", {
        validate({ world }, input, ctx, { reject }) {    // ✓ server-only
          if (world.gameStage !== "PLAYING") return reject("NOT_PLAYING", "Game is not active")
        },
        compute({ world }, input) {                      // ✓ server-only
          return { results: input.dice.map(d => Math.floor(Math.random() * d.max) + 1) }
        },
        apply({ world }, input, serverResult) {          // ✓ required here
          world.diceResults[input.target] = { ... }
        },
      })
  )
  .register(presenceChannel)
```

The type system knows that `useItem` already has `apply()` in the shared schema, so providing it again in `serverImpl` is a compile error. Conversely, `rollDice` is computed, so `apply()` is required here — omitting it is a compile error.

### `schema.client.ts` — client-only logic

Never imported by the server. Adds `canRetry()` and any other client-specific hooks.

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const clientEngine = engine()
  .register(
    gameChannel
      .clientImpl("useItem", {
        canRetry(input, { seat }) {                      // ✓ client-only
          return seat(input.seatId).inventory.some(i => i.id === input.itemId)
        },
      })
  )
  .register(presenceChannel)
```

### Entrypoints

Each side imports only its engine. The bundler tree-shakes the rest.

```ts
// server.ts — bundles schema.ts + schema.server.ts, never schema.client.ts
import { serverEngine } from "./schema.server"
const server = createServer(serverEngine, { ... })

// client.ts — bundles schema.ts + schema.client.ts, never schema.server.ts
import { clientEngine } from "./schema.client"
const client = createClient(clientEngine, { ... })
```

## What this guarantees

The three-file split is not a convention you have to remember — the compiler enforces it:

- **Client bundle never contains `validate()` or `compute()`** — they only exist in `schema.server.ts`, which the client never imports.
- **Server bundle never contains `canRetry()`** — it only exists in `schema.client.ts`, which the server never imports.
- **`apply()` placement is compiler-enforced** — the `execution` flag determines which file it goes in. Put it in the wrong place and you get a type error.
- **Completeness is compiler-enforced** — the type system requires a `serverImpl` for every operation that needs server-only code. Optimistic operations with no validation don't need one. The same logic applies for `clientImpl`.

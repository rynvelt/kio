---
title: Client Setup
description: "How to wire schema.client.ts and create a client"
sidebar:
  order: 3
---

:::note[Status: Design Only]
This guide describes the target API. Implementation has not started.
:::

The previous guide showed the [server-side schema](/guides/server-setup/) — validation, computed results, and `apply()` for non-optimistic operations. This guide covers the other half: the client-side schema and the framework-agnostic client that connects to the server.

## The client schema file

The shared `schema.ts` defines channels, shards, operations, and any `apply()` functions needed for optimistic predictions. The server schema (`schema.server.ts`) adds `validate()`, `compute()`, and `apply()` for operations the server owns. The client schema (`schema.client.ts`) is the third piece — it adds client-specific hooks.

Right now, the only client-side hook is `canRetry`.

### What `canRetry` does

When the server rejects a version-checked optimistic operation, the client needs to decide: should it resubmit against the new authoritative state, or give up?

Consider a "use item" operation. The client applied it optimistically, but another player's action changed the shard version. The server rejects the operation with a version conflict. The item is still in the player's inventory — the operation is still valid. The client should retry automatically.

Now consider the same operation, but another player already consumed the item. The item is gone from the authoritative state. Retrying would fail validation. The client should not retry.

`canRetry` encodes this decision. It receives the original input and the current shard state (after the server's broadcast) and returns a boolean:

```ts
canRetry(input, { seat }) {
  return seat(input.seatId).inventory.some(i => i.id === input.itemId)
}
```

If `canRetry` returns `true`, the engine resubmits the operation automatically with the new version. If it returns `false`, the engine clears the pending state and the rejection surfaces to the consumer.

### Building the client engine

The client engine mirrors the server engine's structure — call `engine()`, attach channels, and use `.clientImpl()` to add hooks per operation:

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const clientEngine = engine()
  .channel(
    gameChannel
      .clientImpl("useItem", {
        canRetry(input, { seat }) {
          return seat(input.seatId).inventory.some(i => i.id === input.itemId)
        },
      })
      .clientImpl("visitLocation", {
        canRetry(input, { seat }) {
          return !seat(input.seatId).visitedLocations.has(input.locationSlug)
        },
      })
      .clientImpl("transferItem", {
        canRetry(input, { seat }) {
          return seat(input.fromSeatId).inventory.some(i => i.id === input.itemId)
        },
      })
      // rollDice, chooseDialogueOption: no clientImpl needed (no canRetry)
  )
  .channel(presenceChannel)
```

A few things to notice:

**Not every operation needs a `clientImpl`.** `rollDice` is a computed operation — the server produces the result, and the client waits for the broadcast. There is no optimistic prediction to retry. `chooseDialogueOption` is confirmed — same story. If an operation has no client-side hooks, skip `clientImpl` entirely.

**The shard accessors match the shared schema.** The second argument to `canRetry` provides accessor functions (`seat`, `world`, etc.) that read the current authoritative state. These are the same accessors available in `apply()` and `validate()` — typed from the shard definitions in `schema.ts`.

**`canRetry` only runs after a version conflict rejection.** If the server rejects an operation for a domain reason (like `ITEM_NOT_FOUND` from `validate()`), the engine does not call `canRetry`. Domain rejections are final.

### When to use `canRetry`

A useful heuristic: if the operation is optimistic and version-checked, ask yourself "could a concurrent change from another actor make my operation's precondition false?" If yes, write a `canRetry` that checks that precondition against fresh state.

| Operation | Optimistic? | Version-checked? | Needs `canRetry`? | Why |
|---|---|---|---|---|
| `useItem` | Yes | Yes | Yes | Another player could consume the item |
| `visitLocation` | Yes | Yes | Yes | Another operation could mark it visited |
| `transferItem` | No (confirmed) | Yes | Yes | Source item could be consumed |
| `rollDice` | No (computed) | Yes | No | Server generates the result; nothing to retry |
| `chooseDialogueOption` | No (confirmed) | Yes | No | Dialogue state is per-seat; conflicts are rare and domain-level |
| `updateLocation` | Yes | No | No | Not version-checked; latest-wins semantics |

Confirmed operations can still benefit from `canRetry` when their preconditions might change due to concurrent activity. `transferItem` is confirmed (the client does not predict the result) but version-checked — if two transfers race, the loser gets a version conflict. `canRetry` checks whether the item still exists in the source seat.

## Creating the client

With the client engine defined, wire it to a transport and create the client:

```ts
import { createClient } from "kio/client"
import { socketIoTransport } from "kio-transport-socketio"
import { clientEngine } from "./schema.client"

const client = createClient(clientEngine, {
  transport: socketIoTransport({ url: "wss://api.example.com/ws" }),
})
```

`createClient` returns a client instance that manages the connection, shard stores, and the submit pipeline. The transport adapter handles the wire protocol — the client doesn't know or care whether it's using Socket.IO, raw WebSockets, or something else.

### Submitting operations

The client exposes a typed `submit` method scoped to a channel:

```ts
const result = await client.channel("game").submit("useItem", {
  seatId: "seat:3",
  itemId: "potion-1",
})
```

Both the operation name and the input shape are fully typed from the schema. Passing an unknown operation name or a malformed input is a compile-time error.

For optimistic operations, `submit` applies the prediction immediately (via the shared `apply()` function) and then waits for the server to confirm or reject. The returned promise resolves when the server responds — but the UI already reflects the optimistic state.

For confirmed and computed operations, `submit` sends the operation to the server and waits. The UI updates when the server broadcasts the new state.

### Reading state

The client can read shard state directly:

```ts
const world = client.channel("game").state("world")
const mySeat = client.channel("game").state("seat", "seat:3")
```

These return the resolved state — the engine handles optimistic merging internally. For richer information (sync status, pending operations), use the `ShardState` API described in [Client State](/concepts/client-state/).

### Subscriptions are server-managed

There is no `client.subscribe()` call. The server controls which shards each client receives through the [subscription shard](/concepts/subscriptions/). On first connect, the server's `defaultSubscriptions()` hook populates the actor's subscription shard. After that, the server grants or revokes access by submitting operations to the subscriptions channel.

The client receives shard updates automatically based on its subscription shard state. If the server grants access to a new shard, the client starts receiving broadcasts for it. If the server revokes access, the shard transitions to `"unavailable"` and its state is cleared.

This design keeps authorization in one place (the server) and eliminates a class of bugs where the client requests access to shards it shouldn't see.

## File structure recap

At this point, the full schema setup spans three files:

| File | Imported by | Contains |
|---|---|---|
| `schema.ts` | Client and server | Channels, shards, operations, shared `apply()` |
| `schema.server.ts` | Server only | `validate()`, `compute()`, server-only `apply()` |
| `schema.client.ts` | Client only | `canRetry()` |

The shared schema is the contract. The server and client schemas add platform-specific hooks without leaking implementation details across the boundary.

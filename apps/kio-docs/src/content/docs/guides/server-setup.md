---
title: Server Setup
description: "How to wire schema.server.ts and create a server with hooks"
sidebar:
  order: 2
---

:::note[Status: Design Only]
This guide describes the target API. Implementation has not started.
:::

The shared schema (`schema.ts`) defines channels, shards, and operations that both client and server can see. But the server needs more: validation logic that rejects bad input, computation for server-generated data, and `apply()` functions for operations that the client does not predict.

This guide covers two files:

1. **`schema.server.ts`** — server-only implementations for each operation.
2. **`server.ts`** — wiring the engine to a transport, persistence layer, and lifecycle hooks.

## Server-side operation implementations

Each operation defined in the shared schema needs a server-side implementation. You attach these with `.serverImpl()`, which chains onto the channel definition you imported from the shared schema.

Start by importing the channels and creating a server engine:

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const serverEngine = engine()
  .channel(
    gameChannel
      // server implementations chained here
  )
  .channel(presenceChannel)
```

The `engine()` builder collects all channels with their server implementations into a single engine definition. This is what you pass to `createServer()` later.

### Validate-only implementations

The simplest server implementations only need `validate()`. For optimistic operations, the shared `apply()` already handles the state mutation — the server just needs to decide whether the operation is allowed.

```ts
      .serverImpl("visitLocation", {
        validate({ seat }, input, ctx, { reject }) {
          if (seat(input.seatId).visitedLocations.has(input.locationSlug)) {
            return reject("ALREADY_VISITED", "Location already visited")
          }
        },
      })
```

The `validate()` function receives the same shard accessors as `apply()`, but the state is **read-only** — you can inspect it but not mutate it. The fourth argument provides a `reject` callback, which is the only way to produce typed consumer errors. The error code (`"ALREADY_VISITED"`) must be one of the codes declared in the operation's `errors` schema. If you pass an invalid code, you get a type error.

Here is another validate-only implementation:

```ts
      .serverImpl("useItem", {
        validate({ seat }, input, ctx, { reject }) {
          const item = seat(input.seatId).inventory.find(i => i.id === input.itemId)
          if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory")
          if (item.quantity < 1) return reject("INSUFFICIENT_QUANTITY", "No uses left")
        },
      })
```

After `validate()` passes, the engine runs the shared `apply()` from the schema, persists the result, and broadcasts. You do not redefine `apply()` here for optimistic operations — it already exists in the shared schema.

### Computed implementations

Computed operations need three hooks: `validate()`, `compute()`, and `apply()`. The `apply()` lives here (not in the shared schema) because it depends on the server-generated result.

```ts
      .serverImpl("rollDice", {
        validate({ world }, input, ctx, { reject }) {
          if (world.gameStage !== "PLAYING") return reject("NOT_PLAYING", "Game is not active")
        },
        compute({ world }, input) {
          return {
            results: input.dice.map(d => Math.floor(Math.random() * d.max) + 1),
          }
        },
        apply({ world }, input, serverResult) {
          world.diceResults[input.target] = {
            sum: serverResult.results.reduce((a, b) => a + b, 0),
            rolls: input.dice.map((d, i) => ({
              max: d.max,
              result: serverResult.results[i],
            })),
          }
        },
      })
```

The pipeline for a computed operation is: `validate()` checks preconditions, `compute()` generates data the client cannot produce (here, random dice results), and `apply()` uses both the input and the computed result to mutate state. The `serverResult` is broadcast to clients so they can see the final state.

Notice that `compute()` receives read-only shard state — it can read current state to inform the computation, but it does not mutate anything. Only `apply()` mutates.

### Confirmed implementations

Confirmed operations are like computed ones but without a `compute()` step. The server validates and applies:

```ts
      .serverImpl("chooseDialogueOption", {
        validate({ seat }, input, ctx, { reject }) {
          // return reject("DIALOGUE_NOT_ACTIVE", "...") if dialogue is not active
          // return reject("INVALID_OPTION", "...") if option index out of range
        },
        apply({ seat }, input) {
          // advance dialogue state
        },
      })
```

The `apply()` here is the only `apply()` for this operation — there is no shared version in the schema because the client does not predict confirmed operations.

### Cross-shard implementations

Operations that touch multiple shards work the same way. The shard accessor gives you access to all shards declared in `scope()`:

```ts
      .serverImpl("transferItem", {
        validate({ seat }, input, ctx, { reject }) {
          if (!seat(input.fromSeatId).inventory.some(i => i.id === input.itemId)) {
            return reject("ITEM_NOT_FOUND", "Item not in source inventory")
          }
        },
        apply({ seat }, input) {
          const from = seat(input.fromSeatId)
          const to = seat(input.toSeatId)
          const idx = from.inventory.findIndex(i => i.id === input.itemId)
          const [item] = from.inventory.splice(idx, 1)
          to.inventory.push(item)
        },
      })
```

Both `seat(input.fromSeatId)` and `seat(input.toSeatId)` are available because the operation's `scope()` in the shared schema declared both. The engine loads both shards, checks both versions, and writes both atomically.

### Ephemeral channels

Ephemeral channels with only optimistic operations may not need any server-side implementations — the shared `apply()` is sufficient. In that case, pass the channel directly:

```ts
  .channel(presenceChannel)
```

If an ephemeral channel does have operations that need server validation, you chain `.serverImpl()` the same way as with durable channels.

### Complete schema.server.ts

Here is the full server-side schema file:

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const serverEngine = engine()
  .channel(
    gameChannel
      .serverImpl("visitLocation", {
        validate({ seat }, input, ctx, { reject }) {
          if (seat(input.seatId).visitedLocations.has(input.locationSlug)) {
            return reject("ALREADY_VISITED", "Location already visited")
          }
        },
      })
      .serverImpl("useItem", {
        validate({ seat }, input, ctx, { reject }) {
          const item = seat(input.seatId).inventory.find(i => i.id === input.itemId)
          if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory")
          if (item.quantity < 1) return reject("INSUFFICIENT_QUANTITY", "No uses left")
        },
      })
      .serverImpl("rollDice", {
        validate({ world }, input, ctx, { reject }) {
          if (world.gameStage !== "PLAYING") return reject("NOT_PLAYING", "Game is not active")
        },
        compute({ world }, input) {
          return {
            results: input.dice.map(d => Math.floor(Math.random() * d.max) + 1),
          }
        },
        apply({ world }, input, serverResult) {
          world.diceResults[input.target] = {
            sum: serverResult.results.reduce((a, b) => a + b, 0),
            rolls: input.dice.map((d, i) => ({
              max: d.max,
              result: serverResult.results[i],
            })),
          }
        },
      })
      .serverImpl("chooseDialogueOption", {
        validate({ seat }, input, ctx, { reject }) {
          // return reject("DIALOGUE_NOT_ACTIVE", "...") if dialogue is not active
          // return reject("INVALID_OPTION", "...") if option index out of range
        },
        apply({ seat }, input) {
          // advance dialogue state
        },
      })
      .serverImpl("transferItem", {
        validate({ seat }, input, ctx, { reject }) {
          if (!seat(input.fromSeatId).inventory.some(i => i.id === input.itemId)) {
            return reject("ITEM_NOT_FOUND", "Item not in source inventory")
          }
        },
        apply({ seat }, input) {
          const from = seat(input.fromSeatId)
          const to = seat(input.toSeatId)
          const idx = from.inventory.findIndex(i => i.id === input.itemId)
          const [item] = from.inventory.splice(idx, 1)
          to.inventory.push(item)
        },
      })
  )
  .channel(presenceChannel)
```

## Creating the server

With the engine defined, you wire it up to a transport, persistence layer, and lifecycle hooks in `server.ts`.

```ts
import { createServer } from "kio/server"
import { socketIoTransport } from "kio-transport-socketio"
import { prismaAdapter } from "kio-adapter-prisma"
import { serverEngine } from "./schema.server"
```

`createServer()` takes the engine and a configuration object:

```ts
const server = createServer(serverEngine, {
  transport: socketIoTransport({ port: 3000 }),
  persistence: prismaAdapter(prisma),
  // hooks follow...
})
```

The **transport** handles WebSocket connections. Kio ships transport adapters as separate packages — `kio-transport-socketio` wraps Socket.IO, but you could use any transport that implements the adapter interface. See [Transport](/reference/transport/) for the adapter contract.

The **persistence** adapter handles reading and writing shard state. `kio-adapter-prisma` wraps Prisma, but any adapter that implements compare-and-swap semantics works. See [Persistence](/reference/persistence/) for details.

### Authentication

The `authenticate` hook runs when a client opens a WebSocket connection. It receives the raw upgrade request and returns an actor object:

```ts
  authenticate(upgradeRequest) {
    const session = await verifySession(upgradeRequest.headers.cookie)
    return {
      actorId: session.playerId,
      displayName: session.alias,
    }
  },
```

The returned object must include `actorId: string` — the engine uses this for broadcast metadata and operation context. Everything else on the object is consumer-defined. Whatever you return here becomes `ctx.actor` in all operation hooks.

If authentication fails (invalid session, expired token), throw an error. The engine will reject the connection.

### Authorization

The `authorize` hook runs before each operation is processed. It decides whether the actor is allowed to submit this operation against these shards:

```ts
  authorize(actor, operationName, shardRefs) {
    const seatId = seatAssignments.getSeatForPlayer(actor.actorId)
    return shardRefs.every(ref => canSeatAccess(seatId, ref))
  },
```

Return `true` to allow, `false` to reject. This is where you enforce access control — making sure players can only modify their own seat, spectators cannot write, etc. The `shardRefs` array comes from the operation's `scope()`, so you know exactly which shards the operation wants to touch.

### Default subscriptions

When a client connects, it needs to know which shards to subscribe to. The `defaultSubscriptions` hook returns the initial set:

```ts
  defaultSubscriptions(actor) {
    const roomId = roomAssignments.getRoomForPlayer(actor.actorId)
    const seatId = seatAssignments.getSeatForPlayer(actor.actorId, roomId)
    return [
      { channelId: "game", shardId: "world" },
      { channelId: "game", shardId: `seat:${seatId}` },
      { channelId: "presence", shardId: `player:${actor.actorId}` },
    ]
  },
```

The engine sends the current state for each of these shards to the client immediately after the handshake. The client can request additional subscriptions later (e.g., subscribing to another player's presence shard), subject to authorization.

### Connection lifecycle hooks

`onConnect` and `onDisconnect` let you react to connection events. A common pattern is updating presence state:

```ts
  onConnect(actor) {
    server.submit("presence", "setOnline", { playerId: actor.actorId })
  },

  onDisconnect(actor) {
    server.submit("presence", "setOffline", { playerId: actor.actorId })
  },
```

These hooks use `server.submit()` — the server submitting operations through the same pipeline as clients. Same `apply()`, same persistence, same broadcast. The server is just another participant. See [Hooks](/reference/hooks/) for additional lifecycle hooks.

### Complete server.ts

```ts
import { createServer } from "kio/server"
import { socketIoTransport } from "kio-transport-socketio"
import { prismaAdapter } from "kio-adapter-prisma"
import { serverEngine } from "./schema.server"

const server = createServer(serverEngine, {
  transport: socketIoTransport({ port: 3000 }),
  persistence: prismaAdapter(prisma),

  authenticate(upgradeRequest) {
    const session = await verifySession(upgradeRequest.headers.cookie)
    return {
      actorId: session.playerId,
      displayName: session.alias,
    }
  },

  authorize(actor, operationName, shardRefs) {
    const seatId = seatAssignments.getSeatForPlayer(actor.actorId)
    return shardRefs.every(ref => canSeatAccess(seatId, ref))
  },

  defaultSubscriptions(actor) {
    const roomId = roomAssignments.getRoomForPlayer(actor.actorId)
    const seatId = seatAssignments.getSeatForPlayer(actor.actorId, roomId)
    return [
      { channelId: "game", shardId: "world" },
      { channelId: "game", shardId: `seat:${seatId}` },
      { channelId: "presence", shardId: `player:${actor.actorId}` },
    ]
  },

  onConnect(actor) {
    server.submit("presence", "setOnline", { playerId: actor.actorId })
  },

  onDisconnect(actor) {
    server.submit("presence", "setOffline", { playerId: actor.actorId })
  },
})
```

## Server-initiated operations

The `server` object returned by `createServer()` is not just a passive listener. It can submit operations, trigger broadcasts, and drive game logic from outside the request cycle.

### Timers and external events

Game logic often needs to react to timers or external triggers. Use `server.submit()`:

```ts
onGameTimerExpired(roomId, () => {
  server.submit("game", "changeGameStage", { gameStage: "FINISHED" })
})
```

This submits through the same pipeline as client operations — `validate()`, version check, `apply()`, persist, broadcast. No special "admin" path.

### Controlled broadcasting

For ephemeral channels with `autoBroadcast: false`, you control when state reaches clients:

```ts
setInterval(() => {
  server.broadcastDirtyShards("presence")
}, 5000)
```

This broadcasts the latest state for all presence shards that have changed since the last broadcast. Updates that happened multiple times between broadcasts are coalesced — only the latest state is sent. This is useful for high-frequency, low-urgency data where broadcasting every update would waste bandwidth.

## What hooks run where

Here is a summary of where each piece of logic lives and when it runs:

| Hook | Defined in | Runs on | Purpose |
|---|---|---|---|
| `scope()` | `schema.ts` | Client + Server | Declare which shards an operation touches |
| `apply()` (optimistic) | `schema.ts` | Client + Server | Shared state mutation |
| `apply()` (computed/confirmed) | `schema.server.ts` | Server only | State mutation needing server data |
| `validate()` | `schema.server.ts` | Server only | Reject invalid operations |
| `compute()` | `schema.server.ts` | Server only | Generate data the client cannot |
| `authenticate()` | `server.ts` | Server only | Verify connection identity |
| `authorize()` | `server.ts` | Server only | Check operation permissions |
| `defaultSubscriptions()` | `server.ts` | Server only | Initial shard subscriptions |
| `onConnect()` / `onDisconnect()` | `server.ts` | Server only | React to connection lifecycle |

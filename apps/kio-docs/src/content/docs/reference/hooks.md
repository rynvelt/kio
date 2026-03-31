---
title: Hooks & Extension Points
description: All lifecycle, authorization, and operation hooks with signatures
sidebar:
  order: 6
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

Hooks let the consumer inject logic at key points in the engine's lifecycle — authentication, authorization, operation processing, and serialization. All hooks are optional. The engine has sensible defaults for everything, and you add hooks only where your application needs custom behavior.

If a hook throws, the engine treats it as a rejection. The operation is not applied, the client receives a structured error, and the engine continues processing other operations. Hooks never crash the engine.

## Connection lifecycle

These hooks run when clients connect and disconnect.

### `authenticate(conn)`

Runs once per connection, before anything else. Validates credentials (token, session cookie, API key — whatever the consumer uses) and returns an actor object.

The returned actor must include `actorId: string`. Beyond that, the consumer can attach any fields they need — display name, role, team ID, permissions bitfield. The actor object is available as `ctx.actor` in all subsequent hooks for this connection.

If `authenticate` throws or returns a rejection, the connection is closed immediately. No further hooks run.

### `defaultSubscriptions(actor)`

Returns the initial set of [shard refs](/concepts/subscriptions/) for a new actor's subscription shard. Called once — when the subscription shard is first created (typically on the actor's first-ever connection), not on every reconnect.

The actor's own subscription shard ref is always included automatically. You don't need to return it.

```ts
defaultSubscriptions(actor) {
  // Every new player starts subscribed to the world shard
  // and their own seat's inventory
  return [
    { channel: "game", shard: "world" },
    { channel: "game", shard: `seat:${actor.seatNumber}:inventory` },
  ]
}
```

### `subscriptionsOnConnect(actor, conn, channelName)`

Optional override that replaces the default subscription-shard reading for a specific connection. Returns shard refs for the given channel.

Use this when subscriptions depend on connection-specific context rather than persisted state — URL query parameters, connection metadata, or external systems.

```ts
subscriptionsOnConnect(actor, conn, channelName) {
  if (channelName === "game") {
    const roomId = conn.query.roomId
    return [
      { channel: "game", shard: `room:${roomId}:world` },
    ]
  }
}
```

When this hook is provided for a channel, the engine skips reading the subscription shard for that channel on connect. The hook's return value is the complete subscription set.

### `onConnect(actor)`

Called after authentication and initial subscription setup are complete. This is the right place to submit operations that should happen on every connection — like [presence](/guides/presence/) updates.

```ts
onConnect(actor) {
  server.submit("presence", "setOnline", { playerId: actor.id })
}
```

### `onDisconnect(actor, reason)`

Called when a connection drops. The `reason` parameter indicates why — client-initiated close, transport timeout, server shutdown, etc.

```ts
onDisconnect(actor, reason) {
  server.submit("presence", "setOffline", { playerId: actor.id })
}
```

## Authorization

Authorization hooks control who can submit operations and who can subscribe to shard updates.

### `authorize(actor, operationName, shardRefs)`

Runs on every operation submission. This is the sole authority for write access — the subscription shard does not affect write authorization. A player might be subscribed to a shard (can see it) but not authorized to write to it (spectator mode), or authorized to write to a shard they're not subscribed to (server-side bookkeeping).

```ts
authorize(actor, operationName, shardRefs) {
  // Only the player in a seat can modify that seat's inventory
  for (const ref of shardRefs) {
    if (ref.shard.startsWith("seat:") && !ref.shard.startsWith(`seat:${actor.seatNumber}:`)) {
      throw new AuthorizationError("Cannot modify another player's inventory")
    }
  }
}
```

### `authorizeSubscription(actor, shardRefs)`

Optional override for subscription authorization. By default, the engine checks the actor's subscription shard to determine which shards they're allowed to receive updates for. If this hook is provided, it replaces the subscription shard check entirely.

Use this when subscription authorization comes from an external source (a permissions service, database lookup, or computed rule) rather than from the subscription shard.

## Subscriptions and the subscriber map

The engine maintains an in-memory map that tracks which connections are subscribed to which shards:

```ts
// Engine internal — not exposed to consumers
connections: Map<connectionId, {
  actor: Actor,
  subscribedShards: Set<ShardRef>
}>
```

This map is never persisted. On server reboot, it's gone entirely. The [subscription shard](/concepts/subscriptions/) is the persistent source of truth — the in-memory map is a runtime projection of it.

When a client reconnects after a server restart, the rebuild sequence is:

1. `authenticate()` runs — actor identity is restored.
2. Engine reads the actor's subscription shard — determines which shard refs this actor is allowed to see.
3. Engine populates the subscriber map for this connection.
4. Client sends its local shard versions — server compares and sends full state for any stale shards.

When the subscription shard changes at runtime (a player is granted access to a new shard, or revoked from one), the engine updates the subscriber map to match. The subscriber map always reflects the current state of the subscription shard.

## Operation lifecycle

These hooks run during operation processing, after authorization has passed.

### `beforeApply(operation, shardStates, ctx)`

Called before the operation's `apply()` function runs. Receives the operation, current shard states, and context (including `ctx.actor`).

Use this to transform operations (normalize input, inject server-side timestamps) or reject them based on state-dependent rules that go beyond static authorization.

```ts
beforeApply(operation, shardStates, ctx) {
  if (operation.name === "useItem") {
    const inventory = shardStates.get(`seat:${ctx.actor.seatNumber}:inventory`)
    if (!inventory.items.includes(operation.payload.itemId)) {
      throw new ValidationError("Player does not have this item")
    }
  }
}
```

If `beforeApply` throws, the operation is rejected. `apply()` never runs.

### `afterApply(operation, oldStates, newStates, ctx)`

Called after `apply()` has run and the new shard states have been computed (but before persistence and broadcast). Receives both old and new states for comparison.

This is the right place for side effects that should happen in response to state changes: audit logging, analytics events, triggering operations on other channels, or notifying external systems.

```ts
afterApply(operation, oldStates, newStates, ctx) {
  if (operation.name === "finishGame") {
    analytics.track("game_completed", {
      roomId: ctx.channelId,
      duration: newStates.get("world").elapsed,
    })
  }
}
```

If `afterApply` throws, the engine logs the error but does not reject the operation — the state change has already been computed. The operation proceeds to persistence and broadcast. This prevents side-effect failures from blocking gameplay.

## Serialization

The engine uses a codec interface for serializing messages between server and client:

```ts
interface Codec {
  encode(message: unknown): ArrayBuffer | string
  decode(data: ArrayBuffer | string): unknown
}
```

The default codec is an extended JSON codec that handles `Set` and `Map` types. Standard `JSON.stringify` silently breaks these — a `Set` becomes `{}`, a `Map` becomes `{}`. The default codec serializes them as tagged arrays:

```json
{ "__set": ["a", "b", "c"] }
{ "__map": [["key1", "value1"], ["key2", "value2"]] }
```

If you need something different — msgpack for smaller payloads, protobuf for schema-enforced encoding, or a custom format — replace the codec entirely:

```ts
const server = createServer(engine, {
  codec: {
    encode: (msg) => msgpack.encode(msg),
    decode: (data) => msgpack.decode(data),
  },
})
```

Both server and client must use the same codec. The engine does not negotiate encoding — it's a configuration decision made at setup time.

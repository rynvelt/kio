---
title: Subscriptions
description: How the subscription shard controls per-actor read access and drives authorization
sidebar:
  order: 3
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

The engine maintains a built-in **subscription shard** per actor — a per-resource shard on a dedicated `subscriptions` channel. It tracks which [shards](/concepts/shards/) the actor is allowed to subscribe to (read). This is the source of truth for read access and drives the engine's default authorization and initial subscription behavior.

## State shape

```ts
// subscriptions:{actorId}
{
  refs: [
    { channelId: "game", shardId: "world" },
    { channelId: "game", shardId: "seat:3" },
    { channelId: "presence", shardId: "player:alice" },
  ]
}
```

A shard ref being present means the actor is allowed to subscribe. Absence means denied. There is no explicit "denied" entry — not present = not allowed.

## Persistence

The consumer chooses whether the subscriptions channel is durable or ephemeral when configuring the engine. Durable means subscription state survives server restarts. Ephemeral means it's rebuilt via `onConnect` on reconnect.

## Bootstrap

On first connect, if the subscription shard for an actor doesn't exist, the engine creates it with a consumer-provided default set (via `defaultSubscriptions(actor)` hook). If no hook is provided, the shard is created empty. The actor always has access to its own subscription shard — this is hardcoded by the engine, not stored in the shard itself.

## Built-in operations

The engine provides two server-only operations on the subscriptions channel:

- **`grant`** — adds a shard ref to an actor's subscription shard.
- **`revoke`** — removes a shard ref from an actor's subscription shard.

These operations reject any submission where `ctx.actor.actorId !== KIO_SERVER_ACTOR`. Only the server-as-actor can modify subscription shards. The engine owns the mechanism; the consumer owns the policy (when and why to grant or revoke).

```ts
// Consumer's game logic triggers subscription changes via server-as-actor
server.submit("subscriptions", "grant", {
  actorId: "bob",
  ref: { channelId: "presence", shardId: "player:alice" },
})

server.submit("subscriptions", "revoke", {
  actorId: "bob",
  ref: { channelId: "presence", shardId: "player:alice" },
})
```

## Concurrency

If two operations modify the same actor's subscription shard concurrently (e.g., alice and carol both share with bob at the same time), the engine's standard OCC handles it. The second operation gets a version conflict, retries with fresh state, and succeeds. Since adding a ref to a set is always retryable regardless of what else was added, server-submitted operations with `maxRetries: 10` converge reliably.

## Integration with hooks

The subscription shard provides sensible defaults for authorization and initial subscriptions (see [Hooks & Extension Points](/reference/hooks/)). The consumer can override these hooks entirely if they want different logic.

## Client observability

The client subscribes to its own subscription shard like any other shard. Consumer code can watch it to react to access changes — for example, rendering a location-sharing panel when a new presence ref appears:

```tsx
function SharePanel() {
  const subscriptions = useShardState("subscriptions", "subscription", myActorId)
  if (subscriptions.syncStatus !== "latest") return null

  // Derive which presence shards we have access to
  const sharedPlayerIds = subscriptions.state.refs
    .filter(r => r.channelId === "presence" && r.shardId !== `player:${myActorId}`)
    .map(r => r.shardId)

  return sharedPlayerIds.map(shardId => (
    <SharedPlayerLocation key={shardId} shardId={shardId} />
  ))
}

function SharedPlayerLocation({ shardId }: { shardId: string }) {
  const presence = useShardState("presence", "player", shardId)

  if (presence.syncStatus === "unavailable") return <NotSharedYet />
  if (presence.syncStatus === "loading") return <Loading />
  return <PlayerMarker gps={presence.state.gps} />
}
```

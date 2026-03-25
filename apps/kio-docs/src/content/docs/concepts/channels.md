---
title: Channels
description: How channels group state by consistency model — durable vs ephemeral
sidebar:
  order: 1
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

A real-time application typically has different kinds of state with fundamentally different requirements:

- **Game state** needs to survive server restarts, must never diverge between clients, and requires conflict detection when two players act simultaneously.
- **Player presence** (GPS, online status) is disposable — if the server restarts, clients just re-send their location. There's no meaningful "conflict" because the latest value is always correct.

These need different consistency models. Forcing them into the same model means either over-engineering presence (why version-check a GPS update?) or under-protecting game state (why skip conflict detection?).

A **channel** groups state that shares the same consistency model:

- **Durable channels** — versioned, conflict-detected, persisted, recoverable. Operations go through the full pipeline: validate, check version, apply, persist, broadcast.
- **Ephemeral channels** — unversioned, unpersisted, latest-wins. No conflict detection. State is held in memory only and rebuilt naturally on reconnect.

One connection can participate in multiple channels.

## Broadcast control

By default, every applied operation immediately broadcasts the new shard state to all subscribers (`autoBroadcast: true`). For channels with high-frequency, low-urgency updates — presence, cursor positions, viewport state — the consumer can disable automatic broadcasting and control when broadcasts go out:

```ts
channel.ephemeral("presence", { autoBroadcast: false })
channel.durable("game", { autoBroadcast: false })
channel.durable("game", { broadcastMode: "full" })  // default: "patch"
```

With `autoBroadcast: false`, operations still apply immediately (server state is always current), but no broadcast is sent. Instead, the engine tracks which shards have changed since their last broadcast on a per-subscriber basis — a dirty set of shard IDs per subscriber. When a shard is updated, its ID is added to the dirty set of every subscriber of that shard.

The consumer triggers broadcasts explicitly via the server API:

```ts
server.broadcastDirtyShards(channelId: string, shardIds?: string[]): void
```

- Called with just `channelId`: broadcasts latest state for all dirty shards in that channel, then clears all dirty sets for that channel.
- Called with `shardIds`: broadcasts only those shards, removes only those IDs from dirty sets. Other dirty shards remain pending.

At broadcast time, the engine reads current in-memory state for each dirty shard — it does not store copies of state in the dirty set. This guarantees the broadcast always contains the latest state, even if the shard was updated multiple times between flushes.

This enables consumer-controlled broadcast policies:

```ts
// Broadcast presence every 5 seconds
setInterval(() => {
  server.broadcastDirtyShards("presence")
}, 5000)

// Broadcast a specific shard immediately (e.g., new player just joined)
server.broadcastDirtyShards("presence", [`player:${newPlayerId}`])
```

## Ephemeral channel semantics

Ephemeral channels differ from durable channels in several important ways:

| Aspect | Durable | Ephemeral |
|---|---|---|
| Versioned | Yes (per-shard) | No |
| Persisted | Yes (via adapter) | No (in-memory only) |
| Survives server restart | Yes | No — rebuilt on reconnect |
| Conflict detection | Yes (`versionChecked`) | No — latest value wins always |
| Out-of-order protection | Yes (version comparison) | No — brief staleness possible |
| Shard creation | Explicit (via persistence) | On first write |

**State loss on server restart:** All ephemeral state is lost. This is by design. On restart, clients reconnect, the consumer's `onConnect` hook fires (rebuilding server-driven state like online/offline), and the engine automatically resubmits each client's last known value for ephemeral shards they had local state for (rebuilding client-driven state like GPS location). The consumer doesn't need to handle this explicitly.

**No version, no ordering:** Ephemeral broadcasts carry no version number — the client always accepts the latest value it receives. If two broadcasts arrive out of order (network reordering), the client may briefly show a stale update. This is acceptable for presence-style data where the next update corrects it within seconds. If a consumer needs ordering for a specific ephemeral use case, they can include a timestamp in their state schema and filter client-side.

**Shard creation:** Ephemeral shards are created in memory on first write. When the server submits a presence operation for a player that has no shard yet, the engine creates it. No persistence adapter involved.

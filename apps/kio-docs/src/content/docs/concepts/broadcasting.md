---
title: Broadcasting
description: "State, not operations — how the server broadcasts shard snapshots to subscribers"
sidebar:
  order: 6
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

## Why state, not operations?

Many real-time frameworks broadcast a stream of operations and expect every client to replay them in order to arrive at the correct state. This works until a client misses a message, joins late, or receives events out of order. At that point you need conflict resolution, operation transforms, or a full resync protocol.

Kio takes a different approach: the server broadcasts **complete shard state snapshots**. Each broadcast is self-contained truth.

- **Can never diverge.** Every broadcast carries the full answer. There is no accumulated history to replay.
- **Ordering doesn't matter.** Each durable broadcast carries a version number. The client ignores anything older than what it already has.
- **Recovery is trivial.** A reconnecting client needs only the current state — the same thing every broadcast already delivers.
- **Sharding makes it efficient.** Because state is split into per-resource shards, each snapshot is small.

## Broadcast message shape

A broadcast message carries an array of shard entries scoped to a single channel. The channel's kind (durable or ephemeral) determines the shape, enforced by the type system:

```ts
type Patch = { op: "add" | "replace" | "remove"; path: string; value?: unknown }

type DurableShardEntry = {
  shardId: string
  version: number
  causedBy?: CausedBy
} & ({ state: unknown } | { patches: Patch[] })

type EphemeralShardEntry = {
  shardId: string
  causedBy?: CausedBy
} & ({ state: unknown } | { patches: Patch[] })

type BroadcastMessage =
  | { type: "broadcast"; channelId: string; kind: "durable"; shards: DurableShardEntry[] }
  | { type: "broadcast"; channelId: string; kind: "ephemeral"; shards: EphemeralShardEntry[] }
```

Lifting `channelId` and `kind` to the message level makes mixed-channel broadcasts structurally impossible. Durable entries always carry a `version`; ephemeral entries never do.

A single shard update is an array of length 1. A coalesced flush produces an array with multiple entries.

## State vs. patches

Each shard entry carries either `state` (full snapshot) or `patches` (Immer JSON Patch operations) — never both. The engine chooses based on the channel's `broadcastMode` and the specific broadcast context (initial connect always uses `state`).

`state` is the truth — the client uses it directly. `causedBy` is metadata for UI purposes (animations, notifications, sound effects). If `causedBy` is missing or unrecognized, the client still works — it just doesn't animate.

## Patch-based broadcasting

By default, the engine broadcasts **patches** (Immer's JSON Patch output) instead of full shard state. Since `apply()` runs on Immer drafts, the engine uses `produceWithPatches()` to capture patches automatically.

Patches describe only what changed. For a fog-of-war shard with 500 cells where 3 are added, the broadcast contains 3 patch operations instead of all 503 cells.

### When the engine sends full state instead

Even with patch mode enabled, the engine falls back to full state in these cases:

- **Initial connect and reconnect** — the client has no baseline to patch against.
- **Rejection with fresh state** — the client's optimistic prediction was wrong.
- **When the patch is larger than full state** — no point sending a bigger payload.

### Choosing a broadcast mode

Consumers can configure the mode per channel:

```ts
channel.durable("game", { broadcastMode: "full" })
channel.durable("game", { broadcastMode: "patch" })   // default
```

This is transparent to the client — the ShardStore handles both modes identically. `useShardState()` and `ShardState<T>` are unchanged regardless of which mode the server uses.

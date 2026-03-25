---
title: Shards
description: How shards partition state for independent versioning and parallel operations
sidebar:
  order: 2
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

Within a [channel](/concepts/channels/), not all state contends with all other state. Consider a 5-player game:

- When player 1 uses an item from their inventory, this doesn't conflict with player 2 visiting a location — their inventories are independent.
- But when player 1 transfers an item to player 2, both inventories must be updated atomically.

Without sharding, the entire game state has a single version counter. Player 1's inventory update and player 2's location visit would conflict (both target the same version), even though they touch unrelated data. Under load, this serializes all operations.

A **shard** is a piece of state with its own version counter. Operations declare which shards they touch. The engine only checks versions on affected shards, so independent operations proceed in parallel.

Two kinds:

- **Singleton shards** — one instance per channel (e.g., the game world all players see).
- **Per-resource shards** — one instance per resource ID (e.g., one inventory per seat).

Shards are identified by path-like string keys (`world`, `seat:3:inventory`). The engine treats these as opaque strings — the consumer defines the naming convention.

In persistence, each shard is a row:

```
channel_id  | shard_id             | version | state_json
------------|----------------------|---------|------------
room:abc    | world                | 22      | { ... }
room:abc    | seat:1:inventory     | 14      | { ... }
room:abc    | seat:2:inventory     | 9       | { ... }
```

Single-shard operations use a single compare-and-swap. Cross-shard operations (like item transfer) use a multi-row atomic write. Both are straightforward in SQL.

## State ownership

Shards are keyed by stable IDs that the consumer chooses — not by connection IDs. Connections are transient (they come and go), but state needs to outlive them.

Consider a multiplayer game with 5 seats. If you key state by player ID, then when player 4 disconnects: is their inventory gone? Can someone else take over? What if they reconnect?

If you instead key state by seat number (`seat:4:inventory`), the state exists regardless of who is connected. Player 4 disconnects: seat 4's state persists. Player 4 reconnects: they're mapped back to seat 4 and resume. A different player takes seat 4: they see the same state.

The engine doesn't know or care what shard IDs represent. The consumer controls which connections can read and write which shards via authorization hooks. This enables:

- Persistent state that survives disconnects
- Reassigning state to a different connection
- Read-only spectators (authorize reads but not writes)

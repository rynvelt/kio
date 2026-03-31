---
title: Operation Flags
description: "execution, versionChecked, and deduplicate — controlling operation behavior"
sidebar:
  order: 5
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

Not all operations behave the same way. A GPS update should apply instantly without waiting for the server. A dice roll requires server-side computation before the client can show anything. A chat message must never apply twice, but a location update can safely be duplicated.

Each operation in Kio declares three flags that control these behaviors: `execution`, `versionChecked`, and `deduplicate`. Together, they tell the engine exactly how to handle the operation on both client and server.

## `execution`

`"optimistic"` | `"confirmed"` | `"computed"`

This flag controls when the client applies the state change and whether the server contributes data.

### `"optimistic"`

The client runs `apply()` immediately and shows the result. The server confirms or rejects afterward. This is the right choice for operations where revealing the consequence does not spoil the experience — the player already knows what will happen because they initiated it.

Most commonly paired with `versionChecked: false` for pure overwrites where the server can never reject. No flicker, no rollback. When paired with `versionChecked: true`, the server may reject on version mismatch, causing a brief snap-back. Per-resource sharding reduces this conflict window significantly.

**Constraint: optimistic operations must touch exactly one shard.** If `scope()` returns multiple shard refs, `execution: "optimistic"` is a type error. Optimistic multi-shard operations would require atomic rollback across multiple ShardStores, with confusing intermediate states if one rolls back before the other. Cross-shard operations should use `confirmed` or `computed`.

Examples:
- *Update GPS location* (`versionChecked: false`) — pure overwrite, always accepted.
- *Toggle a setting* (`versionChecked: false`) — trivial state flip, always accepted.
- *Visit a location* (`versionChecked: true`) — optimistic show, rare conflicts.
- *Use item* (`versionChecked: true`) — optimistic removal, could snap back on concurrent transfer.

### `"confirmed"`

The client could compute the result, but waits for server confirmation before showing it. Use this when briefly showing a wrong or premature result would confuse players or break the game — revealing a puzzle solution, leaking story information, or showing state that snaps back.

Examples:
- *Choose a dialogue option* — showing the response before confirmation risks leaking narrative clues if the server rejects.
- *Submit a quiz answer* — briefly flashing "correct!" before a rollback would spoil the puzzle.
- *Claim a seat* — if two players claim simultaneously and one gets rejected, the snap-back is confusing.

### `"computed"`

The server must generate data the client does not have. The client waits, receives the server's result, then runs `apply()` with both input and result.

Examples:
- *Roll dice* — server generates random numbers.
- *Draw a card from a shuffled deck* — deck order is server-side.
- *Reveal a hidden clue* — conditions depend on other players' secret state.
- *Request an AI-generated hint* — server calls an external API.

## `versionChecked`

`boolean`

Controls whether the engine checks shard versions before applying.

- **`true`** — The operation's correctness depends on current state. The server rejects it if the shard was modified since the client last saw it.
- **`false`** — Pure overwrite. Previous state does not matter, so version conflicts are impossible.

## `deduplicate`

`boolean`

Controls whether the engine rejects duplicate operations. When `true`, the client includes a generated operation ID, and the engine rejects repeated IDs.

- **`true`** — Must not apply twice. (*Use item*, *send chat message*, *roll dice*.)
- **`false`** — Duplicates are harmless. (*Update GPS*, *set display name*.)

## All combinations

All combinations of the three flags are valid. Here is a representative example for each:

| execution | versionChecked | deduplicate | Example |
|---|---|---|---|
| `optimistic` | `true` | `true` | Use item — predict, show, check conflicts, prevent double-use |
| `optimistic` | `false` | `false` | Update GPS — overwrite, show immediately, duplicates harmless |
| `confirmed` | `true` | `true` | Claim seat — wait for confirmation, check conflicts |
| `confirmed` | `false` | `false` | Set "away" status — overwrite, wait for ack |
| `computed` | `true` | `true` | Roll dice — server computes, check turn, prevent double-roll |
| `computed` | `false` | `false` | Request welcome message — server computes, no state dependency |
| `optimistic` | `false` | `true` | Send chat message — show immediately, prevent duplicates |

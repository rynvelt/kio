---
title: Persistence Interface
description: StateAdapter — load, compareAndSwap, conformance tests
sidebar:
  order: 5
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

The persistence layer in Kio is a single interface called `StateAdapter`. It is deliberately minimal — the engine handles versioning, conflict detection, and recovery. The adapter's job is narrow: store versioned blobs and enforce compare-and-swap semantics.

## The StateAdapter interface

```ts
interface StateAdapter {
  load(channelId: string, shardId: string): Promise<{ state: T; version: number } | null>

  compareAndSwap(
    channelId: string,
    shardId: string,
    expectedVersion: number,
    newState: T,
    newVersion: number,
  ): Promise<boolean>

  compareAndSwapMulti(
    operations: Array<{
      channelId: string
      shardId: string
      expectedVersion: number
      newState: T
      newVersion: number
    }>
  ): Promise<boolean>
}
```

Three methods, no more:

- **`load`** — reads the current state and version for a single shard. Returns `null` if the shard doesn't exist yet.
- **`compareAndSwap`** — writes new state only if the shard's current version matches `expectedVersion`. Returns `true` on success, `false` if the version has moved on (meaning another write landed first).
- **`compareAndSwapMulti`** — atomic multi-shard write. All operations succeed or none do. Used for cross-shard operations like transferring an item between two inventories.

The engine never calls raw "set" or "update" — every write goes through compare-and-swap. This is what makes conflict detection possible at the persistence layer.

## Mapping to databases

The interface maps directly to every major database's conditional write primitive:

| Database | `compareAndSwap` implementation |
|---|---|
| SQL (Postgres, MySQL, SQLite) | `UPDATE ... SET state=$new, version=$v WHERE shard_id=$id AND version=$expected` |
| DynamoDB | Conditional put with `ConditionExpression: "version = :expected"` |
| Redis | `WATCH` / `MULTI` transaction on the shard key |

For `compareAndSwapMulti`, SQL databases use a single transaction with multiple conditional updates. DynamoDB uses `TransactWriteItems`. Redis uses `WATCH` on all affected keys followed by `MULTI` / `EXEC`.

The point of the narrow interface is that you don't need to learn a Kio-specific query language or ORM. You write native queries for your database, wrapped in three methods.

## Conformance tests

Every adapter must behave identically. To verify this, Kio ships a conformance test suite that you run against your adapter implementation:

```ts
import { runAdapterConformanceTests } from "kio-test-kit"

runAdapterConformanceTests({
  createAdapter: () => new PrismaStateAdapter(prisma),
})
```

The suite verifies the properties the engine depends on:

- **Read-after-write consistency** — `load()` after a successful `compareAndSwap()` returns the new version and state.
- **Exactly-one-wins under contention** — two concurrent `compareAndSwap()` calls targeting the same shard with the same `expectedVersion`: exactly one succeeds, exactly one fails.
- **Safe rejection** — `compareAndSwap()` with a wrong `expectedVersion` returns `false` and leaves state unchanged.
- **Multi-shard atomicity** — `compareAndSwapMulti()` is all-or-nothing. If any individual shard's version check fails, no shard is updated.

If your adapter passes the conformance suite, the engine will work correctly with it. If it doesn't, the suite will tell you exactly which property is violated.

## Runtime guards

Beyond what the adapter guarantees, the engine adds its own safety checks at runtime:

- **Version monotonicity** — the engine verifies that versions only increase. If an adapter returns a version lower than a previously observed version for the same shard, the engine treats this as a data corruption signal and halts the affected channel.
- **Post-write verification** — after a successful `compareAndSwap`, the engine may read back the shard to confirm the write landed. This catches adapter bugs where `compareAndSwap` returns `true` but the write was silently dropped (possible with misconfigured replication).
- **Error boundaries** — every adapter call is wrapped in try/catch. An adapter that throws does not crash the engine. The operation is rejected with a structured error, and the engine continues processing other operations.

These guards mean that even a subtly buggy adapter won't silently corrupt state. The engine fails loudly and narrowly — the affected operation is rejected, other channels and shards continue operating.

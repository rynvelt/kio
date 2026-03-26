# Phase 2: Runtime Server Engine

## Goal

Make the operation pipeline actually run: submit → validate → compute → apply → persist → broadcast.
Tested with in-memory transport and in-memory persistence.

## Prerequisites

- Immer composed root approach verified (done)
- Consumer-facing types validated (done)

## Steps

### 1. In-memory persistence adapter

Implements `StateAdapter` interface: `load`, `compareAndSwap`, `compareAndSwapMulti`.
Backed by a `Map<string, { state: unknown; version: number }>`.

**Test:** adapter conformance — CAS succeeds/fails on version match/mismatch, multi is atomic.

### 2. Server-side shard state manager

Holds in-memory shard state per channel. Responsibilities:
- Load shard state (from persistence adapter on first access, then cached)
- Build composed root object for a set of shard refs (for `apply`)
- Run `apply` via Immer `produceWithPatches`, decompose patches per shard
- Update cached state + version after successful CAS
- Track dirty shards per subscriber (for `autoBroadcast: false`)

**Test:** load, apply produces correct new state + patches, version increments.

### 3. Operation pipeline

The core path. Receives a submission (operation name, input, shard versions) and runs:
1. Input validation (StandardSchema `~standard.validate()`)
2. Authorization check (`authorize` hook)
3. Load scoped shards
4. Run `validate()` (server impl) — may reject via `reject()`
5. Run `compute()` (server impl, computed ops only)
6. Run `apply()` via Immer on composed root
7. Persist via `compareAndSwap` / `compareAndSwapMulti`
8. On CAS failure: reject with VERSION_CONFLICT + fresh state
9. On success: update cache, return acknowledgement + patches

**Test:** full pipeline for each execution mode (optimistic, confirmed, computed).
Version conflict rejection. Validation rejection with typed errors. Deduplication.

### 4. Broadcast

After successful apply:
- `autoBroadcast: true`: immediately send patches (or full state) to subscribers
- `autoBroadcast: false`: mark shards dirty, wait for `broadcastDirtyShards()`

Uses the direct-call transport (no network). Broadcast message uses the array-based format with channelId + kind.

**Test:** subscribers receive correct patches after operation. Dirty tracking + manual flush.

### 5. Server-as-actor

The server can submit operations through the same pipeline. Uses `KIO_SERVER_ACTOR` as actor.
`maxRetries` config for automatic retry on version conflicts.

**Test:** server submits operation, pipeline runs, state changes. Retry on conflict.

## Not in this phase

- Client-side ShardStore / reconciliation
- Transport adapters (socket.io, websocket)
- Persistence adapters (Prisma)
- Connection lifecycle (authenticate, subscriptions)
- Subscription shard

# Phase 2: Runtime Server Engine

## Status: Steps 1-4 complete, step 5 deferred

## Goal

Make the operation pipeline actually run: submit → validate → compute → apply → persist → broadcast.
Tested with in-memory transport and in-memory persistence.

## Prerequisites

- Immer composed root approach verified (done)
- Consumer-facing types validated (done)

## Steps

### 1. In-memory persistence adapter ✅

Implements `StateAdapter` interface: `load`, `set`, `compareAndSwap`, `compareAndSwapMulti`.
Backed by a `Map<string, { state: unknown; version: number }>`.

### 2. Server-side shard state manager ✅

Loads from persistence, caches, builds composed root, applies via Immer `produceWithPatches`,
decomposes patches per shard, persists via CAS or unconditional set.

### 3. Operation pipeline ✅

Dedup → input validation → authorize → scope → load → validate → compute → apply → persist.
Handles durable (CAS) and ephemeral (cache-only). versionChecked: false uses unconditional set.
Error boundaries catch apply/compute exceptions → INTERNAL_ERROR.

### 4. Broadcast manager ✅

`onOperationApplied()` — auto channels send patches, manual channels mark dirty.
`broadcastDirtyShards()` — flush full state to subscribers.

### 5. Server-as-actor — deferred to phase 3

## Open items from review (phase 3)

- **ChannelEngine** — higher-level orchestrator composing pipeline + broadcast + state manager
- **VERSION_CONFLICT fresh state** — rejection should include current shard state for canRetry
- **Server-as-actor retry** — submit with maxRetries config
- **Ephemeral versioning** — entries should not carry version numbers per vision doc
- **broadcastMode: "full"** — declared but unused; should send full state when configured

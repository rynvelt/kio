# Phase 2: Runtime Server Engine

## Status: Complete

## Goal

Make the operation pipeline actually run: submit → validate → compute → apply → persist → broadcast.
Tested with in-memory transport and in-memory persistence.

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

### 5. Server-as-actor ✅

Implemented in phase 3. Server submits via `server.submit()` with generated opIds.
`versionChecked: false` operations succeed unconditionally.

## Open items (resolved)

- **ChannelEngine** ✅ — orchestrates pipeline + broadcast + state manager
- **VERSION_CONFLICT fresh state** ✅ — rejection includes current shard state
- **Server-as-actor retry** — deferred; `versionChecked: false` covers most cases
- **Ephemeral versioning** ✅ — decided to keep version counters (diverges from vision, documented in phase 3 plan)
- **broadcastMode: "full"** ✅ — sends full state when configured

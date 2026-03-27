# Phase 3: Server Integration

## Status: Steps 1-2 complete

## Goal

Wire pipeline + broadcast + state manager behind the consumer-facing `createServer()` API
from VISION_v2.md Section 11.

## Steps

### 1. ChannelEngine (internal) ✅

Composes pipeline + broadcast + state manager for one channel.
State manager fires `onChange(shardId)` → broadcast manager's `onShardChanged()` for dirty tracking.
ChannelEngine calls `broadcastPatches()` for autoBroadcast channels.

### 2. createServer ✅

Consumer-facing entry point. Creates ChannelEngine per channel.
Type-safe: channel names, operation names, and inputs enforced at compile time.
Server-as-actor via `KIO_SERVER_ACTOR`.

### 3. VERSION_CONFLICT fresh state

Rejection result includes current shard state from the CAS failure.
Enables client-side `canRetry` to inspect state before resubmitting.

### 4. Server-as-actor retry

`server.submit()` accepts `{ maxRetries }` option.
On VERSION_CONFLICT, reloads shards and retries up to maxRetries.

### 5. Ephemeral versioning cleanup

Ephemeral broadcast entries should not carry version numbers.
Split BroadcastShardEntry into durable (with version) and ephemeral (without).

### 6. broadcastMode: "full"

When channel has `broadcastMode: "full"`, broadcast sends full state instead of patches.
BroadcastManager checks the setting in `broadcastPatches`.

## Not in this phase

- Client-side ShardStore / reconciliation
- Transport adapters (socket.io, websocket)
- Persistence adapters (Prisma)
- Connection lifecycle (authenticate, subscriptionsOnConnect)
- Subscription shard

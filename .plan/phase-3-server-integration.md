# Phase 3: Server Integration

## Status: Steps 1-2 complete, items 3-6 are deferred refinements

## Steps

### 1. ChannelEngine (internal) ✅

Composes pipeline + broadcast + state manager for one channel.
State manager fires `onChange(shardId)` → broadcast manager's `onShardChanged()` for dirty tracking.

### 2. createServer ✅

Consumer-facing entry point. Type-safe channel/operation names.
Transport wiring, connection handshake, server-as-actor.

### Remaining refinements

3. **VERSION_CONFLICT fresh state** — rejection should include current shard state for canRetry
4. **Server-as-actor retry** — maxRetries option on submit
5. **Ephemeral versioning cleanup** — ephemeral entries should not carry version numbers
6. **broadcastMode: "full"** — send full state instead of patches when configured

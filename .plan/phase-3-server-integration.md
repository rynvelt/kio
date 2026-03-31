# Phase 3: Server Integration

## Status: Steps 1-2 complete, items 3-5 are deferred refinements

## Steps

### 1. ChannelEngine (internal) ✅

Composes pipeline + broadcast + state manager for one channel.
State manager fires `onChange(shardId)` → broadcast manager's `onShardChanged()` for dirty tracking.

### 2. createServer ✅

Consumer-facing entry point. Type-safe channel/operation names.
Transport wiring, connection handshake, server-as-actor.

### Remaining refinements

3. **VERSION_CONFLICT fresh state** — rejection should include current shard state for canRetry. Add optional `shards` field to RejectMessage, populated only for VERSION_CONFLICT. Carries full state entries so the client can update authoritative state and evaluate canRetry.
4. **Server-as-actor retry** — maxRetries option on submit
5. **broadcastMode: "full"** — send full state instead of patches when configured

### Design decisions

- **Ephemeral versioning kept:** Ephemeral channels retain version counters. Durable/ephemeral only controls persistence and restart survival — versioning, conflict detection, deduplication, and execution mode are all independent of channel kind.
- **opId in CausedBy:** CausedBy gains a required `opId: string` field. Server-as-actor submits also generate opIds. Enables client-side reconciliation (matching broadcasts to pending operations).

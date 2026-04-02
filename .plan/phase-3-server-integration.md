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

3. **VERSION_CONFLICT fresh state** ✅ — rejection includes current shard state for canRetry. Optional `shards` field on RejectMessage and PipelineResult, populated for VERSION_CONFLICT by reloading from state manager after failed CAS.
4. **Server-as-actor retry** — deferred. Most server-as-actor operations use `versionChecked: false` (unconditional write with version increment), which never conflicts. For the rare `versionChecked: true` case, maxRetries can be added later.
5. **broadcastMode: "full"** ✅ — channel option `broadcastMode: "full"` sends complete shard state instead of patches on autoBroadcast. Exhaustive switch in ChannelEngine selects patch vs full broadcast.

### Design decisions

- **Ephemeral versioning kept:** Ephemeral channels retain version counters. Durable/ephemeral only controls persistence and restart survival — versioning, conflict detection, deduplication, and execution mode are all independent of channel kind.
- **opId in CausedBy** ✅: CausedBy gains a required `opId: string` field. Server-as-actor submits generate opIds (`server:N` pattern). Enables client-side reconciliation.
- **WelcomeMessage** ✅: Server sends `welcome` (with actorId + shard versions) instead of bidirectional `versions` message. Client responds with `versions` (its local shard versions).

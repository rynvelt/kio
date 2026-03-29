# Phase 4: Client-Side ShardStore

## Status: Steps 1-2 complete, steps 3-5 ready to implement

Steps 3-5 were blocked on the client-server loop (phase 5), which is now complete.
The ClientChannelEngine exists and can coordinate optimistic submit across ShardStores.

## Steps

### 1. Basic ShardStore ✅

Holds received state. Exposes snapshot with syncStatus (unavailable → loading → latest).
Subscriber notification. Constructor takes kind (durable/ephemeral).

### 2. Broadcast processing ✅

applyBroadcastEntry() — handles full state and patch entries.
Durable version check (ignore stale). Ephemeral always accepts.

### 3. Optimistic submit

ClientChannelEngine coordinates across multiple ShardStores:
- Run shared apply() with scoped shard accessors
- Set pending on affected ShardStores
- Snapshot reflects predicted state
- One pending per shard (reject if already pending)

### 4. Reconciliation

Broadcast arrives while pending exists:
- causedBy matches our opId → clear pending (confirmed)
- Someone else's change + versionChecked: true → discard prediction
- Someone else's change + versionChecked: false → re-compute prediction against new authoritative

### 5. Rejection handling

Server rejects our pending operation:
- Clear pending, revert to authoritative
- If versionChecked and canRetry() returns true → resubmit
- Notify subscribers

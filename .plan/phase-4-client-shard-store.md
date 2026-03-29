# Phase 4: Client-Side ShardStore

## Status: Steps 1-2 complete, steps 3-5 deferred to after phase 5

## Steps

### 1. Basic ShardStore ✅

Holds received state. Exposes snapshot with syncStatus (unavailable → loading → latest).
Subscriber notification. Constructor takes kind (durable/ephemeral).

### 2. Broadcast processing ✅

applyBroadcastEntry() — handles full state and patch entries.
Durable version check (ignore stale). Ephemeral always accepts.

### 3. Optimistic submit — after phase 5

Needs ClientChannelEngine to coordinate across multiple ShardStores.

### 4. Reconciliation — after phase 5

Broadcast arrives while pending: confirm, discard, or re-compute.

### 5. Rejection handling — after phase 5

Clear pending, revert, canRetry.

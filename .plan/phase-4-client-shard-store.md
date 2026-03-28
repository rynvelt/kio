# Phase 4: Client-Side ShardStore

## Goal

Implement the client-side ShardStore from VISION_v2.md Section 3.
Framework-agnostic, one instance per subscribed shard.

## Steps

### 1. Basic ShardStore

Holds authoritative state. Exposes `snapshot` with syncStatus:
- `unavailable` → no access
- `loading` → access granted, waiting for first state
- `latest` → has current state

Subscriber notification via `subscribe(listener)` → returns unsubscribe function.
Compatible with `useSyncExternalStore`.

### 2. Broadcast processing

Handle incoming broadcast entries:
- `state` (full snapshot) → replace authoritative
- `patches` → apply via Immer `applyPatches` to authoritative
- Durable: version check — ignore if `V <= authoritative.version`
- Ephemeral: always accept, no version

### 3. Optimistic submit

Client-side `apply()` pre-computes pending state.
- One pending per shard (reject if already pending)
- Exposed snapshot reflects prediction, not authoritative
- `pending` field in ShardState shows operation name + input

### 4. Reconciliation

Broadcast arrives while pending exists:
- `causedBy` matches our opId → clear pending (confirmed)
- Someone else's change + `versionChecked: true` → discard prediction
- Someone else's change + `versionChecked: false` → re-compute prediction against new authoritative

### 5. Rejection handling

Server rejects our pending operation:
- Clear pending, revert to authoritative
- If `versionChecked` and `canRetry()` returns true → resubmit
- Notify subscribers

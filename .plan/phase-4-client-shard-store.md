# Phase 4: Client-Side ShardStore

## Status: Steps 1-2 complete, steps 3-5 ready to implement

Steps 3-5 were blocked on the client-server loop (phase 5), which is now complete.
The ClientChannelEngine exists and can coordinate optimistic submit across ShardStores.

### Prerequisites (from phase 3 refinements)

Before steps 3-5, implement:
- **opId in CausedBy** — required field on CausedBy, server-as-actor generates one too. Enables broadcast→pending matching in step 4.
- **VERSION_CONFLICT fresh state** — optional `shards` field on RejectMessage. Enables canRetry in step 5.

## Implementation increments

### Increment 1: Wire protocol & server prerequisites

1. Add `opId: string` to `CausedBy` (required). Server-as-actor also generates opIds.
2. Add optional `shards?: Array<{ shardId: string; version: number; state: unknown }>` to `RejectMessage`, populated only for VERSION_CONFLICT rejections.

### Increment 2: Client optimistic lifecycle (steps 3-4)

See steps 3-4 below. Step 5 (rejection/canRetry) deferred to increment 3, to be designed once the in-flight infrastructure exists.

### Increment 3: Rejection handling (step 5)

To be refined before implementation. Open questions:
- Does canRetry re-occupy the same in-flight slot, or clear and re-acquire?
- Is canRetry only for VERSION_CONFLICT, or any rejection?
- Timeout: client-level default? Per-operation override? Default value?

## Steps

### 1. Basic ShardStore ✅

Holds received state. Exposes snapshot with syncStatus (unavailable → loading → latest).
Subscriber notification. Constructor takes kind (durable/ephemeral).

### 2. Broadcast processing ✅

applyBroadcastEntry() — handles full state and patch entries.
Durable version check (ignore stale). Ephemeral always accepts.

### 3. Optimistic submit

Optimistic operations are constrained to a single shard (vision doc). ClientChannelEngine coordinates:

- Resolve scope to determine target shard
- Check in-flight slot on that shard — reject with `"blocked"` if occupied
- Run `apply()` against authoritative state to compute prediction
- Set in-flight slot and prediction on the ShardStore
- Snapshot shows predicted state; `pending` reflects in-flight metadata
- Send operation to server

**ShardStore internal state — two independent slots:**
- `inFlight: { opId, operationName, input } | null` — cleared on server response, timeout, or disconnect
- `prediction: { state } | null` — cleared on any broadcast to this shard

**Consumer-facing snapshot:**
- `state` = prediction if exists, otherwise authoritative
- `pending` = in-flight metadata (operationName, input) if in-flight exists, else null. Allows consumer to disable UI even after prediction is dropped.

**Confirmed/computed operations:** No prediction, no in-flight slot. Multiple can be in flight simultaneously. Server OCC handles conflicts.

### 4. Reconciliation

When a broadcast arrives on a shard that has an in-flight operation:

- **Any broadcast to the shard** → drop prediction, update authoritative, notify subscribers. In-flight stays.
- If `causedBy.opId` matches our in-flight → also clear in-flight (confirmed).

No re-computation of predictions. The prediction is computed once at submit time and either confirmed by the server or dropped by an intervening broadcast.

### 5. Rejection handling (to be refined)

Server rejects our in-flight operation:
- Clear in-flight and prediction, revert to authoritative
- If VERSION_CONFLICT: rejection includes fresh shard state. canRetry() decides whether to resubmit.
- Notify subscribers

**Submit promise resolves to five statuses:**
- `"acknowledged"` — server accepted
- `"rejected"` — server rejected (error details in result)
- `"timeout"` — server didn't respond in time
- `"disconnected"` — connection dropped
- `"blocked"` — not submitted, in-flight slot occupied (no server round-trip)

## Design decisions

- **Ephemeral versioning kept:** Ephemeral channels retain version counters. Durable/ephemeral only controls persistence and restart survival — all other dimensions (versioning, conflict detection, deduplication, execution mode) are independent.
- **Ephemeral + versionChecked allowed:** The type system does not restrict versionChecked on ephemeral channels. Use case: ephemeral state with conflict detection that doesn't need to survive restarts.
- **No prediction re-computation:** When someone else's broadcast arrives while a prediction exists, the prediction is dropped (not re-run). Re-running apply() against new authoritative creates state the server will never produce. The prediction is temporary — the server's response resolves it.
- **In-flight vs prediction separation:** In-flight slot tracks the server round-trip. Prediction tracks the optimistic UI state. They have independent lifecycles — prediction can be dropped while in-flight remains. This prevents multiple optimistic operations on the same shard while allowing the UI to revert to authoritative early.
- **Defensive apply():** Consumers should write apply() so it handles state where preconditions no longer hold (e.g. guard checks, early return if item not found). This is the reconciliation mechanism — no separate beforeApply hook.

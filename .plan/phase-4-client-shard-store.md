# Phase 4: Client-Side ShardStore

## Status: Complete

All steps implemented across three increments.

## Steps

### 1. Basic ShardStore ✅

Holds received state. Exposes snapshot with syncStatus (unavailable → loading → latest).
Subscriber notification. Constructor takes kind (durable/ephemeral).

### 2. Broadcast processing ✅

applyBroadcastEntry() — handles full state and patch entries.
Durable version check (ignore stale). Ephemeral always accepts.

### 3. Optimistic submit ✅

Optimistic operations are constrained to a single shard. ClientChannelEngine coordinates:

- Resolve scope to determine target shard
- Check in-flight slot on that shard — return `"blocked"` if occupied
- Run `apply()` against authoritative state via Immer `produce()` to compute prediction
- Set in-flight slot and prediction on the ShardStore
- Snapshot shows predicted state; `pending` reflects in-flight metadata
- Send operation to server

ShardStore internal state — two independent slots:
- `inFlight: { opId, operationName, input } | null` — cleared on server response, timeout, or disconnect
- `prediction: { state } | null` — cleared on any broadcast to this shard

Confirmed/computed operations: no prediction, no in-flight slot. Multiple can be in flight simultaneously.

### 4. Reconciliation ✅

When a broadcast arrives on a shard that has an in-flight operation:

- **Any broadcast to the shard** → drop prediction, update authoritative, notify subscribers. In-flight stays.
- If `causedBy.opId` matches our in-flight → also clear in-flight (confirmed).

No re-computation of predictions.

### 5. Rejection handling ✅

- Clear in-flight and prediction, revert to authoritative
- VERSION_CONFLICT: apply fresh shard state from rejection, run canRetry()
- canRetry returns true (default) → resubmit with new opId, recompute prediction against fresh state, keep same in-flight slot and original promise
- canRetry returns false → resolve as rejected
- Other rejection codes → resolve as rejected immediately (no canRetry)
- Submit timeout: configurable `submitTimeoutMs` (default 10s), resolves with `"timeout"`
- Disconnect: resolves all pending submits with `"disconnected"`

Submit returns `SubmitResult` (not raw wire messages):
- `"acknowledged"` — server accepted
- `"rejected"` — server rejected (error details in result)
- `"timeout"` — server didn't respond in time
- `"disconnected"` — connection dropped
- `"blocked"` — not submitted, in-flight slot occupied (no server round-trip)

## Design decisions

- **Ephemeral versioning kept:** Ephemeral channels retain version counters. Durable/ephemeral only controls persistence and restart survival — all other dimensions (versioning, conflict detection, deduplication, execution mode) are independent.
- **Ephemeral + versionChecked allowed:** The type system does not restrict versionChecked on ephemeral channels.
- **No prediction re-computation:** When someone else's broadcast arrives while a prediction exists, the prediction is dropped (not re-run). Re-running apply() against new authoritative creates state the server will never produce.
- **In-flight vs prediction separation:** Independent lifecycles — prediction can be dropped while in-flight remains. This prevents multiple optimistic operations on the same shard while allowing the UI to revert to authoritative early.
- **Defensive apply():** Consumers should write apply() so it handles state where preconditions no longer hold. This is the reconciliation mechanism — no separate beforeApply hook.
- **canRetry only on VERSION_CONFLICT:** Other rejections mean the operation itself was wrong — retrying won't help.
- **canRetry keeps in-flight slot:** No brief window where another submit could sneak in.
- **WelcomeMessage:** Server sends `welcome` (with actorId + shard versions) instead of bidirectional `versions` message. Client needs actorId for scope() and apply() context.

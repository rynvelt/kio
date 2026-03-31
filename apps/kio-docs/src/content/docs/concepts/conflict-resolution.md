---
title: Conflict Resolution & Recovery
description: OCC, version checking, canRetry, and reconnection recovery
sidebar:
  order: 9
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

Real-time systems need to handle three uncomfortable realities: two clients will modify the same state at the same time, servers will crash at the worst possible moment, and network connections will drop. Kio addresses all three through a single pipeline — there is no separate "conflict" system or "recovery" protocol.

## Server-side pipeline

Every operation, regardless of its flags, flows through the same sequence. Understanding this pipeline makes conflict behavior predictable.

```
Client                              Server
  |                                   |
  |-- submit(op, input) ----------->|
  |   [if optimistic:               |
  |    pending = apply(auth, input)] |
  |                                  |-- validate(shards, input)
  |                                  |-- compute(shards, input)            [if computed]
  |                                  |-- apply(shards, input, result)
  |                                  |-- persist (compareAndSwap)
  |                                  |-- broadcast state + version ------> subscribers
  |                                  |     { shardId, version, state,
  |<-- acknowledge/reject -----------|       causedBy: { op, input, actor } }
  |                                  |
  |   [if optimistic: clear pending] |
  |   [if confirmed/computed: set    |
  |    authoritative, notify]        |
  |   [if rejected + canRetry:       |
  |    resubmit with fresh version]  |
```

The client submits an operation. If the operation is optimistic, the client applies it locally as a pending state before the server responds. The server validates, optionally computes, applies, persists via compare-and-swap, and broadcasts the new state and version to all subscribers. The client then clears pending state (for optimistic ops), sets authoritative state (for confirmed/computed ops), or resubmits (if rejected and `canRetry` allows it).

## Failure modes

Different crash points produce different outcomes, but the recovery strategy is always the same: reconnect and let the handshake reconcile state.

**Server crash between request and persist.** Nothing was persisted. The request is lost. The client times out and can retry the operation or resync on reconnect.

**Server crash after persist, before broadcast.** State is saved but clients were never notified. On reconnect, the client reports its local shard versions in the handshake. The server compares and sends current state for any shards where its version is higher. No data is lost — clients just catch up.

**Version mismatch (conflict).** The server rejects the operation and sends the current shard state in the rejection. The client's `canRetry` hook decides whether to resubmit against the fresh state. See [Operations — Retry on rejection](/concepts/operations#retry-on-rejection) for how `canRetry` works in practice.

## Conflict resolution

Conflicts only arise for operations with `versionChecked: true`. The version check is Kio's implementation of optimistic concurrency control (OCC).

### Version-checked operations

The operation carries the expected version of each affected shard. When the server runs compare-and-swap during persistence, it rejects the operation if any shard has been modified since the client last saw it:

1. The server rejects the operation and includes current shard state in the rejection.
2. The client's `canRetry` hook receives the fresh state and decides whether to resubmit.
3. If retrying, the engine resubmits with the updated shard version — internally, transparently.
4. If not retrying, the pending state is dropped and the client shows the authoritative state from the server.

This approach means conflict resolution is always explicit and per-operation. The consumer decides, through `canRetry`, whether a given operation still makes sense against fresh state.

### Non-version-checked operations

Operations with `versionChecked: false` skip the version comparison entirely. They are pure overwrites — applied regardless of what version the shard is at. No conflict is possible because the operation does not depend on existing state.

## Recovery

Recovery is not a special protocol. It uses the same mechanism as initial connection — the handshake.

When a client reconnects after a disconnection, it includes its local shard versions in the reconnection handshake. The server compares versions per shard and only sends state where the server's version is higher. This makes recovery efficient: for a brief disconnect where nothing changed, zero data is transferred.

### Durable channels

The server compares versions per shard. If the client's version matches the server's, that shard is already up to date and nothing is sent. If the server's version is higher, the server sends the current state. The client applies it and is caught up.

### Ephemeral channels

Ephemeral channels have no server-side persistence, so there is no version comparison to perform. Instead, two mechanisms rebuild state on reconnect:

1. **Server-driven state** (e.g., online/offline presence) — the consumer's `onConnect` hook fires and submits operations as usual. The hook runs on every connection, so reconnection is identical to first connection.
2. **Client-driven state** (e.g., GPS location) — the engine automatically resubmits the client's last known value for each ephemeral shard. The client already has the data locally; it just needs to push it to the server again.

Both mechanisms mean ephemeral channels recover without any special consumer code. The same hooks that handle initial connection handle reconnection.

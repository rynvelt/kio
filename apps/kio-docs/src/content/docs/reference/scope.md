---
title: Scope
description: What Kio handles and what it leaves to the consumer
sidebar:
  order: 7
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

Kio is an opinionated framework for real-time, authoritative-server state management. It owns the operation pipeline, state lifecycle, and synchronization machinery. Everything else -- your domain logic, your transport layer, your persistence backend -- belongs to you.

This page draws a clear line between the two sides.

## What Kio owns

### Operation lifecycle

Every operation submitted to the server moves through a fixed pipeline: **validate**, **compute**, **apply**, **persist**, **broadcast state**. Kio manages this entire sequence. You provide the logic for each step (via your channel schema); Kio decides when and how each step runs.

### Operation flags

Each operation declares a combination of flags that control its behavior:

| Flag | Purpose |
|------|---------|
| `execution` | Whether the operation runs optimistically on the client (`"optimistic"`), only on the server (`"confirmed"`), or is computed from inputs alone (`"computed"`) |
| `versionChecked` | Whether the server rejects the operation if the client's shard version is stale |
| `deduplicate` | Whether the server rejects an operation whose ID has already been processed |

Kio enforces the semantics of these flags throughout the pipeline. Invalid combinations (like `optimistic` with a multi-shard scope) are rejected at the type level.

### Authoritative server state with OCC

The server holds the authoritative copy of every shard. Version-checked operations use optimistic concurrency control: if the client's version is behind, the operation is rejected. This prevents lost updates without requiring locks.

### Optimistic client state with automatic reconciliation

When a client submits an `optimistic` operation, Kio applies it locally before the server responds. When the server broadcasts the resulting state, Kio automatically reconciles -- clearing pending operations that the broadcast accounts for, and re-applying any that are still in flight. The client never needs to manage this bookkeeping.

### State sharding with per-shard versioning

Channel state is divided into shards. Each shard has its own version counter, incremented on every mutation. Operations declare which shards they touch (their **scope**), and Kio only loads and version-checks those shards. This keeps operations cheap even when total channel state is large.

### State broadcasting

After an operation mutates state, Kio broadcasts the affected shards to subscribers. Broadcasts are:

- **Complete shard snapshots** -- not deltas. A subscriber that misses a broadcast simply applies the next one.
- **Array-based** -- multiple shards can be delivered in a single message.
- **Per-channel** -- scoped to the channel the operation belongs to.

### Broadcast control

You control when and how broadcasts happen:

| Mechanism | Description |
|-----------|-------------|
| `autoBroadcast` | When enabled, Kio broadcasts dirty shards automatically after each operation. When disabled, you call `broadcastDirtyShards` yourself. |
| `broadcastDirtyShards` | Manually trigger a broadcast of all shards that have changed since the last broadcast. Useful for batching multiple operations before sending state. |
| Per-subscriber dirty tracking | Kio tracks which shards are dirty for each subscriber independently, so a late-joining subscriber receives the shards it has not yet seen. |

### Recovery via current-state delivery

When a client connects (or reconnects), it receives the current state of every shard it is subscribed to. Because broadcasts are full snapshots, there is no need for replay, catch-up queues, or gap detection. The client simply replaces its local state.

### Client-side `canRetry` hook

When a version-checked operation is rejected due to a stale version, the client can automatically retry it. You provide a `canRetry` function that receives the fresh state and the original input, and decides whether the operation still makes sense. Kio handles attempt counting and maximum retries.

### Server as actor

The server itself can submit operations through the same pipeline that clients use. This means server-initiated state changes go through the same validation, version checking, and broadcasting as client-submitted ones. No special side-channel for server logic.

### Subscription shard

Every channel has a built-in **subscription shard** -- a per-actor, engine-managed shard that tracks which actors are subscribed and what grants they hold. Kio provides built-in `grant` and `revoke` operations for managing access. Authorization hooks can read the subscription shard to make decisions without you building a separate permission system.

### Pluggable adapters

Transport, persistence, and serialization are defined as adapter interfaces. Kio ships with none baked in -- you choose (or write) the implementations that fit your stack.

| Adapter | Responsibility |
|---------|----------------|
| **Transport** | Moving messages between client and server (WebSocket, WebTransport, etc.) |
| **Persistence** | Storing and loading shard state (PostgreSQL, Redis, in-memory, etc.) |
| **Serialization** | Encoding/decoding messages on the wire (JSON, MessagePack, etc.) |

### Authorization and lifecycle hooks

Kio exposes hooks at key points in the operation lifecycle and connection lifecycle. The subscription shard provides sensible defaults for authorization (e.g., "is this actor subscribed to this channel?"), but you can override or extend with your own logic.

### Runtime validation of operation inputs

Each operation declares its input shape using a Valibot or Zod schema. Kio validates incoming inputs against this schema before the operation enters the pipeline. Malformed inputs are rejected immediately.

### Adapter conformance test suite

Kio ships a test kit (`kio-test-kit`) that adapter authors run against their implementations. If your persistence adapter passes the conformance suite, it works with Kio. Same for transport adapters. This keeps the adapter contract well-defined and testable without Kio needing to know anything about your infrastructure.

### Mock transport for testing

For unit and integration tests, Kio provides a mock transport that connects client and server engines directly via function calls -- no network, no ports, no setup. You test your channel logic in isolation.

## What the consumer owns

### Domain logic

Rooms, lobbies, seats, game rules, matchmaking, scoring -- all of this lives in your operation handlers. Kio gives you a structured place to put domain logic (the `validate`, `apply`, and `compute` steps), but the logic itself is yours.

### Specific transport implementations

WebSocket, WebTransport, HTTP long-polling -- these ship as separate packages. Kio defines the transport adapter interface; the implementation is a separate concern.

### Specific persistence implementations

PostgreSQL, Redis, SQLite, DynamoDB -- same story. Kio defines what a persistence adapter must do; you pick the backing store.

### Framework bindings

React hooks, Vue composables, Svelte stores -- these are separate packages that wrap the Kio client. Kio's client API is framework-agnostic by design.

### Event sourcing

Kio is a state-transfer system, not an event-sourced one. If you want an event log, you can build one using the `afterCommit` hook combined with your persistence adapter. Kio does not manage event streams, projections, or replay.

### Custom DSL

Kio uses TypeScript-native schemas. If you want a custom DSL with parser and code generation, that is a layer you build on top. The TypeScript-first approach works today; a DSL can come later without changing Kio's internals.

## Summary

| Concern | Owner |
|---------|-------|
| Operation pipeline | Kio |
| State storage and versioning | Kio |
| Optimistic updates and reconciliation | Kio |
| Broadcasting | Kio |
| Recovery on reconnect | Kio |
| Retry on version conflict | Kio |
| Subscription tracking and grants | Kio |
| Input validation | Kio |
| Adapter contracts and conformance tests | Kio |
| Domain rules and game logic | Consumer |
| Transport implementation | Consumer (separate package) |
| Persistence implementation | Consumer (separate package) |
| Framework bindings | Consumer (separate package) |
| Event sourcing | Consumer (via hooks) |
| Custom DSL | Consumer (optional layer) |

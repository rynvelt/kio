---
title: Message Protocol
description: Engine message types — submit, manifest, broadcast, acknowledge, reject
sidebar:
  order: 3
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

The engine defines a small set of message types that cover the entire client-server conversation. The Codec encodes and decodes these into bytes; the transport moves the bytes without inspecting them.

## Message types

```ts
// Bidirectional (used in connection handshake)
| { type: "versions", shards: Record<string, number> }

// Client -> Server
| { type: "submit", channelId: string, operationName: string, input: unknown, opId: string }

// Server -> Client
| { type: "state", channelId: string, kind: "durable" | "ephemeral",
    shards: Array<BroadcastShardEntry> }
| { type: "broadcast", channelId: string, kind: "durable" | "ephemeral",
    shards: Array<BroadcastShardEntry> }
| { type: "acknowledge", opId: string }
| { type: "reject", opId: string, code: string, message: string }
| { type: "ready" }
```

There are seven message types total. The following sections explain what each one does and when it's sent.

## Bidirectional: `versions`

The `versions` message is the only message that flows in both directions. It carries a map of shard IDs to version numbers, representing the sender's current knowledge of shard state.

During the connection handshake, both client and server send `versions` to each other. The server sends its current shard versions for the shards the client is subscribed to. The client responds with the versions it already has locally (or an empty map on first-ever connection). The server diffs the two and sends only the state the client is missing. See the [connection lifecycle](/reference/connection-lifecycle/) page for the full handshake flow.

## Client to server: `submit`

```ts
{ type: "submit", channelId: string, operationName: string, input: unknown, opId: string }
```

The client sends `submit` when a user action triggers an operation. `channelId` identifies which channel the operation belongs to. `operationName` matches a named operation in the channel's schema. `input` carries the operation's payload (validated against the operation's input schema on arrival). `opId` is a client-generated unique identifier that the server echoes back in its response.

The server processes the submission through the operation pipeline — validate, version-check (for durable channels), apply, persist, broadcast — and responds with either `acknowledge` or `reject`.

## Server to client: `state`

```ts
{ type: "state", channelId: string, kind: "durable" | "ephemeral",
  shards: Array<BroadcastShardEntry> }
```

The `state` message is a **point-to-point** message sent to a single client during the handshake. It delivers the current state for shards where the client is behind the server. The `kind` field indicates whether the shards belong to a durable or ephemeral channel. The `shards` array uses the same `BroadcastShardEntry` format as broadcasts — same structure, different semantics (initial sync vs. live update).

The server only sends `state` for shards where the client's version is behind. If the client already has the latest version (reported via its `versions` message), that shard is skipped entirely.

## Server to client: `broadcast`

```ts
{ type: "broadcast", channelId: string, kind: "durable" | "ephemeral",
  shards: Array<BroadcastShardEntry> }
```

The `broadcast` message delivers live state updates after the initial sync. When an operation is applied and the channel has `autoBroadcast: true` (the default), the engine sends a broadcast to every subscriber of the affected shards. The `kind` field indicates the channel type.

The `shards` array can contain one or more shard entries. When `broadcastDirtyShards()` flushes multiple shards at once, they're batched into a single broadcast message rather than sent individually.

## Server to client: `acknowledge`

```ts
{ type: "acknowledge", opId: string }
```

Sent after a `submit` is successfully processed. The `opId` matches the client's original submission, allowing the client engine to resolve the pending operation. On the client side, this confirms that the optimistic update was correct — the client's local state is already up to date.

## Server to client: `reject`

```ts
{ type: "reject", opId: string, code: string, message: string }
```

Sent when a `submit` fails at any stage of the pipeline — validation failure, version conflict, authorization denial, or a consumer-thrown error. The `opId` matches the original submission. `code` is a machine-readable error code (e.g., `"VERSION_CONFLICT"`, `"VALIDATION_FAILED"`). `message` is a human-readable explanation.

On the client side, a rejection triggers rollback of the optimistic update for that operation.

## Server to client: `ready`

```ts
{ type: "ready" }
```

Sent once, after all `state` messages have been delivered during the handshake. This tells the client that initial sync is complete — every subscribed shard has been delivered (or skipped because the client was already up to date). The client engine uses this signal to transition from "connecting" to "connected" state, which in turn unblocks any UI that's waiting for initial data.

## Message flow summary

The following table shows the direction and purpose of each message type:

| Message | Direction | When |
|---|---|---|
| `versions` | Both | During handshake — version negotiation |
| `submit` | Client to server | User triggers an operation |
| `state` | Server to client | Handshake — initial/catch-up state delivery |
| `broadcast` | Server to client | After operation applied — live update |
| `acknowledge` | Server to client | Submit succeeded |
| `reject` | Server to client | Submit failed |
| `ready` | Server to client | Handshake complete — all state delivered |

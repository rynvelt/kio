---
title: Building Presence
description: Using ephemeral channels and server-as-actor for online/offline and GPS
sidebar:
  order: 5
---

:::note[Status: Design Only]
This guide describes the target API. Implementation has not started.
:::

The engine has no built-in concept of "presence." Instead, you model presence yourself using two primitives that already exist: an [ephemeral channel](/concepts/channels/#ephemeral-channel-semantics) and the server acting as the submitting actor.

This guide walks through the pattern, starting with the simplest case and adding complexity as the requirements grow.

## Online/offline with server-as-actor

The server knows when connections arrive and leave. That makes it the natural actor for presence state — it submits operations on behalf of the system, not on behalf of a specific client.

```ts
const server = createServer(engine, {
  onConnect(actor) {
    server.submit("presence", "setOnline", { playerId: actor.id })
  },
  onDisconnect(actor, reason) {
    server.submit("presence", "setOffline", { playerId: actor.id })
  },
})
```

When a player connects, the server submits a `setOnline` operation to the `presence` channel. When the connection drops, it submits `setOffline`. The `presence` channel is ephemeral, so this state lives in memory only — no persistence adapter needed. If the server restarts, all presence state is lost and rebuilt naturally as clients reconnect and trigger `onConnect` again.

Every subscriber to the presence channel receives these updates through the normal broadcast pipeline. From the client's perspective, presence looks like any other state — it arrives as shard updates.

## Detecting dead connections

The pattern above relies on `onDisconnect` firing promptly when a client goes away. That depends on the transport layer detecting dead connections.

The engine delegates liveness detection entirely to the transport. Each transport adapter exposes a `livenessTimeoutMs` property that declares how quickly it will fire `onDisconnect` after a client becomes unresponsive:

- **Socket.IO adapter** — configures `pingInterval` + `pingTimeout`. Socket.IO handles ping/pong internally. The adapter exposes the sum as `livenessTimeoutMs`.
- **WebSocket adapter** — implements its own ping/pong frame loop with a configurable timeout.

In both cases, the engine treats the transport as a black box. It calls `onDisconnect` when the transport says the connection is gone. The consumer picks a transport (or writes a custom one) with liveness characteristics that match their latency tolerance.

## The backgrounded-client edge case

Transport-level ping/pong has a blind spot: mobile clients backgrounded by the OS.

When the OS backgrounds an app, the TCP connection often stays alive — the OS handles keepalives at the socket level. But the application code is suspended. The client can't respond to application-level messages, yet the transport sees a healthy TCP connection because the OS is responding to TCP keepalives on the app's behalf.

The result: a player who locked their phone still appears "online" until the TCP connection eventually times out (which can take minutes or longer, depending on OS and network).

## Application-level heartbeats

For cases where transport-level liveness is not granular enough, you can layer application-level heartbeats on top using existing engine primitives. No special API is needed — this is consumer code built from the same operations and channels you already have.

The approach has two parts:

**Client side:** define a `heartbeat` operation on the presence channel and have the client submit it on a regular interval.

```ts
// Client submits a heartbeat every 10 seconds
setInterval(() => {
  client.submit("presence", "heartbeat", { playerId: myId })
}, 10_000)
```

**Server side:** run a periodic sweep that checks when each player last sent a heartbeat. If the gap exceeds a threshold, mark them offline.

```ts
// Server sweeps every 30 seconds
setInterval(() => {
  const now = Date.now()
  for (const [playerId, lastSeen] of heartbeatTimestamps) {
    if (now - lastSeen > 30_000) {
      server.submit("presence", "setOffline", { playerId })
      heartbeatTimestamps.delete(playerId)
    }
  }
}, 30_000)
```

The engine provides the tools — ephemeral channel, server as actor, scheduled operations. You wire the policy. This keeps presence detection flexible without baking timeout thresholds or sweep intervals into the engine itself.

## Combining approaches

In practice, you'll often use both layers:

1. **Transport-level ping/pong** catches hard disconnects (network failure, browser tab closed, app killed). These fire `onDisconnect` within seconds.
2. **Application-level heartbeats** catch soft disconnects (backgrounded app, suspended tab). These fire on the sweep interval you choose.

The two layers are complementary. Transport detection is fast but misses backgrounded clients. Heartbeat detection is slower but catches everything. Together, they give reliable presence with a bounded staleness window that you control.

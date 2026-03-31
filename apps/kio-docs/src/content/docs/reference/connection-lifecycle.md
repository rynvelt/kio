---
title: Connection Lifecycle
description: Handshake, manifest, reconnection, and mid-session subscription changes
sidebar:
  order: 4
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

A connection goes through a well-defined sequence: transport-level connect, authentication, subscription resolution, version exchange, state sync, and finally the "ready" signal. The same sequence handles both first-time connections and reconnections — the only difference is what the client reports in its `versions` message.

## The transport layer's role

The transport adapter normalizes framework-specific connection details into an `IncomingConnection` object. Whether the underlying connection came from Socket.IO, a native WebSocket, or something else, the engine sees the same shape:

```ts
interface IncomingConnection {
  id: string
  headers: Record<string, string | string[] | undefined>
  query: Record<string, string | undefined>
  extra: Record<string, unknown>
}
```

The engine never sees native socket objects, HTTP upgrade requests, or transport-specific metadata. Everything it needs is in `IncomingConnection`.

## Handshake: the versions exchange

The handshake uses a bidirectional `versions` exchange. Both client and server send a `versions` message containing a map of shard IDs to version numbers. The server uses the diff to send only what the client is missing.

```
1. Transport signals connection (onConnection / onConnected)
2. Server determines subscriptions (defaultSubscriptions or subscription shard)
3. Server -> Client: versions { shards: { world: 12, "seat:1": 8 } }
4. Client -> Server: versions { shards: { world: 12, "seat:1": 5 } }
                     (empty on first-ever connection)
5. Server diffs, sends state only for shards where client is behind:
   Server -> Client: state { channelId: "game", shards: [{ shardId: "seat:1", ... }] }
                     (world is skipped — client already has version 12)
6. Server -> Client: ready
```

The `state` message is point-to-point — it goes only to the connecting client, not to other subscribers. It uses the same shard entry format as regular broadcasts.

## The engine's perspective

Under the hood, the handshake involves ten steps. Understanding these helps when debugging connection issues or writing custom hooks.

```
 1. Transport fires onConnection(connectionId)
 2. Engine runs authenticate(conn) -> actor
 3. Engine loads (or creates) the actor's subscription shard
    -> If new actor: calls defaultSubscriptions(actor)
    -> If subscriptionsOnConnect hook provided: calls it instead
 4. Engine determines subscribed shards from subscription shard refs
 5. Engine loads shard states, registers transport subscriber
 6. Engine sends versions message with server's current shard versions
 7. Client compares with local state, responds with its versions
 8. Engine diffs: for each subscribed shard where server version > client version,
    sends current state via a state message
 9. Engine sends "ready"
10. Engine calls consumer's onConnect(actor) hook
```

Steps 1-5 happen server-side before any messages are exchanged. Steps 6-7 are the bidirectional versions exchange. Steps 8-9 are the catch-up delivery. Step 10 is the consumer's hook — this is where you'd set initial presence, log the connection, or trigger game logic.

## First connection vs. reconnection

The handshake is the same in both cases. The difference is what the client sends in step 7:

- **First connection:** The client has no local state. It sends `versions` with an empty shard map. The server treats every subscribed shard as "client is behind" and sends full state for all of them.
- **Reconnection after brief drop:** The client has local state from the previous session. It sends `versions` with the version numbers it has. The server diffs and sends only the shards where the server's version is higher. If nothing changed while the client was disconnected, no `state` messages are needed — just `ready`.

This design means the server never needs to track "what has this client seen?" across disconnections. The client carries that information in its own version map.

## Controlling subscriptions at connect time

By default, the engine determines a new actor's subscriptions by calling `defaultSubscriptions(actor)`. But sometimes subscriptions depend on connection-specific context — a room ID in the query string, a seat assignment from an external system. The `subscriptionsOnConnect` hook handles this:

```ts
subscriptionsOnConnect(actor, conn, channelName) {
  const roomId = conn.query.room
  const seatId = seatAssignments.getSeatForPlayer(actor.actorId, roomId)
  return [shard.ref("world"), shard.ref("seat", seatId)]
}
```

This hook receives the authenticated actor, the `IncomingConnection` object (with headers, query params, and extras), and the channel name. It returns the set of shard refs the actor should be subscribed to, overriding `defaultSubscriptions` entirely.

## Mid-session subscription changes

Subscriptions are managed server-side via the **subscription shard**. When the server grants or revokes access to a shard, it updates the actor's subscription shard. The engine picks up the change and updates its internal subscriber map — adding or removing the connection from the affected shard's subscriber list.

The client observes subscription changes through its own subscription shard's `ShardStore`. When new shard refs appear, the client engine knows it's been granted access. When refs disappear, it knows access was revoked.

There is no client-initiated subscribe/unsubscribe mechanism. The server is always the authority on who sees what. This keeps the security model simple: the client can request operations, but it can't decide which state it receives.

## Disconnection

When a client disconnects — whether cleanly or due to a dropped connection detected by the transport's liveness mechanism — the engine runs a three-step cleanup:

1. **Transport fires `onDisconnection`.** The transport adapter detects the disconnect (via socket close, ping timeout, or explicit client disconnect) and calls the engine's handler with the connection ID and a reason string.
2. **Engine cleans up shard subscriptions.** The connection is removed from every shard's subscriber list. No more broadcasts will be sent to this connection.
3. **Engine calls the consumer's `onDisconnect(actor, reason)` hook.** This is where you'd clear presence state, update seat assignments, or log the disconnection.

## Ephemeral channels on reconnect

Ephemeral state doesn't survive server restarts, but reconnections after brief drops are handled gracefully. The approach depends on who owns the state:

**Server-driven ephemeral state** (like online/offline presence) is rebuilt by the `onConnect` hook. When a client reconnects, `onConnect` fires again, and the consumer sets presence just like on a fresh connection.

**Client-driven ephemeral state** (like GPS location or cursor position) is automatically resubmitted by the client engine. The engine remembers the client's last known value for each ephemeral shard and resubmits it during reconnection. The consumer doesn't need to handle this explicitly.

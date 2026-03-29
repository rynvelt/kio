# Phase 5: Client-Server Loop

## Status: Steps 1-3 complete, step 4 needs connection handshake first

## Goal

End-to-end: client submits operation → server processes → broadcast → client ShardStore updates.
Using a direct-call transport (typed messages, no serialization, no network).

## Architecture

See VISION_v2.md Section 6 for the full transport/connection spec.

```
createClient(clientEngine, { transport })
  └─ ClientChannelEngine (per channel, owns ShardStores)

DirectTransport (passes typed messages in-process)

createServer(serverEngine, { transport, persistence }) [exists, transport wired]
  └─ ChannelEngine (per channel) [exists]
```

## Connection handshake (from vision doc Section 6)

```
1. Client connects with intent + local shard versions (empty on first connect)
2. Server authenticates
3. Server determines subscriptions (from subscription shard or defaultSubscriptions hook)
4. Server sends manifest: { shardId: serverVersion, ... }
5. Server sends broadcast for each stale shard (full state)
6. Server sends "ready"
```

The client doesn't decide which shards to subscribe to — the server tells it.
ShardStores are created after the server confirms subscriptions.

## Steps

### 1. Message types + transport interface ✅

### 2. DirectTransport ✅

### 3. Wire server to transport ✅

Server receives submit via transport, routes to ChannelEngine.
Sends acknowledge/reject/broadcast back.

### 4. Connection handshake messages

Add to message types:
- Client → Server: `{ type: "connect", shardVersions }` (intent handled by transport/query)
- Server → Client: `{ type: "manifest", versions }`
- Server → Client: broadcasts for stale shards (uses existing broadcast message)
- Server → Client: `{ type: "ready" }`

For the DirectTransport: connect is synchronous — client calls connect(),
server determines subscriptions, sends manifest + state + ready, all in one call.

### 5. Server connection handling

Server receives connect message → runs defaultSubscriptions → determines shards →
registers transport subscriber → sends manifest + initial state + ready.
Simplified: no authenticate for now (DirectTransport has no auth).

### 6. ClientChannelEngine

Creates ShardStores in response to server messages, not client decisions:
- Receives manifest → creates stores in "loading" state
- Receives broadcasts → routes to stores, transitions to "latest"
- Receives ready → connection is established
- submit() → sends via transport, returns SubmitResult

### 7. createClient

Consumer-facing entry point. Creates ClientChannelEngine per channel.
Wires transport onMessage → routes to correct ClientChannelEngine.
Exposes: client.channel("game").submit(...), client.channel("game").shardState(...)
Initiates connection handshake on creation.

### 8. End-to-end test

Full loop with correct handshake:
- createClient + createServer + DirectTransport
- Server determines subscriptions, sends initial state
- Client ShardStores created and populated
- Client submits operation → server applies → broadcast → client updates

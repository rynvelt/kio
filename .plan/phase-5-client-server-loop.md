# Phase 5: Client-Server Loop

## Goal

End-to-end: client submits operation → server processes → broadcast → client ShardStore updates.
Using a direct-call transport (typed messages, no serialization, no network).

## Architecture

See VISION_v2.md Section 6 for the full transport spec.
This phase implements a minimal subset — typed messages, no bytes, no codec, no connection lifecycle.

```
createClient(clientEngine, { transport })
  └─ ClientChannelEngine (per channel, owns ShardStores)

DirectTransport (passes typed messages in-process)

createServer(serverEngine, { transport, persistence }) [exists, needs transport wiring]
  └─ ChannelEngine (per channel) [exists]
```

## Message types (engine-level, not wire-level)

```
Client → Server:
  { type: "submit", channelId, operationName, input, opId }

Server → Client:
  { type: "broadcast", channelId, kind, shards }
  { type: "acknowledge", opId }
  { type: "reject", opId, code, message }
```

## Steps

### 1. Message types + transport interface

Define engine-level message types (ClientMessage, ServerMessage).
Define transport interface: send() + onMessage() — typed messages, not bytes.
Both client-side and server-side interfaces.

### 2. DirectTransport

In-process implementation. Connects a client and server transport pair.
send() on one side calls onMessage() on the other synchronously.

### 3. Wire server to transport

Server receives ClientMessage via transport → routes to correct ChannelEngine.
ChannelEngine result → server sends acknowledge/reject via transport.
ChannelEngine broadcast → server sends broadcast via transport.
This replaces the current Subscriber interface as the delivery mechanism.

### 4. ClientChannelEngine

Per-channel client-side engine. Owns ShardStores.
- Takes subscribed shard IDs (explicit for now, subscription shard later)
- Creates ShardStore per shard
- Routes incoming BroadcastMessage → correct ShardStore.applyBroadcastEntry()
- submit() → sends ClientMessage through transport

### 5. createClient

Consumer-facing entry point. Takes clientEngine + transport.
- Creates ClientChannelEngine per channel
- Wires transport onMessage → routes to correct ClientChannelEngine
- Exposes typed API: client.channel("game").submit(...), client.channel("game").shardState(...)

### 6. End-to-end test

createClient + createServer + DirectTransport.
- Client subscribes to shards
- Client submits operation
- Server applies, persists, broadcasts
- Client ShardStore reflects new state
- Test for both durable and ephemeral channels

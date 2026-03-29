# Phase 5: Client-Server Loop

## Status: Complete ✅

## Goal

End-to-end: client submits operation → server processes → broadcast → client ShardStore updates.

## Architecture

```
createClient(clientEngine, { transport })
  └─ ClientChannelEngine (per channel, owns ShardStores)

DirectTransport (passes typed messages in-process)

createServer(serverEngine, { transport, persistence })
  └─ ChannelEngine (per channel)
```

## Connection handshake (as implemented)

```
1. Transport signals connection (onConnection/onConnected)
2. Server determines subscriptions via defaultSubscriptions(actor)
3. Server sends: versions { shards: { world: 12, "seat:1": 8 } }
4. Client sends: versions { shards: {} }  (empty on first connect)
5. Server diffs, sends: state { channelId, shards } (only shards client is behind on)
6. Server sends: ready
```

## Message types (as implemented)

```
Bidirectional:
  versions { shards: Record<string, number> }

Client → Server:
  submit { channelId, operationName, input, opId }

Server → Client:
  state { channelId, kind, shards }       (initial sync, point-to-point)
  broadcast { channelId, kind, shards }   (ongoing updates, to all subscribers)
  acknowledge { opId }
  reject { opId, code, message }
  ready
```

## Steps (all complete)

1. Message types + transport interface ✅
2. DirectTransport ✅
3. Wire server to transport ✅
4. Connection handshake (versions exchange) ✅
5. Server connection handling ✅
6. ClientChannelEngine ✅
7. createClient ✅
8. End-to-end test ✅

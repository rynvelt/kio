# Phase 3: Server Integration

## Goal

Wire pipeline + broadcast + state manager behind the consumer-facing `createServer()` API
from VISION_v2.md Section 11.

## Consumer API (from vision doc)

```ts
const server = createServer(serverEngine, {
  transport: socketIoTransport({ port: 3000 }),
  persistence: prismaAdapter(prisma),
  authenticate(conn) { ... },
  authorize(actor, operationName, shardRefs) { ... },
  defaultSubscriptions(actor) { ... },
  onConnect(actor) { ... },
  onDisconnect(actor) { ... },
})

// Server-as-actor
server.submit("game", "changeGameStage", { gameStage: "FINISHED" })

// Manual broadcast flush
server.broadcastDirtyShards("presence")
```

## Internal architecture

```
createServer(engineBuilder, config)
  └─ for each channel in engineBuilder["~channels"]:
       └─ ChannelEngine (internal, not consumer-facing)
            ├─ ShardStateManager (load, apply via Immer, persist)
            ├─ OperationPipeline (validate, compute, apply, CAS)
            └─ BroadcastManager (auto/manual broadcast to subscribers)
```

## Steps

### 1. ChannelEngine (internal)

Composes pipeline + broadcast + state manager for one channel.
- `submit(submission)` → runs pipeline, on success calls `broadcastManager.onOperationApplied()`
- `broadcastDirtyShards(shardIds?)` → delegates to broadcast manager with state manager cache
- `addSubscriber(subscriber, shardIds)` / `removeSubscriber(id)`

Test: submit produces state change AND broadcast delivery in one call.

### 2. createServer

Consumer-facing entry point. Takes an `EngineBuilder` and config.
- Creates a `ChannelEngine` per channel
- Wires `authorize` from config into each pipeline
- Exposes `server.submit(channelName, opName, input)` for server-as-actor
- Exposes `server.broadcastDirtyShards(channelName, shardIds?)`
- Transport is pluggable — start with direct-call transport for testing

Test: full end-to-end from createServer through submit to subscriber receiving broadcast.

### 3. VERSION_CONFLICT fresh state (review item 5)

Rejection result includes current shard state from the CAS failure.
Enables client-side `canRetry` to inspect state before resubmitting.

### 4. Server-as-actor retry (review item 9)

`server.submit()` accepts `{ maxRetries }` option.
On VERSION_CONFLICT, reloads shards and retries up to maxRetries.
Bounded — no infinite loops.

### 5. Ephemeral versioning cleanup (review item 7)

Ephemeral broadcast entries should not carry version numbers.
Split BroadcastShardEntry into durable (with version) and ephemeral (without).

### 6. broadcastMode: "full" (review item 8)

When channel has `broadcastMode: "full"`, broadcast sends full state instead of patches.
BroadcastManager checks the setting in `onOperationApplied`.

## Not in this phase

- Client-side ShardStore / reconciliation
- Transport adapters (socket.io, websocket)
- Persistence adapters (Prisma)
- Connection lifecycle (authenticate, subscriptionsOnConnect)
- Subscription shard

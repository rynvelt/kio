# @kiojs/server

Server runtime for [Kio](https://github.com/rynvelt/kio). Runs the operation pipeline (validate → authorize → apply → persist → broadcast), owns the authoritative shard state, manages subscribers, and emits structured observability events.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `createServer(engineBuilder, config)` — constructs the server. Takes a transport, a persistence adapter, and optional hooks (`authorize`, `onConnect`, `onDisconnect`, `onEvent`, `defaultSubscriptions`).
- `MemoryStateAdapter` — in-process reference adapter. Use for tests and local development. Plug in `@kiojs/adapter-prisma` (or your own) for durable storage.
- Types: `Server`, `ServerConfig`, `StateAdapter`, `PipelineResult`, `AfterCommitContext`, `AfterCommitHandler`, `KioEvent` (and the per-variant event types), `SubscriptionMethods`.

## Setup

```ts
import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createBunWsTransport } from "@kiojs/transport-bun-ws";
import { appEngine } from "./schema";

const adapter = new MemoryStateAdapter();
const { transport, websocket, upgrade } = createBunWsTransport();

const server = createServer(appEngine, {
  persistence: adapter,
  transport,
  defaultSubscriptions: () => [{ channelId: "counter", shardId: "count" }],
  onEvent(evt) {
    if (evt.type === "op.rejected") logger.warn(evt);
  },
});

Bun.serve({
  port: 4000,
  fetch(req, srv) {
    const actorId = `user:${crypto.randomUUID()}`;
    if (upgrade(req, srv, { actorId })) return;
    return new Response("Kio server");
  },
  websocket,
});
```

## afterCommit hooks

Register side effects that fire after an op has been applied and persisted. Fire-and-forget — hook failures don't affect the op's ack or broadcast; they surface as `hook.failed` events on `onEvent`.

```ts
server.afterCommit("sharing", "startShare", async ({ input, actor }) => {
  await server.grantSubscription(input.targetActorId, {
    channelId: "presence",
    shardId: `player:${actor.actorId}`,
  });
});
```

## Observability

`config.onEvent` receives a `KioEvent` union — `op.submitted`, `op.committed`, `op.rejected`, `broadcast.sent`, `cas.conflict`, `hook.failed`, `connection.opened`, `connection.closed`. Emitted synchronously; listener errors are caught so instrumentation cannot affect operation outcomes.

## Subscriptions

When the engine has `subscriptions: { kind }` configured, the server also exposes `grantSubscription(actorId, ref)` and `revokeSubscription(actorId, ref)`. Refs are typechecked against the engine's channels via `TypedSubscriptionRef`, so misspelled channel names or wrong per-resource prefixes fail at compile time.

## Persistence

Implement `StateAdapter` for a custom backend. The required surface: `load`, `set`, `compareAndSwap`, `compareAndSwapMulti`. Return result objects for version conflicts; throw for infrastructure errors (the engine maps those to `INTERNAL_ERROR` for clients).

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) and the docs site (`apps/kio-docs`) for concepts, guides, and reference.

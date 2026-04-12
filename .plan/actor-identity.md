# Actor Identity Redesign

## Status: Plan — ready for implementation

## Problem

The server auto-generates actorId from connectionId (`ws:0`, `ws:1`). Every reconnect/refresh creates a new identity. There's no stable player identity, and `ctx.actor` is just `{ actorId: string }` everywhere.

## Design

### defineApp()

A new root-level factory in `@kio/shared` that captures the actor type once:

```ts
import { defineApp } from "@kio/shared";
import * as v from "valibot";

const kio = defineApp({
  actor: v.object({ actorId: v.string(), name: v.string() }),
  serverActor: { actorId: "__kio:server__", name: "System" },
});
```

Returns an object with:
- `kio.channel` — channel builder pre-typed with TActor
- `kio.engine()` — engine builder pre-typed with TActor
- `kio.shard` — shard ref helper (convenience, no actor dependency)

The `actor` field is a StandardSchema used for:
- Type inference: `ctx.actor` is `{ actorId: string, name: string }` everywhere
- Runtime validation: server validates the actor on connection

The `serverActor` field is a static value satisfying the schema. Validated at startup.

### Consumer decides the actor type

**Simple (single type):**
```ts
const kio = defineApp({
  actor: v.object({ actorId: v.string(), name: v.string() }),
  serverActor: { actorId: "__kio:server__", name: "System" },
});
// ctx.actor is always { actorId: string, name: string }
```

**Discriminated union (if consumer needs to distinguish):**
```ts
const kio = defineApp({
  actor: v.union([
    v.object({ actorId: v.string(), name: v.string(), isServer: v.literal(false) }),
    v.object({ actorId: v.string(), isServer: v.literal(true) }),
  ]),
  serverActor: { actorId: "__kio:server__", isServer: true },
});
// Consumer narrows in apply: if (ctx.actor.isServer) { ... }
```

The framework doesn't care — it validates the serverActor against the schema and passes it through.

### Consumer authenticates before upgrade

The transport's `upgrade()` accepts the actor object. The consumer does auth in their HTTP handler:

```ts
Bun.serve({
  fetch(req, srv) {
    const session = verifySession(req.headers.get("cookie"));
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (upgrade(req, srv, { actorId: session.userId, name: session.name })) return;
    return new Response("My App");
  },
  websocket,
});
```

No `authenticate` hook in Kio. The consumer uses their own auth stack.

### Actor flows everywhere

- **Shared code** (`scope`, `apply`): `ctx.actor` is `TActor`
- **Server hooks** (`validate`, `authorize`, `onConnect`, `onDisconnect`): actor is `TActor`
- **Client**: receives full actor in `WelcomeMessage`, stores it, uses it in `ctx.actor`
- **CausedBy**: carries `actorId` (string, not full object — broadcast metadata)

### Server-as-actor

- `KIO_SERVER_ACTOR` is replaced by `serverActor` from `defineApp`
- Pipeline skips validate and authorize for server-as-actor submissions
- `server.submit()` API unchanged — no actor parameter needed
- `ctx.actor` in apply is the `serverActor` value when server submits

## Changes required

### packages/shared

**engine.ts:**
- `EngineBuilder` gains `TActor` generic parameter
- Stores actor schema and serverActor value on `~actorSchema` and `~serverActor`
- Add `InferActor<E>` type helper

**channel.ts:**
- `OperationContext<TActor>` — already generic, just needs TActor threaded through
- All operation config types (`OptimisticOperationConfig`, `ConfirmedOperationConfig`, etc.) gain `TActor` generic
- `ValidateFn`, `ApplyFn`, `ComputeFn` gain `TActor` generic
- `ChannelBuilder` gains `TActor` generic parameter

**New file — define-app.ts:**
- `defineApp({ actor, serverActor })` — validates serverActor against actor schema at creation
- Returns `{ channel, engine, shard }` pre-typed with TActor

**transport.ts:**
- `ServerTransport.onConnection` changes to `(connectionId: string, actor: unknown) => void`
- `WelcomeMessage` changes `actorId: string` to `actor: unknown` (full actor object, serialized)

**direct-transport.ts:**
- `connect(actor)` accepts the actor object, passes to `onConnection`

**broadcast.ts:**
- `CausedBy.actorId` stays as `string` — broadcast metadata, not full actor

### packages/server

**pipeline.ts:**
- `Actor` interface removed — imported from shared or inferred from engine
- `KIO_SERVER_ACTOR` removed — server actor comes from engine config
- `Submission.actor` typed as `{ actorId: string; [key: string]: unknown }` or generic
- Pipeline skips validate/authorize when actor matches serverActor

**server.ts:**
- `handleConnection(connectionId, rawActor)` — validates rawActor against engine's actor schema
- Stores validated actor per connection in a `Map<string, TActor>`
- `ServerConfig` callbacks typed with `TActor`: `onConnect(actor: TActor)`, `authorize(actor: TActor, ...)`
- `server.submit()` uses `serverActor` from engine config

**channel-engine.ts:**
- `CausedBy` construction uses `actor.actorId` — unchanged

### packages/client

**client-channel-engine.ts:**
- `actorId: string` field → `actor: unknown` (stores full actor from welcome)
- `setActorId()` → `setActor()` — stores full actor
- `buildCtx()` returns `{ actor: this.actor, channelId }` (full actor, not just actorId)
- opId generation uses `this.actor.actorId` (needs narrowing or cast)

**client.ts:**
- Welcome handler stores full actor on engines

### packages/transport-bun-ws

**transport.ts:**
- `upgrade(req, server, actor)` — third parameter is the actor object
- `KioWsData` stores actor alongside connectionId
- `websocket.open()` passes actor to `connectionHandler`

### packages/transport-ws

**transport.ts:**
- No change needed — client transport doesn't deal with actor identity

### packages/react

**create-hooks.ts:**
- `createKioHooks` may need `TActor` if hooks expose actor info (currently they don't)

### Tests and examples

- All `connect()` calls need an actor argument
- All `{ actorId: connectionId }` constructions in tests change
- Counter example: `upgrade()` passes actor, client receives full actor
- Server tests: actor in submit, handshake, disconnect

## Open questions

None — design is complete. Implementation can proceed.

## Commit plan

1. **defineApp + engine TActor** — new `defineApp()`, `EngineBuilder` gains TActor, `InferActor`. Non-breaking (old API still works).
2. **Channel builder TActor** — thread TActor through `ChannelBuilder`, operation configs, `OperationContext`. Breaking for type inference.
3. **Transport actor** — `ServerTransport.onConnection` accepts actor, `upgrade()` accepts actor, `WelcomeMessage` carries full actor. Breaking.
4. **Server actor management** — validate actor on connect, store per connection, type config callbacks, skip validate/authorize for server actor. Breaking.
5. **Client actor** — store full actor, use in ctx. Non-breaking.
6. **Update tests and examples** — all tests pass with new API.

# Kio

[![CI](https://github.com/rynvelt/kio/actions/workflows/ci.yml/badge.svg)](https://github.com/rynvelt/kio/actions/workflows/ci.yml)

Authoritative state synchronization for real-time multiplayer applications. The server owns the truth; clients stay in sync via declarative operations, optimistic concurrency, and patch-based broadcasts.

> **Early stage.** The implementation is functional but not yet versioned or published. Breaking changes are expected.

## What it solves

Real-time apps need more than message passing. They need conflict resolution when two clients act at the same time, optimistic updates that can be rolled back, reconnection recovery, and a pluggable persistence story. Kio handles those concerns so you can focus on defining your state and the operations over it.

Not a communication library - wire protocols are the easy part. The value is in the state management around them.

## Quick example

```ts
// schema.ts
import { channel, engine, shard } from "@kiojs/shared";
import * as v from "valibot";

export const counterChannel = channel
  .durable("counter")
  .shard("count", v.object({ value: v.number() }))
  .operation("increment", {
    execution: "optimistic",
    input: v.object({}),
    scope: () => [shard.ref("count")],
    apply(shards) {
      shards.count.value += 1;
    },
  });

export const appEngine = engine().register(counterChannel);
```

```ts
// server.ts
import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createBunWsTransport } from "@kiojs/transport-bun-ws";
import { appEngine } from "./schema";

const adapter = new MemoryStateAdapter();
await adapter.compareAndSwap("counter", "count", 0, { value: 0 });

const { transport, websocket, upgrade } = createBunWsTransport();
const server = createServer(appEngine, {
  persistence: adapter,
  transport,
  defaultSubscriptions: () => [{ channelId: "counter", shardIds: ["count"] }],
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

```tsx
// App.tsx
import { useKio, useShardState } from "@kiojs/react";

function Counter() {
  const kio = useKio();
  const count = useShardState("counter", "count");
  if (count.syncStatus !== "latest") return <p>Loading…</p>;
  return (
    <button onClick={() => kio.submit("counter", "increment", {})}>
      {count.state.value}
    </button>
  );
}
```

## Concepts

**Channels.** A group of state with a shared consistency model.
- `channel.durable(name)` - versioned, persisted, CAS-protected on write. Full conflict detection.
- `channel.ephemeral(name)` - unversioned, in-memory, latest-wins. No persistence; rebuilt on reconnect.

**Shards.** Units of state inside a channel. Either declared (`.shard("world", schema)`) or per-resource (`.shardPerResource("player", schema)` keyed by id). Subscriptions are shard-level - clients only receive updates for the shards they care about.

**Operations.** Typed mutations with an input schema, a scope (which shards they read/write), and optional `validate` / `compute` / `apply` steps. Two execution modes:
- `optimistic` - client runs `apply` locally for instant feedback; server re-runs canonical `apply` and broadcasts patches.
- `computed` - server runs a `compute` step whose result drives `apply`. Useful for side-effectful logic the client cannot predict.

**afterCommit hooks.** Server-side triggers that fire after an op has been applied and persisted. Fire-and-forget; errors surface as `hook.failed` events to `ServerConfig.onEvent`. Hooks can re-submit through `ctx.submit` with depth tracking to prevent infinite loops.

**Actors.** Connection-scoped identity validated on connect, visible to `authorize`, `validate`, `apply`, and hooks.

## Architecture

```
op submitted
     │
     ▼
 validate input → authorize → load shards → server validate → compute
     │
     ▼
 apply (Immer) → new state + patches
     │
     ▼
 persist (CAS for durable; cache-only for ephemeral)
     │
     ▼
 broadcast patches → subscribers
     │
     ▼
 acknowledge → originator
     │
     ▼
 afterCommit hooks (fire-and-forget)
```

If CAS fails, the pipeline rejects with `VERSION_CONFLICT` and returns fresh state so the client can decide whether to retry. If a hook throws, the op is still acknowledged and broadcast; the error surfaces as a `hook.failed` event.

Internally the server is composed from small pieces: `ChannelRuntime` (pipeline + broadcast per channel), `ActorRegistry` (connection → actor lookup), `TransportProtocol` (wire-protocol adapter), `AfterCommitHooks` (hook storage + depth check), `OperationPipeline` (the actual per-op steps), and `StateAdapter` (persistence).

## Packages

| Package | Role |
|---|---|
| `@kiojs/shared` | Channel/operation builders, engine, transport types, shared utilities |
| `@kiojs/server` | `createServer`, pipeline, broadcast, persistence interface, afterCommit hooks |
| `@kiojs/client` | Client runtime, local state mirror, optimistic apply, subscription management |
| `@kiojs/react` | `useKio`, `useShardState`, provider |
| `@kiojs/transport-ws` | Generic WebSocket client transport |
| `@kiojs/transport-bun-ws` | Bun-native server transport |
| `@kiojs/adapter-prisma` | Persistence adapter for Prisma |
| `@kiojs/e2e-tests` | End-to-end integration tests spanning client, server, transport |

## Examples

Self-contained apps that exercise the stack end-to-end:

- `examples/counter` - minimal shared counter with presence
- `examples/lobby` - multiplayer lobby with countdown, Mantine UI, stable player identity
- `examples/streetescapes` - larger case study

Each runs with `bun run dev` inside the example directory.

## Development

```sh
bun install
just typecheck        # TypeScript check (uses tsgo)
just test             # Bun test runner
just check            # Biome lint + format check
just fix              # Apply Biome fixes
just docs-dev         # Local docs preview
```

See [`justfile`](./justfile) for the full list. Tests use `bun test`; the project does not use `tsc`, `jest`, or `vitest`.

## Persistence

`StateAdapter` is the pluggable interface:

- `MemoryStateAdapter` - reference implementation, in-process, no I/O. Good for tests and local development.
- `@kiojs/adapter-prisma` - Postgres (or any Prisma-supported DB) via Prisma Client.

A custom adapter implements `load`, `set`, `compareAndSwap`, and `compareAndSwapMulti`. Return result objects for version conflicts; throw for infrastructure errors. The engine catches thrown errors and maps them to `INTERNAL_ERROR` for clients.

## Type safety

Schemas are declared via [StandardSchema](https://github.com/standard-schema/standard-schema) - compatible with Valibot, Zod, ArkType, and others. Channel, operation, and input types flow through the builder, so `server.submit("counter", "increment", {})` is fully typed end-to-end. Passing a wrong channel name, op name, or input shape is a compile error.

`any` is forbidden; `object` and `unknown` are avoided where a concrete type is reachable.

## Docs

Concepts, guides, and reference live in `apps/kio-docs` (Astro Starlight):

```sh
just docs-dev
```

Covered pages: channels, shards, operations, broadcasting, conflict resolution, subscriptions, client state, type safety, operation flags, error model, schema/server/client setup, presence, location-sharing case study, React integration.

## Status

This repo is under active exploration. Public APIs (`createServer`, `Server`, channel/engine builders, `StandardSchema`-based operations) are reasonably stable; internals have shifted multiple times as design has clarified. No published packages yet - consume via workspace only. When the core stabilizes, versioned releases will follow.

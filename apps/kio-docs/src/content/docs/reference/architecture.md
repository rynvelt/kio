---
title: Architecture
description: Layers, packages, and runtime dependencies
sidebar:
  order: 1
---

:::note[Status: Design Only]
Package structure exists. Core has initial types. Client and server packages are empty shells.
:::

## Layers

A real-time sync framework needs to separate concerns clearly. Schema definitions shouldn't know about wire protocols. The transport layer shouldn't care whether state is ephemeral or versioned. And persistence shouldn't be baked into the engine — it should be pluggable.

Kio is organized into three layers, top to bottom:

```
+---------------------------------------------+
| Schema                                       |
| Channels, shards, operations, state shapes,  |
| validation, apply functions, flags           |
+---------------------------------------------+
| Sync Engine                                  |
| Authoritative store, ShardStore, OCC,        |
| state broadcasting, conflict resolution      |
+---------------------------------------------+
| Transport + Persistence                      |
| Pluggable adapters for wire protocol,        |
| serialization, and state storage             |
+---------------------------------------------+
```

**Schema** is the consumer-facing definition layer. This is where you declare channels, describe shard state shapes, define operations with their `apply()` and `validate()` functions, and attach flags like `versionChecked` or `broadcastSelf`. The schema layer is pure data and functions — no side effects, no I/O.

**Sync Engine** is the runtime. On the server, it owns the authoritative store, runs the operation pipeline (validate, version-check, apply, persist, broadcast), and manages subscriptions. On the client, it owns the `ShardStore`, handles optimistic submission, and reconciles with authoritative state when broadcasts arrive. Both sides use optimistic concurrency control (OCC) for durable channels.

**Transport + Persistence** is the adapter layer. Transport adapters (Socket.IO, native WebSocket) move messages between client and server. Persistence adapters (Prisma, or anything else) store and retrieve shard state. These are separate packages — you install only the ones you need.

## Packages

The framework ships as a monorepo with a core package and several optional adapter packages:

```
kio/
  core/          — Shared types, schema definition API, operation flags
  server/        — Authoritative store, operation pipeline, broadcast
  client/        — ShardStore, submission, reconciliation, subscriptions

kio-transport-socketio/    — Socket.IO adapter (server + client)
kio-transport-websocket/   — Native WebSocket adapter
kio-adapter-prisma/        — Prisma persistence adapter
kio-react/                 — React hooks (useShardState, useSubmit)
kio-test-kit/              — Adapter conformance tests, mock transport
```

`kio/core` is the only package that both server and client depend on. It contains shared types, the schema definition API (`defineSchema`, `channel.durable`, `channel.ephemeral`), and operation flag definitions. It has no server or client runtime logic.

`kio/server` and `kio/client` depend on `kio/core` and each add their respective runtime — the authoritative store on the server side, the `ShardStore` on the client side. They never depend on each other.

The transport packages (`kio-transport-socketio`, `kio-transport-websocket`) each export both a server adapter and a client adapter. You pick one transport and use both halves.

`kio-adapter-prisma` implements the persistence interface for Prisma. Other persistence adapters can be written against the same interface.

`kio-react` provides React bindings — hooks like `useShardState` and `useSubmit` that subscribe to the client `ShardStore` and trigger re-renders on state changes.

`kio-test-kit` provides conformance test suites for transport and persistence adapters, plus a mock transport for testing consumer code without a real connection.

## Runtime dependencies

Kio's core has one runtime dependency: **Immer**, used for immutable state management in `apply()` functions. There are zero dependencies on schema validation libraries, transport libraries, or persistence libraries.

This is intentional. The framework shouldn't force you into a particular validation library or transport. Instead, Kio uses the **StandardSchema** interface for all state schemas — the `input` schema, `serverResult` schema, and shard state schema all accept any library that implements StandardSchema. That includes Valibot, Zod, ArkType, and any future library that adopts the standard.

At runtime, the engine calls `~standard.validate()` on incoming operations to validate their shape. At compile time, TypeScript infers types from the schema, giving you full type safety in `apply()`, `validate()`, `compute()`, and every other function that touches operation or state data. You get runtime validation and compile-time safety from the same schema definition, with no code generation and no Kio-specific schema DSL.

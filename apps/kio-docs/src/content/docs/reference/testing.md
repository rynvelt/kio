---
title: Testing Strategy
description: Type-level tests, runtime tests, and adapter conformance tests
sidebar:
  order: 8
---

:::note[Status: Exploratory]
Type-level test patterns are being explored in @kiojs/core. Runtime and conformance test strategies are design-only.
:::

Kio's testing strategy has three layers: **type-level tests** that verify the type system catches invalid schemas at compile time, **runtime tests** that verify the engine behaves correctly, and **adapter conformance tests** that verify third-party implementations meet the adapter contracts.

## Type-level tests

The builder API and schema split rely heavily on TypeScript's type system to enforce correctness. Invalid flag combinations, `apply()` placement, `reject()` error codes -- these constraints exist entirely in the types. If a refactor silently loosens a type constraint, invalid code starts compiling and the safety guarantee is gone. Type-level tests prevent that.

Since the "feature" is that certain code **does not compile**, the tests need to verify both sides:

- **Positive cases**: valid code compiles without errors.
- **Negative cases**: invalid code produces a type error.

Two techniques handle this, and they work together.

### `@ts-expect-error` for negative tests

A line annotated with `@ts-expect-error` tells TypeScript "the next line must produce a type error." If the next line compiles cleanly, TypeScript treats the unnecessary `@ts-expect-error` as an error itself. This means a loosened type constraint causes a CI failure -- exactly what you want.

### Type-level assertion helpers for positive tests

Utility types that fail at compile time if the inferred type does not match the expected type. If the builder infers the wrong shard shape, the assertion type produces a type error and the build breaks.

### Full example

This file has no runtime code. It runs as part of normal type checking -- no test runner, no extra tooling.

```ts
// types.test.ts — no runtime, pure compile-time assertions

import { channel, shard } from "kio/core"
import * as v from "valibot"

type Expect<T extends true> = T
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false

const worldSchema = v.object({ gameStage: v.string() })
const seatSchema = v.object({ inventory: v.array(v.object({ id: v.string() })) })

const ch = channel.durable("test")
  .shard("world", worldSchema)
  .shardPerResource("seat", seatSchema)

// ── Positive: builder infers correct shard types ──────────────
type Shards = InferShards<typeof ch>
type _1 = Expect<Equal<Shards["world"], { gameStage: string }>>

// ── Positive: optimistic operation accepts apply() ────────────
ch.operation("visit", {
  execution: "optimistic",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ seatId: v.string() }),
  scope: (input) => [shard.ref("seat", input.seatId)],
  apply({ seat }, input) { /* compiles */ },
})

// ── Negative: optimistic requires apply() ─────────────────────
// @ts-expect-error: missing apply() for optimistic operation
ch.operation("bad1", {
  execution: "optimistic",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ seatId: v.string() }),
  scope: (input) => [shard.ref("seat", input.seatId)],
})

// ── Negative: computed rejects apply() in schema ──────────────
// @ts-expect-error: apply() not allowed here for computed operation
ch.operation("bad2", {
  execution: "computed",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ x: v.string() }),
  scope: () => [shard.ref("world")],
  apply({ world }, input) { /* should not compile */ },
})

// ── Negative: optimistic + multi-shard scope ──────────────────
// @ts-expect-error: optimistic not allowed with multi-shard scope
ch.operation("bad3", {
  execution: "optimistic",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ from: v.string(), to: v.string() }),
  scope: (input) => [shard.ref("seat", input.from), shard.ref("seat", input.to)],
  apply() {},
})

// ── Negative: reject() enforces declared error codes ──────────
ch.operation("typed", {
  execution: "confirmed",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ id: v.string() }),
  errors: v.picklist(["NOT_FOUND", "EXPIRED"]),
  scope: () => [shard.ref("world")],
}).serverImpl("typed", {
  validate(shards, input, ctx, { reject }) {
    reject("NOT_FOUND", "ok")    // ✅ compiles
    // @ts-expect-error: "INVALID" is not in the errors picklist
    reject("INVALID", "bad")
  },
  apply() {},
})
```

The key property: these tests run as part of `just typecheck`. No special runner, no snapshot files, no separate CI step. If someone changes a type and a constraint slips, the type checker catches it on the next run.

## Runtime tests

Runtime tests use `bun test` to exercise the engine's actual behavior. Every test runs entirely in-memory -- no network, no database, no infrastructure setup.

### What runtime tests cover

| Area | What is verified |
|------|------------------|
| **Operation pipeline** | An operation submitted to the engine moves through validate, compute, apply, and produces the expected state changes. |
| **ShardStore reconciliation** | After an optimistic apply on the client, a server broadcast arrives and pending operations are correctly cleared or discarded. |
| **Version checking** | Operations submitted against a stale shard version are rejected. Operations submitted against the current version are accepted. |
| **Deduplication** | Submitting an operation with an ID that has already been processed results in rejection. |
| **`canRetry` hook** | When a version-checked operation is rejected, the retry hook is called with fresh state. Attempt counting increments correctly. Maximum retries are respected. |
| **Error model** | An `OperationError` thrown in `validate` or `apply` produces a typed rejection with the declared error code. An unexpected thrown error produces `INTERNAL_ERROR`. |

### Test infrastructure

All runtime tests use two things:

- **In-memory transport**: Client and server engines are connected via direct function calls. Messages are passed synchronously (or with microtask-level async) -- no sockets, no ports.
- **In-memory persistence**: Shard state lives in plain objects. No database driver, no file system.

This means the full test suite runs in milliseconds and has zero external dependencies. A typical test looks like: create a channel schema, spin up a server engine and a client engine with the mock transport, submit an operation, and assert on the resulting state.

### Example structure

```ts
import { describe, test, expect } from "bun:test"
import { createServer, createClient, mockTransport } from "@kiojs/core/test"
import { myChannel } from "./my-channel"

describe("operation pipeline", () => {
  test("apply mutates the target shard", () => {
    const { server, client } = mockTransport(myChannel)

    client.submit("visit", { seatId: "seat-1" })

    expect(server.shard("seat", "seat-1").state).toEqual({
      inventory: [{ id: "default-item" }],
    })
  })
})
```

The mock transport handles the handshake, subscription, and message routing automatically. You focus on the domain behavior.

## Adapter conformance tests

Kio defines adapter interfaces for transport and persistence. Third-party implementations need a way to verify they satisfy the contract. Running a handful of manual tests is not enough -- the contracts have edge cases around ordering, error handling, and concurrency.

### `kio-test-kit`

Kio ships a package called `kio-test-kit` that exports conformance test suites. An adapter author imports the relevant suite, provides a factory function that creates an instance of their adapter, and runs the tests.

```ts
import { describe } from "bun:test"
import { persistenceConformance } from "kio-test-kit"
import { createPostgresAdapter } from "./my-postgres-adapter"

describe("postgres persistence adapter", () => {
  persistenceConformance({
    create: () => createPostgresAdapter({ connectionString: process.env.DATABASE_URL }),
    cleanup: (adapter) => adapter.close(),
  })
})
```

The conformance suite exercises the full adapter contract:

| Suite | What it tests |
|-------|---------------|
| **Persistence** | Load, save, version increment, concurrent writes, missing shard behavior, cleanup. |
| **Transport** | Message delivery, ordering guarantees, connection lifecycle, reconnection, backpressure. |

If your adapter passes the conformance suite, it works with Kio. If a new version of Kio changes the adapter contract, the conformance suite is updated and adapter authors see exactly what broke.

### Why a separate package

The conformance tests live in `kio-test-kit` rather than `@kiojs/core` for two reasons:

1. **Adapter authors should not need to depend on the full Kio core.** The test kit imports only the adapter interface types.
2. **Infrastructure-dependent tests stay out of Kio's own CI.** Kio's test suite runs with zero external dependencies. The Postgres conformance tests require a running Postgres instance -- that belongs in the adapter package's CI, not Kio's.

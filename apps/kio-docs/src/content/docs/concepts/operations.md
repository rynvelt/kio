---
title: Operations
description: Named state mutations — the only way state changes in Kio
sidebar:
  order: 4
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

In most real-time systems, state gets changed from multiple places in multiple ways — REST endpoints, WebSocket handlers, background jobs — each with its own validation and broadcast logic. When something goes wrong, you're left tracing through several code paths to figure out what happened.

Kio takes a different approach. An **operation** is a named state mutation, and it is the only way state changes. Both clients and the server submit operations through the same pipeline. This single entry point means every state change goes through the same validation, conflict detection, persistence, and broadcast logic.

## Anatomy of an operation

Every operation provides three things:

- **`input`** — a schema for the payload. Any [StandardSchema](https://github.com/standard-schema/standard-schema)-compatible library works: Valibot, Zod, ArkType, etc.
- **`scope(input, ctx)`** — declares which shards this operation touches.
- **`apply(shards, input, serverResult?, ctx?)`** — transforms shard state. This is **shared code**: identical logic runs on both client and server.

Operations can also provide optional handlers:

- **`validate(shards, input, ctx, { reject })`** — server-only rejection logic. The `reject` callback is the only way to produce typed consumer errors (see [Error Model](/concepts/error-model)).
- **`compute(shards, input, ctx)`** — server-only computation for data the client doesn't have. The result is passed to `apply()` and broadcast to clients so they can replay the same state transition.
- **`canRetry(input, freshShards, attemptCount)`** — client-side hook that decides whether a rejected operation should be resubmitted against fresh state.

## Shard accessors in handlers

The first argument to `apply()`, `validate()`, and `compute()` is an object keyed by shard type name. The shape depends on the shard kind:

- **Singleton shards** are direct properties — `shards.world` gives you the state.
- **Per-resource shards** use accessor functions — `shards.seat(resourceId)` returns the state for that instance.

The engine pre-loads only the instances declared in `scope()`. Calling an accessor with a resource ID not in `scope()` throws a runtime error.

In `apply()`, shard states are **Immer drafts**. You write mutative code (`inv.splice(...)`, `me.gps = input.gps`), but the engine produces immutable results internally. Immer handles structural sharing (only cloning what changed) and safe rollback if `apply()` throws.

In `validate()` and `compute()`, shard states are **read-only snapshots** — you can inspect state but not mutate it.

## Operation context

All handler functions (`scope`, `apply`, `validate`, `compute`) receive an operation context as their last argument:

```ts
interface OperationContext<TActor> {
  actor: TActor        // the object returned by authenticate() for this connection
  channelId: string    // which channel instance (e.g., "room:abc")
}
```

`actor` always has an `actorId: string` property (required by `authenticate()`). Everything else on the actor object is consumer-defined:

```ts
// Consumer's authenticate hook defines the actor shape
authenticate(upgradeRequest) {
  const session = await verifySession(upgradeRequest.headers.cookie)
  return {
    actorId: session.playerId,   // required by the engine
    displayName: session.alias,  // consumer-defined, available in all hooks as ctx.actor.displayName
  }
}
```

The engine uses `actor.actorId` for broadcast metadata and passes the full `actor` object through to all hooks. On the client side, the server sends `actorId` during the connection handshake so `ctx.actor.actorId` is available in client-side `apply()` as well.

## Submit result

`submit()` returns a promise that resolves to a discriminated union — it never throws. You always inspect the `status` to determine what happened:

```ts
const result = await client.channel("game").submit("useItem", { seatId, itemId })

switch (result.status) {
  case "acknowledged":
    // Server accepted. State broadcast will arrive (or already has for optimistic ops).
    break
  case "rejected":
    // Server rejected. result.error has details, result.freshState has current shard state.
    console.log(result.error.code)
    console.log(result.error.message)
    break
  case "blocked":
    // Not submitted — a pending operation on this shard hasn't resolved yet.
    break
}
```

You can handle this reactively (inspect the result after the fact) or proactively (check `pending` on the shard state and disable UI before the user can trigger a blocked submit):

```tsx
const { state, pending } = useShardState("game", "seat", seatId)
<button disabled={pending !== null} onClick={() => submit("useItem", { seatId, itemId })}>
  Use
</button>
```

## Retry on rejection

When the server rejects a version-checked operation (version mismatch), the rejection includes the current shard state. The client now has fresh data and can decide: does this operation still make sense?

You provide `canRetry(input, freshShards, attemptCount)` per operation:

- Returns `true` — resubmit with the updated shard version.
- Returns `false` — the operation fails.
- Not provided — defaults to `true`.

The engine enforces a maximum retry count (configurable, default 3). Retries happen internally — your `submit()` promise resolves only after all retries are exhausted. If the final attempt is rejected, `submit()` resolves with `status: "rejected"`.

Some examples of how `canRetry` plays out in practice:

- **Use item "potion-1"**: rejected, but fresh state still has potion-1. `canRetry` returns `true`, succeeds on retry.
- **Use item "potion-1"**: rejected, and potion-1 is gone. `canRetry` returns `false`, fails immediately.
- **Roll dice**: rejected because the turn advanced. `canRetry` checks the turn and returns `false`, fails.
- **Draw card**: rejected, but the deck still has cards. `canRetry` returns `true`. The server re-runs `compute()` and draws a (possibly different) card.

## Privacy via shard design

The engine always broadcasts state to **all subscribers** of the affected shard. There is no per-operation broadcast flag. Privacy is controlled entirely by shard design and subscription authorization, not by selectively withholding broadcasts.

If an operation produces private data, that data should live in a shard only the intended actor is subscribed to. For example, personal hints go in `seat:3:hints` and private scores go in `seat:3:score`. The broadcast reaches all subscribers of those shards — which is just one person.

You control who subscribes to what via the subscription shard. The engine does not need to know what is "private" — it just broadcasts to subscribers, and the subscription model ensures the right people see the right shards.

## Server as actor

The server can submit operations through the same pipeline as clients:

- Game timer expires — server submits "change game stage"
- NPC acts on a schedule — server submits an NPC action
- External webhook arrives — server submits a state update

Same `submit()` API, same `apply()`, same persistence and broadcast. The server is just another participant. When the server submits, it can configure `{ maxRetries: 10 }` to keep retrying on version conflicts — useful for operations that must eventually land (e.g., ending a game when a countdown reaches zero).

A good shard design pattern: separate server-controlled state from player-contested state. If timer expirations write to a `world:timers` shard that only the server writes to, there is no contention — the version check passes on the first attempt every time. No retries needed, no special "force" mechanism.

For client requests needing server-side computation (like a dice roll), the `compute()` step handles this inline. For complex orchestration (async APIs, multi-step sequences), the server uses hooks or state subscriptions to trigger its own operations.

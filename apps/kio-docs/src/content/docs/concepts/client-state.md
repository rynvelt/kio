---
title: Client State
description: "ShardState, ShardStore, syncStatus, and pending — one state, not two"
sidebar:
  order: 7
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

## One state, not two

From the consumer's perspective, each subscribed shard exposes **one state**. The consumer never decides between "authoritative" and "optimistic." The engine resolves this internally — the value you read is always the right thing to show.

```ts
const inventory = client.channel("game").state("seat", "seat:3")
// → { items: [...] }  — always the right thing to show

const shard = client.channel("game").shardState("seat", "seat:3")
// shard.syncStatus: "unavailable" | "loading" | "stale" | "latest"
// shard.state:      null (when loading) | T (when stale or current)
// shard.pending:    null | { operationName, input }
```

## ShardState

The `ShardState<T>` type is a discriminated union over `syncStatus`. Each variant narrows `state` and `pending` so the consumer never needs a null check after matching on status:

```ts
type ShardState<T> =
  | { syncStatus: "unavailable"; state: null; pending: null }
  | { syncStatus: "loading"; state: null; pending: null }
  | { syncStatus: "stale"; state: T; pending: { operationName: string; input: unknown } | null }
  | { syncStatus: "latest"; state: T; pending: { operationName: string; input: unknown } | null }
```

When the consumer checks `syncStatus`, TypeScript narrows `state` automatically:

```ts
if (shard.syncStatus === "loading") {
  // shard.state is null here — TypeScript knows
}
const { state, pending } = shard
// state is T — guaranteed non-null
// pending is { operationName, input } | null
```

## Connection state

Separately from per-shard sync status, the client exposes transport-level connection state:

```ts
client.connectionState  // "connecting" | "connected" | "reconnecting" | "disconnected"
```

This is useful for showing a global "reconnecting..." banner. Individual shard `syncStatus` values tell you whether any particular piece of data is up to date.

## React integration

A separate `kio-react` package provides hooks that wire `ShardState` into React's rendering lifecycle:

```tsx
function Inventory({ seatId }: { seatId: string }) {
  const shard = useShardState("game", "seat", seatId)

  if (shard.syncStatus === "loading") return <LoadingScreen />

  const { state, pending, syncStatus } = shard
  return (
    <>
      {syncStatus === "stale" && <SyncingIndicator />}
      <ul>
        {state.items.map(item => (
          <li key={item.id} className={pending?.input.itemId === item.id ? "using" : ""}>
            {item.name}
          </li>
        ))}
      </ul>
    </>
  )
}
```

Because `ShardState` is a discriminated union, the `loading` early return narrows the type for the rest of the function. `state` is guaranteed non-null after that point.

## ShardStore internals

The engine's client-side `ShardStore` is framework-agnostic. There is one instance per subscribed shard. It maintains two internal slots — but the consumer only sees the resolved state through `snapshot`.

```ts
class ShardStore<T> {
  private authoritative: { state: T; version: number } | null
  private serverVersion: number | null
  private pending: {
    state: T
    opId: string
    operationName: string
    input: unknown
    versionChecked: boolean
    apply: (state: T) => T
  } | null

  get snapshot(): ShardState<T>
  subscribe(listener: () => void): () => void
}
```

The `snapshot` property returns a stable reference — only replaced when the underlying state actually changes. This makes it compatible with any reactive framework: React's `useSyncExternalStore`, Solid signals, Svelte stores.

### Lifecycle transitions

**Manifest handling:** When the engine receives a `manifest` message, it sets `serverVersion` on each ShardStore. If `serverVersion > authoritative.version`, the store transitions to `"stale"`. When the broadcast arrives, it transitions to `"latest"`.

Ephemeral shards skip `"stale"` entirely — they go from `"loading"` directly to `"latest"`.

**Unavailable state:** A ShardStore starts in `"unavailable"` when the actor's subscription shard doesn't include the shard ref. It transitions to `"loading"` then `"latest"` when access is granted, and back to `"unavailable"` when access is revoked (state cleared to null).

### On server broadcast — durable channels

1. If version <= authoritative version, ignore (stale broadcast).
2. If entry has `state`, set authoritative. If entry has `patches`, apply patches.
3. If no pending operation, done.
4. If `causedBy` confirms our pending (matching op ID), clear pending.
5. If someone else's change and pending exists:
   - `pending.versionChecked === true` — clear pending (prediction was based on stale state).
   - `pending.versionChecked === false` — keep pending, re-compute against new authoritative.

Ephemeral channels always accept (no version comparison) but use the same pending logic.

### On optimistic submit

1. If pending already exists, reject (one pending operation at a time per shard).
2. Run `apply()` against authoritative state. Store the result as `pending.state`.
3. Notify subscribers.

### On rejection

1. Clear pending. Revert to authoritative.
2. If `versionChecked` and `canRetry()`, resubmit automatically.
3. Notify subscribers.

## Why `apply()` is shared code

Even though the server broadcasts state (not operations), the `apply()` function is shared between client and server:

- **Client (optimistic):** runs `apply()` locally for immediate prediction before the server confirms.
- **Server:** runs `apply()` to produce the next authoritative state and the broadcast.

The client never needs `apply()` for confirmed state — it waits for the broadcast. But sharing the function means optimistic predictions match server behavior exactly.

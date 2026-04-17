---
title: React Integration
description: "useShardState, useSubmit, and KioProvider — React hooks for Kio"
sidebar:
  order: 4
---

:::note[Status: Design Only]
This guide describes the target API. Implementation has not started.
:::

The `kio-react` package provides React bindings for the framework-agnostic client created in [Client Setup](/guides/client-setup/). It exposes three pieces: a context provider, a hook for reading shard state, and a hook for submitting operations.

## Providing the client

Wrap your app (or the subtree that needs real-time state) with `KioProvider`. It takes the client instance and makes it available to all hooks below it:

```tsx
import { useShardState, useSubmit, KioProvider } from "kio-react"

function App() {
  return (
    <KioProvider client={client}>
      <Game seatId="seat:3" />
    </KioProvider>
  )
}
```

`KioProvider` does not create or manage the client — you do that yourself (see [Client Setup](/guides/client-setup/)). The provider only stores a reference so hooks can access it without prop drilling.

## Reading shard state with `useShardState`

`useShardState` subscribes a component to a specific shard and re-renders when the shard's state changes. It returns a `ShardState<T>` object — a discriminated union over `syncStatus`:

```tsx
const worldShard = useShardState("game", "world")
const seatShard = useShardState("game", "seat", seatId)
```

The arguments mirror the shard's identity in the schema: channel name, shard name, and (for per-resource shards) the resource ID. All arguments are fully typed from the schema — passing an unknown channel or shard name is a compile-time error.

### The `ShardState` union

The returned object has one of four shapes depending on `syncStatus`:

| `syncStatus` | `state` | `pending` | Meaning |
|---|---|---|---|
| `"unavailable"` | `null` | `null` | Actor does not have access to this shard |
| `"loading"` | `null` | `null` | Access granted, waiting for first broadcast |
| `"stale"` | `T` | `{ operationName, input } \| null` | State available but a newer version exists on the server |
| `"latest"` | `T` | `{ operationName, input } \| null` | State is up to date with the server |

Because this is a discriminated union, checking `syncStatus` narrows the type. After ruling out `"loading"` and `"unavailable"`, TypeScript knows `state` is non-null.

### Handling the loading state

The most common pattern is an early return for loading shards. This narrows the type for the rest of the function:

```tsx
function Game({ seatId }: { seatId: string }) {
  const worldShard = useShardState("game", "world")
  const seatShard = useShardState("game", "seat", seatId)
  const submit = useSubmit("game")

  if (worldShard.syncStatus === "loading" || seatShard.syncStatus === "loading") {
    return <LoadingScreen />
  }

  const { state: world } = worldShard
  const { state: seat, pending } = seatShard

  // From here, `world` and `seat` are guaranteed non-null.
  // TypeScript has narrowed the union.
```

After the loading check, you can destructure `state` and `pending` without null checks. This is not a cast or assertion — TypeScript genuinely narrows the type because the `"loading"` and `"unavailable"` variants have `state: null` and the other variants have `state: T`.

### Showing stale state

When the engine knows a newer version exists on the server (for example, after reconnection), `syncStatus` transitions to `"stale"`. The state is still available — it's just not the latest. You can use this to show a syncing indicator without hiding the UI:

```tsx
{seatShard.syncStatus === "stale" && <SyncingIndicator />}
```

This is a soft signal. The state is usable; it just might be slightly behind. Once the broadcast arrives, `syncStatus` transitions back to `"latest"` and the indicator disappears.

### Fallback values

Both variants of `useShardState` accept an optional `{ fallback }` that is returned as `state` whenever `syncStatus` is `"loading"` or `"unavailable"`. The return type narrows so `state` is always `T` — no guard clauses, no null checks:

```tsx
const world = useShardState("game", "world", {
  fallback: { gameStage: "LOBBY", turnCount: 0 },
})
// world.state is always GameWorldState — even before the first broadcast

const seat = useShardState("game", "seat", seatId, {
  fallback: { inventory: [], position: { x: 0, y: 0 } },
})
```

`syncStatus` and `pending` are still available on the returned object. Use them when you want to gate writes (e.g. disable buttons until `"latest"`) or show a soft "connecting..." indicator without hiding the UI.

Use the fallback form when a sensible placeholder exists. Reach for the narrowing form when "state doesn't exist yet" is itself meaningful to the UI — for example, a per-resource shard where `unavailable` means "you haven't been granted access yet" and should render a different component.

## Submitting operations with `useSubmit`

`useSubmit` returns a typed submit function scoped to a channel:

```tsx
const submit = useSubmit("game")
```

The returned function accepts an operation name and input, both typed from the schema:

```tsx
submit("useItem", { seatId, itemId: item.id })
```

Passing an unknown operation name or a mismatched input shape is a compile-time error. The function mirrors `client.channel("game").submit(...)` but is more ergonomic inside components — no need to access the client directly.

### Handling the result

`submit()` returns a `SubmitResult` that never throws. It carries a boolean `ok` discriminant plus a `status` for callers that need to distinguish failure modes:

```tsx
const result = await submit("useItem", { seatId, itemId: item.id })
if (!result.ok) {
  toast.error(`Submit failed: ${result.status}`)
}
```

For the common "succeed or surface an error" flow, `!result.ok` is enough. When the caller wants to react differently to `"rejected"` (server-side failure with a consumer-defined error code), `"blocked"` (another op on this shard is still in flight), `"timeout"`, or `"disconnected"`, switch on `result.status` — the discriminated union still narrows `result.error` where it exists.

## Putting it together

Here is the complete component, combining all three pieces:

```tsx
function Game({ seatId }: { seatId: string }) {
  const worldShard = useShardState("game", "world")
  const seatShard = useShardState("game", "seat", seatId)
  const submit = useSubmit("game")

  if (worldShard.syncStatus === "loading" || seatShard.syncStatus === "loading") {
    return <LoadingScreen />
  }

  const { state: world } = worldShard
  const { state: seat, pending } = seatShard

  return (
    <div>
      <h1>Stage: {world.gameStage}</h1>

      <h2>Inventory</h2>
      {seatShard.syncStatus === "stale" && <SyncingIndicator />}
      <ul>
        {seat.inventory.map(item => (
          <li key={item.id}>
            {item.name}
            <button
              disabled={pending !== null}
              onClick={() => submit("useItem", { seatId, itemId: item.id })}
            >
              Use
            </button>
          </li>
        ))}
      </ul>

      {pending && <p>Waiting for server...</p>}
    </div>
  )
}
```

A few patterns to notice:

**Loading as a gate.** The `syncStatus` check at the top narrows the union for the entire function body. You don't need to handle null state anywhere below that point.

**Disabling buttons during pending operations.** The `pending` field is non-null when the client has submitted an optimistic operation that hasn't been confirmed yet. Disabling the button prevents double-submission — the engine enforces one pending operation per shard, so a second `submit` while one is in flight would be rejected.

**Stale indicator without blocking.** The `"stale"` check renders a syncing indicator but doesn't hide the inventory. The user can still see and interact with the current state while the engine catches up.

**`pending` as a loading indicator.** The `{pending && <p>Waiting for server...</p>}` block gives the user feedback that their action is in flight. For optimistic operations, the state already reflects the prediction — this message confirms that the server hasn't acknowledged it yet.

## Reactivity model

Under the hood, `useShardState` uses React's `useSyncExternalStore` to subscribe to the framework-agnostic `ShardStore`. The store's `snapshot` property returns a stable reference that only changes when the underlying state changes. This means:

- Components re-render only when the specific shard they subscribe to changes.
- Multiple components can subscribe to the same shard without duplicating work.
- The store is not React-specific — the same `ShardStore` can drive Solid, Svelte, or any other reactive framework. `kio-react` is a thin adapter.

## What about non-React frameworks?

The client itself is framework-agnostic. `kio-react` is a convenience layer — it wraps `client.channel(...).shardState(...)` and `client.channel(...).submit(...)` in React hooks. For other frameworks, you would build an equivalent thin adapter over the same client API. The `ShardStore`'s `subscribe` and `snapshot` pattern is intentionally compatible with any reactive system.

# @kiojs/react

React bindings for [Kio](https://github.com/rynvelt/kio). Provides a provider that carries the client through React context, plus an engine-typed hook factory that produces strongly-typed `useShardState`, `useSubmit`, and (optionally) `useMySubscriptions`.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `KioProvider` — stores a `Client` reference in context. Does not create or manage the client; you do that yourself with `createClient`.
- `createKioHooks(engineBuilder)` — returns typed hooks derived from the engine's channels, shards, and operations.
- Re-exports `PendingOperation`, `ShardState`, `SubmitResult` from `@kiojs/shared` for convenience.

## Setup

```tsx
// hooks.ts
import { createKioHooks } from "@kiojs/react";
import { appEngine } from "./schema";

export const { useShardState, useSubmit } = createKioHooks(appEngine);

// main.tsx
import { KioProvider } from "@kiojs/react";
import { createClient } from "@kiojs/client";
import { createWsTransport } from "@kiojs/transport-ws";
import { appEngine } from "./schema";

const client = createClient(appEngine, {
  transport: createWsTransport({
    connect: () => new WebSocket("ws://localhost:4000"),
  }),
});

createRoot(root).render(
  <KioProvider client={client}>
    <App />
  </KioProvider>,
);
```

## Reading shard state

```tsx
import { useShardState, useSubmit } from "./hooks";

function Counter() {
  const counter = useShardState("counter", "count", {
    fallback: { value: 0 },
  });
  const submit = useSubmit("counter");

  async function onClick() {
    const result = await submit("increment", {});
    if (!result.ok) console.error(result.status);
  }

  return <button onClick={onClick}>{counter.state.value}</button>;
}
```

`useShardState` has two shapes:

- **Without `fallback`** — returns the raw `ShardState<T>` discriminated union. Narrow on `syncStatus` before reading `state`.
- **With `{ fallback }`** — returns `ShardState<T, T>` where `state` is typed as `T` on every variant; the fallback is substituted whenever `syncStatus` is `"loading"` or `"unavailable"`. Use this when a sensible placeholder exists; reach for the narrowing form when "state doesn't exist yet" is itself meaningful to the UI.

Per-resource shards take the resource id as a third positional argument:

```tsx
const player = useShardState("presence", "player", actorId, {
  fallback: { name: "", x: 0, y: 0 },
});
```

## Subscriptions

When the engine has `subscriptions: { kind }` configured, `createKioHooks` also returns `useMySubscriptions()` — the current actor's ref set, observed through the same reactive machinery.

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) and the React Integration guide under `apps/kio-docs/src/content/docs/guides/`.

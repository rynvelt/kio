# @kiojs/client

Client runtime for [Kio](https://github.com/rynvelt/kio). Holds a local mirror of the shards the actor is allowed to see, applies optimistic operations for instant feedback, and reconciles broadcasts from the server. Framework-agnostic — wire into React via `@kiojs/react` or build your own adapter on top.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `createClient(engineBuilder, config)` — constructs the client. Takes the same engine value used on the server and a transport.
- Types: `Client`, `ClientChannel`, `ClientConfig`, `ClientSubscriptionMethods`, `ConditionalClientSubscriptionMethods`.

## Setup

```ts
import { createClient } from "@kiojs/client";
import { createWsTransport } from "@kiojs/transport-ws";
import { appEngine } from "./schema";

const transport = createWsTransport({
  connect: () => new WebSocket("ws://localhost:4000"),
});

const client = createClient(appEngine, { transport });
```

## Reading shard state

```ts
const counter = client.channel("counter");
const snapshot = counter.shardState("count");
// snapshot: ShardState<T> — { syncStatus, state, pending }

const unsubscribe = counter.subscribeToShard("count", () => {
  // fired when "count" changes
});
```

`ShardState<T>` is a discriminated union on `syncStatus` (`"unavailable" | "loading" | "stale" | "latest"`). The `@kiojs/react` wrapper accepts an optional `fallback` value that substitutes into `state` during loading/unavailable, so consumers don't need to narrow on status every read.

## Submitting operations

```ts
const result = await client.channel("counter").submit("increment", {});
if (!result.ok) {
  // result.status: "rejected" | "blocked" | "timeout" | "disconnected"
  console.error("submit failed:", result.status);
}
```

`SubmitResult` never throws. The `ok` discriminant covers the common "succeed or surface an error" branch; `status` plus the per-variant `error` fields let callers distinguish server rejections (with a consumer-defined error code) from transport or local-pending failures.

## Subscriptions

When the engine has `subscriptions: { kind }` configured, the client also exposes `mySubscriptions()` (current ref set) and `subscribeToMySubscriptions(listener)` (change notifications). The server controls which shards the client sees via `grantSubscription` / `revokeSubscription`; the client observes that set as just another shard.

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) and the docs site (`apps/kio-docs`) for concepts, guides, and reference.

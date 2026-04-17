# @kiojs/shared

Shared types and builders for [Kio](https://github.com/rynvelt/kio) — authoritative state synchronization for real-time multiplayer apps. This package defines the engine/channel/shard/operation types that both `@kiojs/client` and `@kiojs/server` build on. You import it directly when you declare your schema.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `engine(opts?)` — top-level builder. Tracks registered channels, the actor schema, and the optional subscriptions feature flag.
- `channel.durable(name)` / `channel.ephemeral(name)` — channel builders. Durable channels are versioned, CAS-protected, and persisted; ephemeral channels are in-memory and latest-wins.
- `shard.ref(shardType, resourceId?)` — typed shard reference used inside `operation.scope`.
- `createSubscriptionsChannel(opts)` — the engine-managed channel holding each actor's ref set. Normally registered automatically by `createServer` / `createClient` when the engine opts into subscriptions.
- Types: `ShardState<T, TFallback>`, `SubmitResult`, `SubscriptionRef`, `TypedSubscriptionRef<TChannels>`, transport message shapes, and inference helpers (`InferChannels`, `InferActor`, `InferSubscriptions`).

## Schema example

```ts
import { channel, engine, shard } from "@kiojs/shared";
import * as v from "valibot";

const counterChannel = channel
  .durable("counter")
  .shard("count", v.object({ value: v.number() }), {
    defaultState: { value: 0 },
  })
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

The same `appEngine` value is imported by `createServer` and `createClient` so channel names, operation names, shard types, and input shapes flow end-to-end.

## Shard defaults

Declare `defaultState` on a shard to avoid manual adapter seeding at boot. The engine materializes the value the first time a shard is read (singleton) or a resource is touched (per-resource). Per-resource defaults can be a function `(resourceId) => state` for per-instance shapes.

## Typed subscription refs

`TypedSubscriptionRef<TChannels>` narrows `SubscriptionRef`'s free-form strings to `(channelId, shardId)` pairs that actually exist on the engine. `defaultSubscriptions` / `grantSubscription` / `revokeSubscription` accept it, so hand-written object literals get typechecked:

```ts
{ channelId: "presence", shardId: `player:${actor.actorId}` }  // OK
{ channelId: "rooms", shardId: "room" }                         // compile error
```

The prefix (`"player:"`) is fixed by the schema's `shardPerResource` name; the suffix is any string.

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) and the docs site (`apps/kio-docs`) for concepts, guides, and reference.

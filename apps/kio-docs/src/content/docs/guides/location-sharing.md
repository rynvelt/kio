---
title: Location Sharing
description: Using the subscription shard for dynamic access control
sidebar:
  order: 6
---

:::note[Status: Design Only]
This guide describes the target API. Implementation has not started.
:::

Most real-time features need access control that changes while the app is running. A player shares their location with a friend, then stops sharing an hour later. A game master reveals a hidden area to a specific team. An admin grants temporary spectator access.

The common instinct is to build this with point-to-point messaging: alice sends her GPS coordinates directly to bob. But that approach quickly unravels. Alice needs to track who she's sharing with, manage send intervals per recipient, handle recipients going offline and coming back, and retry delivery. The sender becomes responsible for routing, and routing logic belongs on the server.

Kio's subscription shard solves this differently. Instead of alice pushing data to bob, the server grants bob access to alice's existing presence shard. Bob starts receiving alice's updates through the normal broadcast pipeline — the same mechanism that delivers every other state change in the system. No special messaging path, no sender-side tracking, no delivery management.

This guide walks through building that pattern step by step.

## How the subscription shard works

Every actor in Kio has a subscription shard — a per-actor shard on the built-in `subscriptions` channel. It holds a list of shard refs that the actor is allowed to subscribe to:

```ts
// subscriptions:{actorId}
{
  refs: [
    { channelId: "game", shardId: "world" },
    { channelId: "presence", shardId: "player:alice" },
  ]
}
```

A ref being present means the actor can receive that shard's state. Absence means no access. The engine uses this list to decide which shards to deliver on connect and which broadcasts to forward during a session.

Only the server can modify subscription shards, using two built-in operations:

- **`grant`** — adds a shard ref to an actor's subscription list.
- **`revoke`** — removes a shard ref from an actor's subscription list.

The engine owns the mechanism. Your application code owns the policy — the when and why of granting or revoking access.

## Defining the domain operation

Location sharing starts with a domain operation. You need a way for alice to say "I want to share my location with bob." This belongs in your game channel (or whatever channel models your application logic), not in the subscriptions channel.

```ts
gameChannel.serverImpl("startShare", {
  validate(shards, input, ctx, { reject }) {
    if (input.targetPlayerId === ctx.actor.actorId) {
      return reject("CANNOT_SELF_SHARE", "Cannot share with yourself")
    }
  },
  apply(shards, input) {
    // consumer's share tracking logic
  },
})
```

The `validate` step catches the obvious error — sharing with yourself. The `apply` step updates whatever tracking state your application needs (a list of active shares, timestamps, share limits). This is your domain logic. Kio doesn't prescribe what it looks like.

Notice that this operation says nothing about subscriptions. It records the intent to share in your application's state. The subscription change happens next, as a side effect.

## Triggering subscription changes with hooks

The `afterApply` hook runs after an operation's `apply` step completes successfully. This is where you connect your domain logic to the subscription system.

```ts
server.hooks.afterApply("game", "startShare", (operation, oldStates, newStates, ctx) => {
  server.submit("subscriptions", "grant", {
    actorId: operation.input.targetPlayerId,
    ref: { channelId: "presence", shardId: `player:${ctx.actor.actorId}` },
  })
})
```

When alice submits `startShare` with `targetPlayerId: "bob"`, the hook fires after the operation lands. It tells the engine: grant bob access to alice's presence shard (`presence/player:alice`).

The reverse hook handles unsharing:

```ts
server.hooks.afterApply("game", "stopShare", (operation, oldStates, newStates, ctx) => {
  server.submit("subscriptions", "revoke", {
    actorId: operation.input.targetPlayerId,
    ref: { channelId: "presence", shardId: `player:${ctx.actor.actorId}` },
  })
})
```

Both hooks use `server.submit` — the server acting as an actor, submitting operations through the same pipeline as clients. The `grant` and `revoke` operations go through the engine's normal OCC (optimistic concurrency control). If two operations modify the same actor's subscription shard concurrently (alice and carol both share with bob at the same time), the engine handles the version conflict automatically. Adding a ref to a set is always safely retryable, so the second operation retries and succeeds.

## Reacting on the client

Bob's client doesn't need to poll for access changes or listen for special messages. It watches its own subscription shard — which it always has access to — and derives what to render from the current state.

```tsx
function LocationSharingPanel({ myActorId }: { myActorId: string }) {
  const subscriptions = useShardState("subscriptions", "subscription", myActorId)
  if (subscriptions.syncStatus !== "latest") return null

  const sharedPlayerShardIds = subscriptions.state.refs
    .filter(r => r.channelId === "presence" && r.shardId !== `player:${myActorId}`)
    .map(r => r.shardId)

  return sharedPlayerShardIds.map(shardId => (
    <SharedPlayerLocation key={shardId} shardId={shardId} />
  ))
}
```

`useShardState("subscriptions", "subscription", myActorId)` hooks into bob's own subscription shard. When the server grants bob access to a new presence shard, this component re-renders with the updated refs list.

The filter logic extracts presence-channel refs and excludes bob's own shard (he doesn't need to see himself on the map). Each remaining shard ID becomes a `SharedPlayerLocation` component.

## Rendering shared presence

Each `SharedPlayerLocation` declares interest in a specific presence shard by calling `useShardState` with that shard's ID:

```tsx
function SharedPlayerLocation({ shardId }: { shardId: string }) {
  const presence = useShardState("presence", "player", shardId)

  if (presence.syncStatus === "unavailable") return null
  if (presence.syncStatus === "loading") return <Loading />
  return <PlayerMarker gps={presence.state.gps} />
}
```

The `syncStatus` field reflects the lifecycle of the shard from the client's perspective:

- **`"unavailable"`** — the client doesn't have access to this shard (yet, or anymore). The component renders nothing.
- **`"loading"`** — access has been granted and the engine is delivering the initial state. The component shows a loading indicator.
- **`"latest"`** — the shard state is current. The component renders the player's position on the map.

This component doesn't know or care how it got access to the shard. It just declares what it wants and reacts to what the engine provides. If access is revoked later, `syncStatus` transitions back to `"unavailable"` and the component unmounts cleanly.

## The full lifecycle

Here is the complete flow when alice shares her location with bob:

1. **Alice submits `startShare`** with `targetPlayerId: "bob"`. The server validates and applies the operation to the game channel.

2. **The `afterApply` hook fires.** The server submits `subscriptions/grant`, adding `{ channelId: "presence", shardId: "player:alice" }` to bob's subscription shard.

3. **Bob's subscription shard updates.** The engine broadcasts the change to bob. His `LocationSharingPanel` re-renders, now including alice's shard ID in the list.

4. **`SharedPlayerLocation` mounts** with alice's shard ID. The ShardStore transitions from `"unavailable"` to `"loading"` as the engine delivers alice's current presence state, then to `"latest"` once the state arrives.

5. **Alice's GPS updates flow normally.** Her presence shard updates through the standard broadcast pipeline. Bob receives them because he's now a subscriber. The map marker moves.

6. **Alice stops sharing.** She submits `stopShare`. The `afterApply` hook fires `subscriptions/revoke`, removing alice's presence ref from bob's subscription shard. Bob's `LocationSharingPanel` re-renders without alice's shard ID. The `SharedPlayerLocation` component unmounts. The ShardStore returns to `"unavailable"`.

## Why this works without point-to-point messaging

The key insight is that alice's GPS data already exists — it's being written to her presence shard regardless of who's watching. The subscription shard doesn't create a new data path. It controls who's on the receiving end of an existing broadcast.

This means:

- **Alice doesn't track recipients.** She submits GPS updates to her own presence shard. The engine handles delivery to all subscribers.
- **Adding a viewer is a metadata change**, not a plumbing change. Granting bob access is a single `grant` operation on his subscription shard. No new connections, no new message types.
- **Removing a viewer is equally simple.** One `revoke` operation, and the engine stops delivering that shard's broadcasts to that actor.
- **Offline recipients don't cause problems.** If bob disconnects and reconnects, the engine reads his subscription shard on reconnect and restores his subscriptions. No "catch-up" logic needed in your code.
- **Concurrency is handled.** Multiple grants and revokes hitting the same subscription shard go through standard OCC. The engine retries and converges.

The subscription shard turns access control into state — state that flows through the same channels, shards, and broadcasts as everything else in the system. The client watches that state with the same `useShardState` hook it uses for game data, presence data, and everything else. One primitive, applied uniformly.

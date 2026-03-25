# Kio — Authoritative State Synchronization Engine

Kio is a framework for building real-time, multiplayer applications where the server owns the truth and clients stay in sync. It handles conflict resolution, optimistic updates, reconnection recovery, and state persistence — so consumers define *what* their state and operations look like, and Kio handles *how* they stay consistent.

Not a communication library — typing messages and sending them over a wire is already easy with socket.io. The value is in the state management around it.

---

## 1. Data Model

<!-- TRANSFERRED: concepts/channels.md -->
### Channels — "What consistency model does this state need?"

A real-time application typically has different kinds of state with fundamentally different requirements:

- **Game state** needs to survive server restarts, must never diverge between clients, and requires conflict detection when two players act simultaneously.
- **Player presence** (GPS, online status) is disposable — if the server restarts, clients just re-send their location. There's no meaningful "conflict" because the latest value is always correct.

These need different consistency models. Forcing them into the same model means either over-engineering presence (why version-check a GPS update?) or under-protecting game state (why skip conflict detection?).

A **channel** groups state that shares the same consistency model:

- **Durable channels** — versioned, conflict-detected, persisted, recoverable. Operations go through the full pipeline: validate, check version, apply, persist, broadcast.
- **Ephemeral channels** — unversioned, unpersisted, latest-wins. No conflict detection. State is held in memory only and rebuilt naturally on reconnect.

One connection can participate in multiple channels.

<!-- TRANSFERRED: concepts/channels.md -->
#### Broadcast control

By default, every applied operation immediately broadcasts the new shard state to all subscribers (`autoBroadcast: true`). For channels with high-frequency, low-urgency updates — presence, cursor positions, viewport state — the consumer can disable automatic broadcasting and control when broadcasts go out:

```ts
channel.ephemeral("presence", { autoBroadcast: false })
channel.durable("game", { autoBroadcast: false })
channel.durable("game", { broadcastMode: "full" })  // default: "patch"
```

With `autoBroadcast: false`, operations still apply immediately (server state is always current), but no broadcast is sent. Instead, the engine tracks which shards have changed since their last broadcast on a per-subscriber basis — a dirty set of shard IDs per subscriber. When a shard is updated, its ID is added to the dirty set of every subscriber of that shard.

The consumer triggers broadcasts explicitly via the server API:

```ts
server.broadcastDirtyShards(channelId: string, shardIds?: string[]): void
```

- Called with just `channelId`: broadcasts latest state for all dirty shards in that channel, then clears all dirty sets for that channel.
- Called with `shardIds`: broadcasts only those shards, removes only those IDs from dirty sets. Other dirty shards remain pending.

At broadcast time, the engine reads current in-memory state for each dirty shard — it does not store copies of state in the dirty set. This guarantees the broadcast always contains the latest state, even if the shard was updated multiple times between flushes.

This enables consumer-controlled broadcast policies:

```ts
// Broadcast presence every 5 seconds
setInterval(() => {
  server.broadcastDirtyShards("presence")
}, 5000)

// Broadcast a specific shard immediately (e.g., new player just joined)
server.broadcastDirtyShards("presence", [`player:${newPlayerId}`])
```

<!-- TRANSFERRED: concepts/channels.md -->
#### Ephemeral channel semantics

Ephemeral channels differ from durable channels in several important ways:

| Aspect | Durable | Ephemeral |
|---|---|---|
| Versioned | Yes (per-shard) | No |
| Persisted | Yes (via adapter) | No (in-memory only) |
| Survives server restart | Yes | No — rebuilt on reconnect |
| Conflict detection | Yes (`versionChecked`) | No — latest value wins always |
| Out-of-order protection | Yes (version comparison) | No — brief staleness possible |
| Shard creation | Explicit (via persistence) | On first write |

**State loss on server restart:** All ephemeral state is lost. This is by design. On restart, clients reconnect, the consumer's `onConnect` hook fires (rebuilding server-driven state like online/offline), and the engine automatically resubmits each client's last known value for ephemeral shards they had local state for (rebuilding client-driven state like GPS location). The consumer doesn't need to handle this explicitly.

**No version, no ordering:** Ephemeral broadcasts carry no version number — the client always accepts the latest value it receives. If two broadcasts arrive out of order (network reordering), the client may briefly show a stale update. This is acceptable for presence-style data where the next update corrects it within seconds. If a consumer needs ordering for a specific ephemeral use case, they can include a timestamp in their state schema and filter client-side.

**Shard creation:** Ephemeral shards are created in memory on first write. When the server submits a presence operation for a player that has no shard yet, the engine creates it. No persistence adapter involved.

<!-- TRANSFERRED: concepts/shards.md -->
### Shards — "Which parts of the state can change independently?"

Within a channel, not all state contends with all other state. Consider a 5-player game:

- When player 1 uses an item from their inventory, this doesn't conflict with player 2 visiting a location — their inventories are independent.
- But when player 1 transfers an item to player 2, both inventories must be updated atomically.

Without sharding, the entire game state has a single version counter. Player 1's inventory update and player 2's location visit would conflict (both target the same version), even though they touch unrelated data. Under load, this serializes all operations.

A **shard** is a piece of state with its own version counter. Operations declare which shards they touch. The engine only checks versions on affected shards, so independent operations proceed in parallel.

Two kinds:

- **Singleton shards** — one instance per channel (e.g., the game world all players see).
- **Per-resource shards** — one instance per resource ID (e.g., one inventory per seat).

Shards are identified by path-like string keys (`world`, `seat:3:inventory`). The engine treats these as opaque strings — the consumer defines the naming convention.

In persistence, each shard is a row:

```
channel_id  | shard_id             | version | state_json
------------|----------------------|---------|------------
room:abc    | world                | 22      | { ... }
room:abc    | seat:1:inventory     | 14      | { ... }
room:abc    | seat:2:inventory     | 9       | { ... }
```

Single-shard operations use a single compare-and-swap. Cross-shard operations (like item transfer) use a multi-row atomic write. Both are straightforward in SQL.

<!-- TRANSFERRED: concepts/shards.md -->
### State Ownership — "What happens when someone disconnects?"

Shards are keyed by stable IDs that the consumer chooses — not by connection IDs. Connections are transient (they come and go), but state needs to outlive them.

Consider a multiplayer game with 5 seats. If you key state by player ID, then when player 4 disconnects: is their inventory gone? Can someone else take over? What if they reconnect?

If you instead key state by seat number (`seat:4:inventory`), the state exists regardless of who is connected. Player 4 disconnects: seat 4's state persists. Player 4 reconnects: they're mapped back to seat 4 and resume. A different player takes seat 4: they see the same state.

The engine doesn't know or care what shard IDs represent. The consumer controls which connections can read and write which shards via authorization hooks. This enables:

- Persistent state that survives disconnects
- Reassigning state to a different connection
- Read-only spectators (authorize reads but not writes)

<!-- TRANSFERRED: concepts/subscriptions.md -->
### Subscription Shard — "What is this actor allowed to subscribe to?"

The engine maintains a built-in **subscription shard** per actor — a per-resource shard on a dedicated `subscriptions` channel. It tracks which shards the actor is allowed to subscribe to (read). This is the source of truth for read access and drives the engine's default authorization and initial subscription behavior.

**State shape:**

```ts
// subscriptions:{actorId}
{
  refs: [
    { channelId: "game", shardId: "world" },
    { channelId: "game", shardId: "seat:3" },
    { channelId: "presence", shardId: "player:alice" },
  ]
}
```

A shard ref being present means the actor is allowed to subscribe. Absence means denied. There is no explicit "denied" entry — not present = not allowed.

**Persistence:** The consumer chooses whether the subscriptions channel is durable or ephemeral when configuring the engine. Durable means subscription state survives server restarts. Ephemeral means it's rebuilt via `onConnect` on reconnect.

**Bootstrap:** On first connect, if the subscription shard for an actor doesn't exist, the engine creates it with a consumer-provided default set (via `defaultSubscriptions(actor)` hook). If no hook is provided, the shard is created empty. The actor always has access to its own subscription shard — this is hardcoded by the engine, not stored in the shard itself.

**Built-in operations:** The engine provides two server-only operations on the subscriptions channel:

- **`grant`** — adds a shard ref to an actor's subscription shard.
- **`revoke`** — removes a shard ref from an actor's subscription shard.

These operations reject any submission where `ctx.actor.actorId !== KIO_SERVER_ACTOR`. Only the server-as-actor can modify subscription shards. The engine owns the mechanism; the consumer owns the policy (when and why to grant or revoke).

```ts
// Consumer's game logic triggers subscription changes via server-as-actor
server.submit("subscriptions", "grant", {
  actorId: "bob",
  ref: { channelId: "presence", shardId: "player:alice" },
})

server.submit("subscriptions", "revoke", {
  actorId: "bob",
  ref: { channelId: "presence", shardId: "player:alice" },
})
```

**Concurrency:** If two operations modify the same actor's subscription shard concurrently (e.g., alice and carol both share with bob at the same time), the engine's standard OCC handles it. The second operation gets a version conflict, retries with fresh state, and succeeds. Since adding a ref to a set is always retryable regardless of what else was added, server-submitted operations with `maxRetries: 10` converge reliably.

**Integration with hooks:** The subscription shard provides sensible defaults for authorization and initial subscriptions (see Section 8). The consumer can override these hooks entirely if they want different logic.

**Client observability:** The client subscribes to its own subscription shard like any other shard. Consumer code can watch it to react to access changes — for example, rendering a location-sharing panel when a new presence ref appears:

```tsx
function SharePanel() {
  const subscriptions = useShardState("subscriptions", "subscription", myActorId)
  if (subscriptions.syncStatus !== "latest") return null

  // Derive which presence shards we have access to
  const sharedPlayerIds = subscriptions.state.refs
    .filter(r => r.channelId === "presence" && r.shardId !== `player:${myActorId}`)
    .map(r => r.shardId)

  return sharedPlayerIds.map(shardId => (
    <SharedPlayerLocation key={shardId} shardId={shardId} />
  ))
}

function SharedPlayerLocation({ shardId }: { shardId: string }) {
  const presence = useShardState("presence", "player", shardId)

  if (presence.syncStatus === "unavailable") return <NotSharedYet />
  if (presence.syncStatus === "loading") return <Loading />
  return <PlayerMarker gps={presence.state.gps} />
}
```

---

## 2. Operations

### What is an operation?

An operation is a named state mutation — the only way state changes in Kio. Both clients and the server submit operations through the same pipeline.

Every operation provides:

- **`input`** — a schema for the payload (any [StandardSchema](https://github.com/standard-schema/standard-schema) compatible library: Valibot, Zod, ArkType, etc.)
- **`scope(input, ctx)`** — which shards this operation touches
- **`apply(shards, input, serverResult?, ctx?)`** — transforms shard state. **Shared code**: identical logic runs on both client and server.

Optionally:

- **`validate(shards, input, ctx, { reject })`** — server-only rejection logic. The `reject` callback is the only way to produce typed consumer errors (see Error Model).
- **`compute(shards, input, ctx)`** — server-only computation for data the client doesn't have. The result is passed to `apply()` and broadcast to clients so they can replay the same state transition.
- **`canRetry(input, freshShards, attemptCount)`** — client-side hook: should a rejected operation be resubmitted against fresh state?

#### Shard accessors in handlers

The first argument to `apply()`, `validate()`, and `compute()` is an object keyed by shard type name. The shape depends on the shard kind:

- **Singleton shards** — direct property. `shards.world` is the state.
- **Per-resource shards** — accessor function. `shards.seat(resourceId)` returns the state for that instance. The engine pre-loads only the instances declared in `scope()`. Calling an accessor with a resource ID not in `scope()` throws a runtime error.

In `apply()`, shard states are **Immer drafts** — the consumer writes mutative code (`inv.splice(...)`, `me.gps = input.gps`), but the engine produces immutable results internally. Immer handles structural sharing (only clones what changed) and safe rollback if `apply()` throws. Immer is Kio's only runtime dependency.

In `validate()` and `compute()`, shard states are **read-only snapshots** — the consumer can inspect state but not mutate it.

#### Operation context (`ctx`)

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

### Operation Flags

Each operation declares three flags.

**`execution`**: `"optimistic"` | `"confirmed"` | `"computed"`

Controls when the client applies the state change and whether the server contributes data.

**`"optimistic"`** — The client runs `apply()` immediately and shows the result. Server confirms or rejects. Typical for operations where revealing the consequence doesn't spoil the experience — the player already knows what will happen because they initiated it.

Most commonly paired with `versionChecked: false` — pure overwrites where the server can never reject. No flicker, no rollback. When paired with `versionChecked: true`, the server may reject on version mismatch, causing a brief snap-back. Per-resource sharding reduces this conflict window significantly.

**Constraint: optimistic operations must touch exactly one shard.** If `scope()` returns multiple shard refs, `execution: "optimistic"` is a type error. Reason: optimistic multi-shard operations would require atomic rollback across multiple ShardStores, with confusing intermediate states if one rolls back before the other. Cross-shard operations should use `confirmed` or `computed`.

- *Update GPS location* (`versionChecked: false`) — pure overwrite, always accepted.
- *Toggle a setting* (`versionChecked: false`) — trivial state flip, always accepted.
- *Visit a location* (`versionChecked: true`) — optimistic show, rare conflicts.
- *Use item* (`versionChecked: true`) — optimistic removal, could snap back on concurrent transfer.

**`"confirmed"`** — The client could compute the result, but waits for server confirmation. Use when briefly showing a wrong or premature result would confuse players or break the game — revealing a puzzle solution, leaking story information, or showing state that snaps back.

- *Choose a dialogue option* — showing the response before confirmation risks leaking narrative clues if the server rejects.
- *Submit a quiz answer* — briefly flashing "correct!" before a rollback would spoil the puzzle.
- *Claim a seat* — if two players claim simultaneously and one gets rejected, the snap-back is confusing.

**`"computed"`** — The server must generate data the client doesn't have. The client waits, receives the server's result, then runs `apply()` with both input and result.

- *Roll dice* — server generates random numbers.
- *Draw a card from a shuffled deck* — deck order is server-side.
- *Reveal a hidden clue* — conditions depend on other players' secret state.
- *Request an AI-generated hint* — server calls an external API.

**`versionChecked`**: `boolean`

Controls whether the engine checks shard versions before applying.

- **`true`** — The operation's correctness depends on current state. Rejected if the shard was modified since the client last saw it.
- **`false`** — Pure overwrite. Previous state doesn't matter, version conflicts are impossible.

**`deduplicate`**: `boolean`

Controls whether the engine rejects duplicate operations. When `true`, the client includes a generated operation ID, and the engine rejects repeated IDs.

- **`true`** — Must not apply twice. (*Use item*, *send chat message*, *roll dice*.)
- **`false`** — Duplicates are harmless. (*Update GPS*, *set display name*.)

All combinations of the three flags are valid:

| execution | versionChecked | deduplicate | Example |
|---|---|---|---|
| `optimistic` | `true` | `true` | Use item — predict, show, check conflicts, prevent double-use |
| `optimistic` | `false` | `false` | Update GPS — overwrite, show immediately, duplicates harmless |
| `confirmed` | `true` | `true` | Claim seat — wait for confirmation, check conflicts |
| `confirmed` | `false` | `false` | Set "away" status — overwrite, wait for ack |
| `computed` | `true` | `true` | Roll dice — server computes, check turn, prevent double-roll |
| `computed` | `false` | `false` | Request welcome message — server computes, no state dependency |
| `optimistic` | `false` | `true` | Send chat message — show immediately, prevent duplicates |

### Submit Result

`submit()` returns a promise that resolves to a discriminated union — never throws. The consumer can always inspect the `status` to determine what happened:

```ts
const result = await client.channel("game").submit("useItem", { seatId, itemId })

switch (result.status) {
  case "acknowledged":
    // Server accepted. State broadcast will arrive (or already has for optimistic ops).
    break
  case "rejected":
    // Server rejected. result.error has details, result.freshState has current shard state.
    console.log(result.error.code)     // e.g., "VALIDATION_ERROR", "VERSION_CONFLICT"
    console.log(result.error.message)  // e.g., "Item not found"
    break
  case "blocked":
    // Not submitted — a pending operation on this shard hasn't resolved yet.
    // No server round-trip happened.
    break
}
```

The consumer can handle this reactively (inspect the result) or proactively (check `pending` on the shard state and disable UI before the user can trigger a blocked submit):

```tsx
const { state, pending } = useShardState("game", "seat", seatId)
<button disabled={pending !== null} onClick={() => submit("useItem", { seatId, itemId })}>
  Use
</button>
```

### Retry on Rejection

When the server rejects a version-checked operation (version mismatch), the rejection includes the current shard state. The client has fresh data and can decide: does this operation still make sense?

The consumer provides `canRetry(input, freshShards, attemptCount)` per operation:

- Returns `true` → resubmit with updated shard version.
- Returns `false` → operation fails.
- Not provided → defaults to `true`.

The engine enforces a maximum retry count (configurable, default 3). Retries happen internally — the consumer's `submit()` promise resolves only after all retries are exhausted. If the final attempt is rejected, `submit()` resolves with `status: "rejected"`.

Examples:

- *Use item "potion-1"*: rejected, fresh state still has potion-1. `canRetry` → `true`, succeeds on retry.
- *Use item "potion-1"*: rejected, potion-1 is gone. `canRetry` → `false`, fails.
- *Roll dice*: rejected, turn advanced. `canRetry` checks turn → `false`, fails.
- *Draw card*: rejected, deck still has cards. `canRetry` → `true`. Server re-runs `compute()`, draws a (possibly different) card.

### Privacy via Shard Design

The engine always broadcasts state to **all subscribers** of the affected shard. There is no per-operation `broadcast` flag. Privacy is controlled by shard design and subscription authorization, not by selectively withholding broadcasts.

If an operation produces private data (a personal hint, a private score), that data should live in a shard only the intended actor is subscribed to:

- *Personal hint* → store in `seat:3:hints`. Only the player at seat 3 is subscribed. The broadcast reaches all subscribers — which is just one person.
- *Private score* → store in `seat:3:score`. Same pattern.

The consumer controls who subscribes to what via the subscription shard (see Section 1). The server grants or revokes access by modifying an actor's subscription shard. The engine doesn't need to know what's "private" — it just broadcasts to subscribers, and the subscription model ensures the right people see the right shards.

### Server as Actor

The server can submit operations through the same pipeline as clients:

- Game timer expires → server submits "change game stage"
- NPC acts on a schedule → server submits an NPC action
- External webhook arrives → server submits a state update

Same `submit()` API, same `apply()`, same persistence and broadcast. The server is just another participant. When the server submits, it can configure `{ maxRetries: 10 }` to keep retrying on version conflicts — useful for operations that must eventually land (e.g., ending a game when a countdown reaches zero).

For server-submitted operations, `ctx.actor` is a synthetic system actor: `{ actorId: "__kio:server__" }`. The engine exports this as a constant (`KIO_SERVER_ACTOR`). Consumer code in shared `apply()` functions can check `ctx.actor.actorId === KIO_SERVER_ACTOR` if it needs to distinguish server-initiated operations from player-initiated ones. Broadcasts for server-submitted operations include this actor ID in the `causedBy` metadata.

A good shard design pattern: separate server-controlled state from player-contested state. If timer expirations and scheduled events write to a `world:timers` shard that only the server writes to, there's no contention — the version check passes on the first attempt every time. No retries needed, no special "force" mechanism.

For client requests needing server-side computation (dice roll), the `compute()` step handles this inline. For complex orchestration (async APIs, multi-step sequences), the server uses hooks or state subscriptions to trigger its own operations.

---

## 3. Broadcasting & Client State

### Broadcasting — "State, not operations"

The server broadcasts **complete shard state snapshots**, not operations. A broadcast message always carries an array of shard entries scoped to a single channel. The channel's kind (durable or ephemeral) determines the shape of each entry — enforced by the type system, not by convention:

```ts
type Patch = { op: "add" | "replace" | "remove"; path: string; value?: unknown }

type DurableShardEntry = {
  shardId: string
  version: number
  causedBy?: CausedBy
} & ({ state: unknown } | { patches: Patch[] })

type EphemeralShardEntry = {
  shardId: string
  causedBy?: CausedBy
} & ({ state: unknown } | { patches: Patch[] })

type BroadcastMessage =
  | { type: "broadcast"; channelId: string; kind: "durable"; shards: DurableShardEntry[] }
  | { type: "broadcast"; channelId: string; kind: "ephemeral"; shards: EphemeralShardEntry[] }
```

Each shard entry carries either `state` (full snapshot) or `patches` (Immer JSON Patch operations) — never both. The engine chooses based on the channel's `broadcastMode` and the specific broadcast context (initial connect always uses `state`).

Lifting `channelId` and `kind` to the message level makes mixed-channel broadcasts structurally impossible. Durable entries always carry a `version`; ephemeral entries never do. A single shard update is an array of length 1. A coalesced flush (see Broadcast Control in Section 1) produces an array with multiple entries.

`state` is the truth — the client uses it directly. `causedBy` is metadata for UI purposes (animations, notifications, sound effects). If `causedBy` is missing or unrecognized (stale client code after deployment), the client still works — it just doesn't animate.

Why state instead of operations:

- **Can never diverge.** Each broadcast is self-contained truth. No risk of sync issues from missed operations, reordered delivery, or `apply()` differences across client versions.
- **Ordering doesn't matter.** Each broadcast carries a version. The client ignores versions lower than what it already has.
- **Recovery is trivial.** A reconnecting client just needs current state per shard — same as any broadcast.
- **Sharding makes it efficient.** Per-resource shards are small. Broadcasting a seat's inventory is barely more bytes than the operation itself.

#### Patch-based broadcasting

By default, the engine broadcasts **patches** (Immer's JSON Patch output) instead of full shard state. Since `apply()` already runs on Immer drafts, the engine uses `produceWithPatches()` instead of `produce()` to capture the patches automatically — zero consumer code, zero API change.

Patches describe only what changed. For a fog-of-war shard with 500 revealed cells where 3 are added, the broadcast contains 3 patch operations instead of all 503 cells. For a seat inventory where one item is removed, the broadcast contains one `remove` operation instead of the entire inventory.

The engine uses full state (not patches) in these cases:
- **Initial connect and reconnect** — the client has no base state to patch against.
- **Rejection with fresh state** — the client needs a complete base after a conflict.
- **When the patch is larger than the full state** — rare, but the engine falls back automatically.

Consumers can force full-state broadcasts per channel as an escape hatch:

```ts
channel.durable("game", { broadcastMode: "full" })    // always broadcast full state
channel.durable("game", { broadcastMode: "patch" })   // default — broadcast patches
```

This is transparent to the client — the ShardStore handles both modes. `useShardState()` and the `ShardState<T>` type are unchanged. The consumer's `apply()` code is unchanged.

### Client-Side State — "One state, not two"

From the consumer's perspective, each subscribed shard exposes **one state**. The consumer never decides between "authoritative" and "optimistic." The engine resolves this internally.

```ts
const inventory = client.channel("game").state("seat", "seat:3")
// → { items: [...] }  — always the right thing to show

// Shard state is a discriminated union — syncStatus narrows the type of state:
const shard = client.channel("game").shardState("seat", "seat:3")
// shard.syncStatus: "unavailable" | "loading" | "stale" | "latest"
// shard.state:      null (when loading) | T (when stale or current)
// shard.pending:    null | { operationName, input }
```

```ts
type ShardState<T> =
  | { syncStatus: "unavailable"; state: null; pending: null }
  | { syncStatus: "loading"; state: null; pending: null }
  | { syncStatus: "stale"; state: T; pending: { operationName: string; input: unknown } | null }
  | { syncStatus: "latest"; state: T; pending: { operationName: string; input: unknown } | null }
```

When the consumer checks `syncStatus`, TypeScript narrows `state` automatically — no null checks scattered through the code:

```ts
if (shard.syncStatus === "loading") {
  // shard.state is null here — TypeScript knows
}
// After narrowing, destructure for clean access:
const { state, pending } = shard
// state is T — guaranteed non-null
// pending is { operationName, input } | null
```

The client also exposes transport-level connection state, independent of per-shard sync:

```ts
client.connectionState  // "connecting" | "connected" | "reconnecting" | "disconnected"
```

For React (separate `kio-react` package):

```tsx
function Inventory({ seatId }: { seatId: string }) {
  const shard = useShardState("game", "seat", seatId)

  if (shard.syncStatus === "loading") return <LoadingScreen />

  // After narrowing, destructure for clean access
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

### ShardStore — Implementation

The engine's client-side `ShardStore` is framework-agnostic. One instance per subscribed shard. It holds two internal slots — but the consumer only sees the resolved state.

```ts
class ShardStore<T> {
  // ── Internal state ───────────────────────────────────────────────
  private authoritative: { state: T; version: number } | null  // version is undefined for ephemeral
  private serverVersion: number | null       // set from manifest, null if not yet known
  private pending: {
    state: T               // pre-computed, not a lazy transform
    opId: string
    operationName: string
    input: unknown
    versionChecked: boolean
    apply: (state: T) => T // kept for re-computation on new authoritative
  } | null

  // ── Consumer-facing API ──────────────────────────────────────────
  get snapshot(): ShardState<T>
    // Discriminated union — syncStatus narrows the type:
    // { syncStatus: "unavailable", state: null, pending: null }
    // { syncStatus: "loading",     state: null, pending: null }
    // { syncStatus: "stale",       state: T,    pending: ... | null }
    // { syncStatus: "latest",      state: T,    pending: ... | null }

  subscribe(listener: () => void): () => void  // listener called on any state change
}
```

The `state` property returns a stable reference — only replaced when the underlying state actually changes. This makes it compatible with any reactive framework (React's `useSyncExternalStore`, Solid signals, Svelte stores, etc.) without special caching.

**Manifest handling:** When the engine receives a `manifest` message, it sets `serverVersion` on each ShardStore. If `serverVersion > authoritative.version`, the store transitions to `syncStatus: "stale"`. When the subsequent broadcast arrives and updates `authoritative`, it transitions to `"latest"`. This enables the consumer to show "syncing..." indicators on shards that have valid-but-outdated state.

Ephemeral shards are not included in the manifest (they have no versions). An ephemeral ShardStore starts in `"loading"` and transitions directly to `"latest"` on its first broadcast — there is no `"stale"` state for ephemeral shards.

**Unavailable state:** A ShardStore starts in `"unavailable"` when the actor's subscription shard does not include the corresponding shard ref. The consumer can declare a ShardStore for any shard — even one the actor doesn't have access to yet. The ShardStore exists, but with `state: null`. When the server grants access (adds the ref to the actor's subscription shard and starts sending broadcasts), the store transitions to `"loading"` → `"latest"`. When access is revoked (ref removed from subscription shard, server stops sending broadcasts), the store transitions back to `"unavailable"` and state is cleared to `null`.

**On server broadcast:**

The client receives a broadcast message with `channelId`, `kind`, and an array of shard entries. The client iterates the entries and feeds each to the corresponding ShardStore. The processing per entry depends on the channel kind:

For **durable channels** (entry has version V, metadata C, and either full state S or patches P):

1. If `V <= authoritative.version` → ignore (stale).
2. If entry has `state` → set `authoritative = { state: S, version: V }`.
   If entry has `patches` → set `authoritative = { state: applyPatches(authoritative.state, P), version: V }`.
3. If no pending → done.
4. If `C` confirms our pending operation (matching operation ID) → clear pending.
5. If someone else's change and pending exists:
   - `pending.versionChecked === true` → clear pending. Prediction was based on stale state.
   - `pending.versionChecked === false` → keep pending, re-compute by running `pending.apply()` against new authoritative state. The prediction is a pure overwrite — still valid regardless of what others changed.
6. Notify subscribers.

For **ephemeral channels** (entry has metadata C, no version, and either full state S or patches P):

1. Always accept. If entry has `state` → set `authoritative = { state: S }`. If entry has `patches` → set `authoritative = { state: applyPatches(authoritative.state, P) }`. No version comparison.
2. Same pending logic as above (steps 3–5), though in practice most ephemeral operations are `versionChecked: false` so pending is always kept.
3. Notify subscribers.

The same ShardStore class handles both — `version` is `undefined` for ephemeral shards, and the "ignore if stale" check is skipped when there's no version. Consumers should be aware that without versioning, briefly stale state is possible if broadcasts arrive out of order. For ephemeral data like presence this is acceptable — the next update corrects it within seconds.

When a broadcast message contains multiple entries (from a coalesced flush), the client engine processes all entries in a single synchronous loop, updating each ShardStore and notifying its subscribers in turn. Framework bindings (e.g., `kio-react`) are responsible for batching UI updates across multiple ShardStore notifications if needed — the core engine does not implement framework-specific rendering optimizations.

**On optimistic submit:**

1. If pending exists → reject (one at a time per shard).
2. Run `apply()` with input against authoritative state. Store result as `pending.state`.
3. Notify subscribers — exposed state immediately reflects prediction.

**On rejection:**

1. Clear pending. Exposed state reverts to authoritative.
2. If `versionChecked` and `canRetry()` returns `true` → resubmit with version from current authoritative.
3. Notify subscribers.

### Why `apply()` is shared code

Even though the server broadcasts state, the `apply()` function is shared between client and server:

- **Server:** `apply()` computes new state from operations. Always needed.
- **Client (optimistic):** `apply()` pre-computes the predicted state on submit.
- **Client (confirmed/computed):** `apply()` is not needed client-side. The client waits for the state broadcast.

For optimistic operations, the prediction should match the server's result (same code, same inputs). When confirmed, the broadcast state matches what the client already shows — seamless. If rejected, the client discards the prediction.

---

## 4. Operation Lifecycle & Failure Modes

### Server-Side Pipeline

```
Client                              Server
  |                                   |
  |-- submit(op, input) ----------->|
  |   [if optimistic:               |
  |    pending = apply(auth, input)] |
  |                                  |-- validate(shards, input)
  |                                  |-- compute(shards, input)            [if computed]
  |                                  |-- apply(shards, input, result)
  |                                  |-- persist (compareAndSwap)
  |                                  |-- broadcast state + version ------> subscribers
  |                                  |     { shardId, version, state,
  |<-- acknowledge/reject -----------|       causedBy: { op, input, actor } }
  |                                  |
  |   [if optimistic: clear pending] |
  |   [if confirmed/computed: set    |
  |    authoritative, notify]        |
  |   [if rejected + canRetry:       |
  |    resubmit with fresh version]  |
```

### Failure Modes

**Server crash between request and persist:** Nothing was persisted. Request is lost. Client times out, can retry or resync. No cleanup needed.

**Server crash after persist, before broadcast:** State is saved but clients don't know. On reconnect, client reports its version, server sends current state if newer.

**Version mismatch (conflict):** Server rejects, sends current shard state. Client's `canRetry` hook decides whether to resubmit.

### Conflict Resolution

For `versionChecked: true` operations:

- Operation carries expected version of affected shard(s)
- Server rejects on mismatch, includes current state in rejection
- `canRetry` determines whether to resubmit against fresh state
- If not retrying: pending is dropped, client shows authoritative state

For `versionChecked: false` operations:

- No version check — applied regardless
- No conflict possible

### Recovery

Recovery uses the same mechanism as initial connection — not a special protocol. The client includes its local shard versions in the reconnection handshake. The server only sends state for shards that have changed.

**Durable channels:** Server compares versions per shard. Only sends state where the server's version is higher than what the client reported. For a brief disconnect where nothing changed, zero data is transferred.

**Ephemeral channels:** Two mechanisms rebuild state on reconnect:

1. **Server-driven state** (e.g., online/offline presence): the consumer's `onConnect` hook fires and submits operations as usual — the same code that runs on first connect.
2. **Client-driven state** (e.g., GPS location): the engine automatically resubmits the client's last known value for each ephemeral shard it had local state for. No consumer code needed.

### Error Model

Errors fall into three tiers, each with different type safety guarantees and handling expectations.

#### Tier 1: Unexpected engine errors (bugs)

Something went wrong internally — a null pointer in the engine, the persistence adapter threw an unexpected exception, etc. The consumer didn't cause this and can't handle it meaningfully.

- Server logs the full error with stack trace.
- Client receives a generic error: `{ code: "INTERNAL_ERROR", message: "An unexpected error occurred" }`. Internal details (stack traces, shard contents, adapter errors) are never leaked to the client.
- Returned as `status: "rejected"`.

#### Tier 2: Expected engine errors

The engine itself rejects the operation for a known reason. These are a fixed set exported by Kio:

| Code | Meaning |
|---|---|
| `VERSION_CONFLICT` | Shard version mismatch. Includes fresh state. `canRetry` decides. |
| `UNAUTHORIZED` | `authorize()` returned false. |
| `DUPLICATE_OPERATION` | Operation ID already seen (dedup). |
| `SHARD_NOT_FOUND` | Referenced shard doesn't exist. |
| `INVALID_INPUT` | StandardSchema validation failed on the input. |
| `INTERNAL_ERROR` | Unexpected engine error (tier 1, surfaced generically). |

Client-only (returned as `status: "blocked"`, no server round-trip):

| Code | Meaning |
|---|---|
| `PENDING_OPERATION` | Another operation on the same shard hasn't resolved yet. |

The consumer can match on these:

```ts
if (result.status === "rejected" && result.error.code === "VERSION_CONFLICT") { ... }
```

#### Tier 3: Consumer-defined errors (type-safe, per operation)

Consumer-defined errors are declared per operation in the shared schema, so the client gets full type safety:

```ts
// schema.ts (shared) — declares possible error codes for this operation
.operation("useItem", {
  execution: "optimistic",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ seatId: v.string(), itemId: v.string() }),
  errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
  // ...
})
```

Server-side handlers receive a `reject()` callback as part of their context. This is the only way to produce a typed error that reaches the client. The callback is typed against the operation's `errors` schema — passing an undeclared code is a compile error:

```ts
// schema.server.ts — validate() uses reject() for typed errors
.serverImpl("useItem", {
  validate({ seat }, input, ctx, { reject }) {
    const item = seat(input.seatId).inventory.find(i => i.id === input.itemId)
    if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory")
    //                        ^^^^^^^^^^^^^^^ — autocomplete, type-checked against errors schema
    if (item.quantity < 1) return reject("INSUFFICIENT_QUANTITY", "No uses left")
  },
})
```

The contract:
- **Call `reject()`** → typed error reaches the client (tier 3). `reject()` returns `never` — the `return reject(...)` pattern makes control flow explicit.
- **Throw or let an error escape** → engine catches it, logs full details server-side, sends `INTERNAL_ERROR` to client (tier 1). Internal details never leak.
- **Return normally** → validation passed, operation proceeds.

For deep validation logic, the consumer catches their own errors and maps them to `reject()`:

```ts
.serverImpl("transferItem", {
  validate({ seat }, input, ctx, { reject }) {
    try {
      complexInventoryValidation(seat(input.fromSeatId), input.itemId)
    } catch (e) {
      if (e instanceof ItemNotFoundError) return reject("ITEM_NOT_FOUND", e.message)
      if (e instanceof InventoryFullError) return reject("INVENTORY_FULL", e.message)
      // Unknown errors fall through — engine catches and sends INTERNAL_ERROR
    }
  },
})
```

On the client, the error code is a typed union of the operation's declared codes plus the engine's built-in codes:

```ts
const result = await client.channel("game").submit("useItem", { seatId, itemId })
if (result.status === "rejected") {
  switch (result.error.code) {
    case "ITEM_NOT_FOUND":          // consumer-defined (from errors schema)
    case "INSUFFICIENT_QUANTITY":    // consumer-defined (from errors schema)
    case "VERSION_CONFLICT":         // engine-defined
    case "UNAUTHORIZED":             // engine-defined
    // ... exhaustive switch, TypeScript enforces all cases
  }
}
```

Every error, regardless of tier, carries a `code: string` and `message: string`. The type system ensures the client knows exactly which codes are possible for each operation.

---

## 5. Architecture & Packages

### Layers

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

### Packages

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

Kio's core has **one runtime dependency** (Immer, for immutable state management in `apply()`) and **zero dependencies** on schema validation libraries, transport libraries, or persistence libraries. State schemas (`input`, `serverResult`, shard state) accept any library that implements the [StandardSchema](https://github.com/standard-schema/standard-schema) interface — Valibot, Zod, ArkType, or any future library that adopts the standard. The engine uses StandardSchema's `~standard.validate()` for runtime validation of incoming operations and infers TypeScript types from the schema for compile-time safety in `apply()`, `validate()`, `compute()`, etc.

### Type Safety and Schema Split

A central design goal: **the type system enforces correctness across client and server, while ensuring each side only bundles the code it needs.**

The problem with a single schema file: `validate()` and `compute()` are server-only code. `canRetry()` is client-only. If the client imports the schema, it bundles server logic (wasteful, potential security leak). If everything is in one big config object, TypeScript often can't infer the types correctly because parts of the config reference types from other parts.

Kio solves both problems with the builder pattern and a three-file split.

#### Builder pattern for type inference

Channels are built incrementally. Each `.shard()` call returns a new typed channel that includes that shard. By the time `.operation()` is called, all shard types are fully resolved — TypeScript doesn't need to infer everything at once.

```ts
channel.durable("game")
  .shard("world", worldState)               // → Channel<{ world: WorldState }>
  .shardPerResource("seat", seatState)      // → Channel<{ ..., seat: (id) => SeatState }>
  .operation("useItem", {
    input: v.object({ seatId: v.string(), itemId: v.string() }),
    // TypeScript already knows seat's type from the chain above.
    // Input type is inferred from the Valibot schema.
    apply({ seat }, input) { ... },
  })
```

Operations use config objects (not chaining) because at that point the shard types and input schema are independent inference problems that TypeScript handles well within a single object.

#### Three-file split

The `execution` flag determines where `apply()` goes — enforced by the type system:

- `execution: "optimistic"` → `apply()` **must** be in the shared schema. The client needs it to pre-compute the optimistic state. The type requires it; omitting it is a compile error.
- `execution: "confirmed"` or `"computed"` → `apply()` **must** be in `.serverImpl()`. The client doesn't need it (it receives the state broadcast). The type rejects it in the shared schema.

**`schema.ts`** — the contract, imported by both sides. Contains: state schemas, operation flags, input/output schemas, scope, and `apply()` for optimistic operations only.

```ts
import { channel, shard, operation } from "kio/core"

export const gameChannel = channel.durable("game")
  .shard("world", worldState)
  .shardPerResource("seat", seatState)

  .operation("useItem", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: useItemInput,
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {                     // ✓ required here
      const inv = seat(input.seatId).inventory
      inv.splice(inv.findIndex(i => i.id === input.itemId), 1)
    },
  })

  .operation("rollDice", {
    execution: "computed",
    versionChecked: true,
    deduplicate: true,
    input: rollDiceInput,
    serverResult: rollDiceResult,
    scope: () => [shard.ref("world")],
    // No apply() here — type error if you try
  })
```

**`schema.server.ts`** — server-only. Never imported by client. Adds `validate()`, `compute()`, and `apply()` for non-optimistic operations. Assembles the server engine.

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const serverEngine = engine()
  .channel(
    gameChannel
      .serverImpl("useItem", {
        validate({ seat }, input, ctx, { reject }) {     // ✓ server-only
          if (!seat(input.seatId).inventory.some(i => i.id === input.itemId)) {
            return reject("ITEM_NOT_FOUND", "Item not in inventory")
          }
        },
        // No apply() — type error, already in shared schema
      })
      .serverImpl("rollDice", {
        validate({ world }, input, ctx, { reject }) {    // ✓ server-only
          if (world.gameStage !== "PLAYING") return reject("NOT_PLAYING", "Game is not active")
        },
        compute({ world }, input) {                      // ✓ server-only
          return { results: input.dice.map(d => Math.floor(Math.random() * d.max) + 1) }
        },
        apply({ world }, input, serverResult) {          // ✓ required here
          world.diceResults[input.target] = { ... }
        },
      })
  )
  .channel(presenceChannel)
```

**`schema.client.ts`** — client-only. Never imported by server. Adds `canRetry()`. Assembles the client engine.

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const clientEngine = engine()
  .channel(
    gameChannel
      .clientImpl("useItem", {
        canRetry(input, { seat }) {                      // ✓ client-only
          return seat(input.seatId).inventory.some(i => i.id === input.itemId)
        },
      })
  )
  .channel(presenceChannel)
```

**Entrypoints** import only their side:

```ts
// server.ts — bundles schema.ts + schema.server.ts, never schema.client.ts
import { serverEngine } from "./schema.server"
const server = createServer(serverEngine, { ... })

// client.ts — bundles schema.ts + schema.client.ts, never schema.server.ts
import { clientEngine } from "./schema.client"
const client = createClient(clientEngine, { ... })
```

#### What this guarantees

- **Client bundle never contains `validate()` or `compute()`** — they only exist in `schema.server.ts`.
- **Server bundle never contains `canRetry()`** — it only exists in `schema.client.ts`.
- **`apply()` placement is compiler-enforced** — the execution flag determines which file it goes in. Put it in the wrong place → type error.
- **Completeness is compiler-enforced** — the type system requires a `serverImpl` for every operation that needs server-only code (determined by the flags: `validate`, `compute`, or `apply` for non-optimistic operations). Optimistic operations with no validation don't need one. Same logic applies for `clientImpl` — only required when the operation provides client-only code like `canRetry`.
- **Type safety flows across the split** — `.serverImpl("useItem", ...)` knows the input type and shard types because it chains from `gameChannel`. The consumer never manually syncs types between files.

---

## 6. Transport

### Transport Interface

The transport's job is narrow: move bytes between connections. It doesn't know about shards, operations, or state. The engine serializes messages via the `Codec`, the transport delivers them.

**Server-side:**

```ts
interface ServerTransport {
  /** Start accepting connections */
  listen(handler: ServerTransportHandler): void

  /** Send a message to one connection */
  send(connectionId: string, data: Uint8Array): void

  /** Send a message to multiple connections */
  sendMany(connectionIds: string[], data: Uint8Array): void

  /** Drop a connection */
  disconnect(connectionId: string): void

  /** Graceful shutdown */
  shutdown(): Promise<void>

  /**
   * Liveness contract: the transport MUST call handler.onDisconnection()
   * within this many ms of a client becoming unresponsive.
   */
  readonly livenessTimeoutMs: number
}

interface ServerTransportHandler {
  onConnection(conn: IncomingConnection): void
  onDisconnection(connectionId: string, reason: string): void
  onMessage(connectionId: string, data: Uint8Array): void
}

interface IncomingConnection {
  id: string
  headers: Record<string, string | string[] | undefined>
  query: Record<string, string | undefined>
  extra: Record<string, unknown>  // transport-specific data (e.g., socket.io's auth object)
}
```

**Client-side:**

```ts
interface ClientTransport {
  connect(url: string, options?: { headers?: Record<string, string> }): void
  send(data: Uint8Array): void
  disconnect(): void

  onConnected(handler: () => void): void
  onDisconnected(handler: (reason: string) => void): void
  onMessage(handler: (data: Uint8Array) => void): void
}
```

Both interfaces deal in `Uint8Array` — raw bytes. The engine's `Codec` serializes and deserializes on top. The transport doesn't inspect message contents.

### Engine Message Protocol

The engine defines a small set of message types encoded/decoded by the codec:

```ts
// Client → Server
| { type: "submit", opName: string, input: unknown, shardVersions: Record<string, number>, opId: string }
// Note: recovery is not a separate message — shard versions are sent in the handshake (query params)

// Server → Client
| { type: "manifest", versions: Record<string, number> }  // first message after connect — current server versions per shard
| { type: "broadcast", channelId: string, kind: "durable",
    shards: Array<DurableShardEntry> }   // see Section 3 for entry types (state or patches)
| { type: "broadcast", channelId: string, kind: "ephemeral",
    shards: Array<EphemeralShardEntry> } // see Section 3 for entry types (state or patches)
| { type: "acknowledge", opId: string }
| { type: "reject", opId: string, error: ErrorInfo, freshShards: Record<string, { state: unknown; version: number }> }
| { type: "ready" }  // sent after all stale shard broadcasts complete
```

The transport never inspects these — it just moves bytes.

### Adapter Implementations

**Socket.IO adapter** wraps socket.io's server and client. Provides reconnection, heartbeats, and connection state recovery out of the box. Liveness detection via socket.io's built-in ping/pong (configurable `pingInterval` and `pingTimeout`).

**WebSocket adapter** wraps native WebSocket (or Bun's `Bun.serve` websocket). Leaner, but the adapter must implement its own ping/pong loop and timeout logic to meet the liveness contract.

### Connection Lifecycle

The transport adapter normalizes framework-specific connection details into an `IncomingConnection` object. The engine never sees the framework's native types — Socket.IO's handshake, Bun's upgrade request, etc. are all mapped to the same shape (`headers`, `query`, `extra`). Framework-specific data the adapter wants to preserve goes in `extra`.

**Initial connection and reconnection:**

The client includes two things in the handshake (via query params, headers, or whatever the transport supports):

- **Intent** — which channel/room it wants (e.g., `?room=room:abc`)
- **Local shard versions** — what state it already has (e.g., `?versions=world:22,seat:3:14`). Empty on first-ever connection.

```
HTTP layer (handshake):
  Client → Server: auth credentials + intent + local shard versions
  Server → Client: connection accepted (just the upgrade, no data payload)

Message layer (after upgrade):
  Server → Client: manifest (current server version per subscribed shard)
  Server → Client: broadcast for each stale shard (version > client's)
  Server → Client: "ready"
```

The **manifest** is the first message after connect. It tells the client immediately which shards are up to date and which are stale (update incoming). The client can use this to show fine-grained sync status per shard — showing last known state with a "syncing..." indicator rather than a full loading screen.

The engine's perspective:

```
1. IncomingConnection arrives with { headers, query, extra }
   → query contains auth, intent, and shard versions
2. Engine runs authenticate(conn) → actor
3. Engine loads (or creates) the actor's subscription shard
   → If new actor: calls defaultSubscriptions(actor) to populate initial refs
   → If subscriptionsOnConnect hook is provided: calls it instead (override)
4. Engine determines subscribed shards from subscription shard refs
5. Engine parses client's shard versions from conn.query
6. Engine sends manifest: { type: "manifest", versions: { shardId: serverVersion, ... } }
7. For each subscribed shard:
   → server version == client version → skip (client is up to date)
   → server version > client version  → send current state via transport.send()
   → client didn't report this shard  → send current state
8. Engine sends "ready" via transport.send()
9. Engine calls consumer's onConnect(actor) hook
```

The server sends state using the same `transport.send()` it uses for any broadcast — no special mechanism. The shard versions travel up via the HTTP handshake; the state travels down via normal transport messages.

For a reconnect after a brief connection drop, this means near-zero data — the client already has most shards at the current version. Only genuinely stale shards get a state push.

If the client can't include shard versions in the handshake (too many shards, URL length limits), it sends an empty map and gets a full sync — graceful fallback to the same behavior as a first connection.

By default, the engine reads the actor's subscription shard to determine which shards to deliver. For consumers that need connection-specific logic (e.g., different subscriptions based on URL query params), the `subscriptionsOnConnect` hook overrides this:

```ts
// Optional override — replaces subscription shard lookup for initial subscriptions
subscriptionsOnConnect(actor, conn, channelName) {
  const roomId = conn.query.room
  const seatId = seatAssignments.getSeatForPlayer(actor.actorId, roomId)
  return [shard.ref("world"), shard.ref("seat", seatId)]
}
```

**Mid-session subscription changes:** Subscriptions are managed server-side via the subscription shard (see Section 1). When the server grants or revokes access by modifying an actor's subscription shard, the engine updates its internal subscriber map and starts or stops sending broadcasts accordingly. The client observes these changes through its own subscription shard's ShardStore and reacts in the UI — there is no client-initiated subscribe/unsubscribe message.

**Disconnection:**

1. Transport fires `onDisconnection`
2. Engine cleans up shard subscriptions
3. Engine calls consumer's `onDisconnect(actor, reason)` hook

**Ephemeral channels on reconnect:** Server-driven ephemeral state (e.g., online/offline) is rebuilt by the `onConnect` hook. Client-driven ephemeral state (e.g., GPS location) is auto-resubmitted by the engine from the client's last known values.

### Liveness and Presence

The engine has no built-in concept of "presence." Instead, presence is modeled as an ephemeral channel where the **server is the actor** — it submits operations when connections come and go.

```ts
const server = createServer(engine, {
  // ...
  onConnect(actor) {
    server.submit("presence", "setOnline", { playerId: actor.id })
  },
  onDisconnect(actor, reason) {
    server.submit("presence", "setOffline", { playerId: actor.id })
  },
})
```

The engine relies on the transport to detect dead connections. The transport's `livenessTimeoutMs` property declares how quickly it will fire `onDisconnection` after a client becomes unresponsive. Each adapter implements this differently:

- **Socket.IO adapter**: configures `pingInterval` + `pingTimeout`. Socket.IO handles ping/pong internally and fires disconnect when the timeout expires. Covers the common "client silently dies" case.
- **WebSocket adapter**: implements its own ping/pong frame loop with configurable timeout.

**Edge case: backgrounded clients.** A mobile client might be backgrounded by the OS. The TCP connection stays alive (OS handles keepalives), but the client app isn't running. Transport-level ping/pong may not catch this because the OS responds on behalf of the app.

For this case, the consumer can add **application-level heartbeats** on top: define a `heartbeat` operation on the presence channel, have the client submit it every N seconds, and run a server-side sweep that marks players offline if no heartbeat arrived within a threshold. This is consumer code using engine primitives — the engine provides the tools (ephemeral channel, server as actor, scheduled operations), the consumer wires the policy.

---

## 7. Persistence

### Adapter Interface

Deliberately minimal. The engine handles versioning, conflict detection, and recovery. The adapter stores and retrieves versioned blobs:

```ts
interface StateAdapter {
  load(channelId: string, shardId: string): Promise<{ state: T; version: number } | null>

  compareAndSwap(
    channelId: string,
    shardId: string,
    expectedVersion: number,
    newState: T,
    newVersion: number,
  ): Promise<boolean> // true = written, false = version mismatch

  compareAndSwapMulti(
    operations: Array<{
      channelId: string
      shardId: string
      expectedVersion: number
      newState: T
      newVersion: number
    }>
  ): Promise<boolean> // all succeed or none (cross-shard operations)
}
```

Maps directly to every database:

- SQL: `UPDATE ... SET state=$new, version=$v WHERE shard_id=$id AND version=$expected`
- DynamoDB: conditional put
- Redis: WATCH/MULTI

### Conformance Tests

Adapters must pass a test suite shipped by Kio:

```ts
import { runAdapterConformanceTests } from "kio-test-kit"

runAdapterConformanceTests({
  createAdapter: () => new PrismaStateAdapter(prisma),
})
```

The suite verifies:

- `load()` after successful `compareAndSwap()` returns the new version
- Two concurrent `compareAndSwap()` with same expected version: exactly one succeeds
- `compareAndSwap()` with wrong version returns false, state unchanged
- `compareAndSwapMulti()` is atomic (all or nothing)

The engine also adds runtime guards: version monotonicity checks, post-write verification, error boundaries around all adapter calls.

---

## 8. Hooks & Extension Points

All hooks are optional.

### Connection Lifecycle

- `authenticate(conn)` — runs **once on connect**. Validates credentials, returns an actor object with `actorId: string` (required) plus any consumer-defined fields. This object is available as `ctx.actor` in all subsequent hooks and handler functions.
- `defaultSubscriptions(actor)` — returns the initial set of shard refs for a new actor's subscription shard. Called **once**, when the actor's subscription shard is first created (not on every connect). If not provided, the subscription shard is created empty. The actor's own subscription shard ref is always included automatically — the consumer does not need to add it.
- `subscriptionsOnConnect(actor, conn, channelName)` — **optional override**. If provided, replaces the default behavior of reading the subscription shard. Runs once per channel on connect, right after authentication. Returns the shard refs for that channel this actor should receive state for. Use this when you need subscription logic that doesn't fit the subscription shard model (e.g., based on URL query params, connection-specific context, or an external system).
- `onConnect(actor)` — called after authentication and initial subscription setup (e.g., submit presence operations).
- `onDisconnect(actor, reason)` — called when connection drops (e.g., mark player offline).

### Authorization

- `authorize(actor, operationName, shardRefs)` — runs **on every operation submission**. Can this actor perform this operation on these shards? The subscription shard does not affect write authorization — this hook is the sole authority for operation permissions.
- `authorizeSubscription(actor, shardRefs)` — **optional override**. By default, the engine checks the actor's subscription shard: if the shard ref is present, access is granted; if absent, access is denied. If the consumer provides this hook, it replaces the subscription shard check entirely — the consumer takes full responsibility for authorization logic.

### Subscriptions and the subscriber map

The engine maintains an in-memory map of which connections are subscribed to which shards:

```ts
// Engine internal — not exposed to consumers
connections: Map<connectionId, {
  actor: Actor,
  subscribedShards: Set<ShardRef>
}>
```

This map is never persisted. On server reboot, it's gone. On client reconnect:

1. `authenticate()` runs → actor identity restored
2. Engine reads the actor's subscription shard → determines allowed shard refs
3. Engine populates the subscriber map for this connection
4. Client sends shard versions → server sends state for stale shards

The subscription shard is the persistent source of truth for what an actor is allowed to subscribe to. The in-memory subscriber map is a runtime projection of that state. When the subscription shard changes (via `grant`/`revoke` operations), the engine updates the subscriber map to match — adding or removing the connection from the affected shards' broadcast lists.

### Operation Lifecycle

- `beforeApply(operation, shardStates, ctx)` — called before `apply()`, can transform or reject
- `afterApply(operation, oldStates, newStates, ctx)` — called after `apply()`, for side effects (audit logging, analytics, triggering other systems)

If a hook throws, the engine treats it as a rejection. The operation is not applied, the client receives a structured error. The engine never crashes due to a hook failure.

### Serialization

```ts
interface Codec {
  encode(message: unknown): ArrayBuffer | string
  decode(data: ArrayBuffer | string): unknown
}
```

Default: an extended JSON codec that handles `Set` and `Map` (serialized as tagged arrays, e.g., `{ __set: ["a", "b"] }`). Standard `JSON.stringify` silently breaks these types (`new Set()` becomes `{}`), so the engine's default codec handles them transparently. Consumers can replace the default with msgpack, protobuf, or a custom codec.

---

## 9. Scope

**In scope:**

- Operation lifecycle (validate, compute, apply, persist, broadcast state)
- Operation flags (`execution`, `versionChecked`, `deduplicate`)
- Authoritative server state with OCC
- Optimistic client state with automatic reconciliation
- State sharding with per-shard versioning
- State broadcasting (complete shard snapshots, array-based, per-channel)
- Broadcast control (`autoBroadcast`, `broadcastDirtyShards`, per-subscriber dirty tracking)
- Recovery via current-state delivery
- Client-side `canRetry` hook for automatic retry on version conflicts
- Server as actor (submitting operations through the same pipeline)
- Subscription shard (per-actor, engine-managed, built-in grant/revoke operations)
- Transport, persistence, and serialization as pluggable adapters
- Authorization and lifecycle hooks (with subscription-shard-based defaults)
- Runtime validation of operation inputs (Valibot/Zod schemas)
- Adapter conformance test suite
- Mock transport for testing

**Out of scope:**

- Domain logic (rooms, lobbies, seats, game rules)
- Specific transport implementations (separate packages)
- Specific persistence implementations (separate packages)
- Framework bindings like React hooks (separate packages)
- Event sourcing (consumer can implement via `afterApply` hook + persistence adapter)
- Custom DSL with parser/codegen (TypeScript-native schema first; DSL can layer on top later)

---

## 10. Testing Strategy

### Type-level tests

The builder API and schema split rely heavily on TypeScript's type system to enforce correctness — invalid flag combinations, `apply()` placement, `reject()` codes, etc. These constraints must be tested to prevent regressions. Since the "feature" is that certain code doesn't compile, tests must verify both positive cases (should compile) and negative cases (should not compile).

Two techniques, combined:

**`@ts-expect-error` for negative tests.** A line annotated with `@ts-expect-error` must produce a type error. If it doesn't (e.g., a refactor accidentally made the invalid combination valid), TypeScript itself errors — the test fails in CI.

**Type-level assertion helpers for positive tests.** Utility types that fail at compile time if the inferred type doesn't match expectations.

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

These tests run as part of normal type checking (`tsc` / `tsgo`) — no extra tooling, no test runner dependency. They catch regressions in the type system that runtime tests would miss.

### Runtime tests

Standard Vitest tests for the engine's runtime behavior:

- **Operation pipeline:** submit → validate → compute → apply → state changes correctly
- **ShardStore reconciliation:** optimistic apply → broadcast → pending cleared / discarded
- **Version checking:** stale operations rejected, fresh operations accepted
- **Deduplication:** duplicate operation IDs rejected
- **canRetry:** retry logic with fresh state, attempt counting, max retries
- **Error model:** OperationError produces typed rejections, thrown errors produce INTERNAL_ERROR

All runtime tests use an in-memory transport (direct function calls, no network) and in-memory persistence. No infrastructure needed.

### Adapter conformance tests

Shipped as `kio-test-kit` — consumers run them against their persistence or transport adapters (see Section 7).

---

## 11. DSL Example

### `schema.ts` — shared contract (imported by both client and server)

```ts
import { channel, shard } from "kio/core"
import * as v from "valibot"

// ── State schemas ────────────────────────────────────────────────────────────

const worldState = v.object({
  gameStage: v.picklist(["PLAYING", "PAUSED", "FINISHED"]),
  diceResults: v.record(v.string(), v.object({
    sum: v.number(),
    rolls: v.array(v.object({ max: v.number(), result: v.number() })),
  })),
})

const seatState = v.object({
  inventory: v.array(v.object({ id: v.string(), name: v.string(), quantity: v.number() })),
  visitedLocations: v.set(v.string()),
})

const presenceState = v.object({
  gps: v.optional(v.object({ lat: v.number(), lng: v.number() })),
  status: v.picklist(["ok", "unavailable", "timeout", "unknown"]),
})

// ── Channel definitions (builder pattern) ────────────────────────────────────

export const gameChannel = channel.durable("game")
  .shard("world", worldState)
  .shardPerResource("seat", seatState)

  // Optimistic: apply() is HERE (client needs it for prediction).
  // validate/compute are NOT here — they go in schema.server.ts.
  .operation("visitLocation", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: v.object({ seatId: v.string(), locationSlug: v.string() }),
    errors: v.picklist(["ALREADY_VISITED"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {
      seat(input.seatId).visitedLocations.add(input.locationSlug)
    },
  })

  .operation("useItem", {
    execution: "optimistic",
    versionChecked: true,
    deduplicate: true,
    input: v.object({ seatId: v.string(), itemId: v.string() }),
    errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
    apply({ seat }, input) {
      const inv = seat(input.seatId).inventory
      inv.splice(inv.findIndex(i => i.id === input.itemId), 1)
    },
  })

  // Computed: NO apply() here (type error if you try).
  // apply/validate/compute all go in schema.server.ts.
  .operation("rollDice", {
    execution: "computed",
    versionChecked: true,
    deduplicate: true,
    input: v.object({
      dice: v.array(v.object({ max: v.number() })),
      target: v.string(),
    }),
    errors: v.picklist(["NOT_PLAYING"]),
    serverResult: v.object({ results: v.array(v.number()) }),
    scope: () => [shard.ref("world")],
  })

  // Confirmed: NO apply() here.
  .operation("chooseDialogueOption", {
    execution: "confirmed",
    versionChecked: true,
    deduplicate: true,
    input: v.object({
      seatId: v.string(),
      dialogueId: v.string(),
      optionIndex: v.number(),
    }),
    errors: v.picklist(["DIALOGUE_NOT_ACTIVE", "INVALID_OPTION"]),
    scope: (input) => [shard.ref("seat", input.seatId)],
  })

  // Confirmed + cross-shard.
  .operation("transferItem", {
    execution: "confirmed",
    versionChecked: true,
    deduplicate: true,
    input: v.object({
      fromSeatId: v.string(),
      toSeatId: v.string(),
      itemId: v.string(),
    }),
    errors: v.picklist(["ITEM_NOT_FOUND", "INVENTORY_FULL"]),
    scope: (input) => [
      shard.ref("seat", input.fromSeatId),
      shard.ref("seat", input.toSeatId),
    ],
  })

export const presenceChannel = channel.ephemeral("presence", { autoBroadcast: false })
  .shardPerResource("player", presenceState)

  .operation("updateLocation", {
    execution: "optimistic",
    versionChecked: false,
    deduplicate: false,
    input: v.object({
      gps: v.object({ lat: v.number(), lng: v.number() }),
      status: v.picklist(["ok", "unavailable", "timeout"]),
    }),
    scope: (_input, ctx) => [shard.ref("player", ctx.actorId)],
    apply({ player }, input, _serverResult, ctx) {
      const me = player(ctx.actorId)
      me.gps = input.gps
      me.status = input.status
    },
  })
```

### `schema.server.ts` — server-only (never imported by client)

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const serverEngine = engine()
  .channel(
    gameChannel
      .serverImpl("visitLocation", {
        validate({ seat }, input, ctx, { reject }) {
          if (seat(input.seatId).visitedLocations.has(input.locationSlug)) {
            return reject("ALREADY_VISITED", "Location already visited")
          }
        },
        // No apply() — type error. Already in shared schema.
      })
      .serverImpl("useItem", {
        validate({ seat }, input, ctx, { reject }) {
          const item = seat(input.seatId).inventory.find(i => i.id === input.itemId)
          if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory")
          if (item.quantity < 1) return reject("INSUFFICIENT_QUANTITY", "No uses left")
        },
      })
      .serverImpl("rollDice", {
        validate({ world }, input, ctx, { reject }) {
          if (world.gameStage !== "PLAYING") return reject("NOT_PLAYING", "Game is not active")
        },
        compute({ world }, input) {
          return {
            results: input.dice.map(d => Math.floor(Math.random() * d.max) + 1),
          }
        },
        apply({ world }, input, serverResult) {  // ✓ required here
          world.diceResults[input.target] = {
            sum: serverResult.results.reduce((a, b) => a + b, 0),
            rolls: input.dice.map((d, i) => ({
              max: d.max,
              result: serverResult.results[i],
            })),
          }
        },
      })
      .serverImpl("chooseDialogueOption", {
        validate({ seat }, input, ctx, { reject }) {
          // return reject("DIALOGUE_NOT_ACTIVE", "...") if dialogue is not active
          // return reject("INVALID_OPTION", "...") if option index out of range
        },
        apply({ seat }, input) {                  // ✓ required here
          // advance dialogue state
        },
      })
      .serverImpl("transferItem", {
        validate({ seat }, input, ctx, { reject }) {
          if (!seat(input.fromSeatId).inventory.some(i => i.id === input.itemId)) {
            return reject("ITEM_NOT_FOUND", "Item not in source inventory")
          }
          // could also: return reject("INVENTORY_FULL", "Target inventory is full")
        },
        apply({ seat }, input) {                  // ✓ required here
          const from = seat(input.fromSeatId)
          const to = seat(input.toSeatId)
          const idx = from.inventory.findIndex(i => i.id === input.itemId)
          const [item] = from.inventory.splice(idx, 1)
          to.inventory.push(item)
        },
      })
  )
  .channel(presenceChannel) // no serverImpl needed — ephemeral, no validate/compute
```

### `schema.client.ts` — client-only (never imported by server)

```ts
import { gameChannel, presenceChannel } from "./schema"
import { engine } from "kio/core"

export const clientEngine = engine()
  .channel(
    gameChannel
      .clientImpl("useItem", {
        canRetry(input, { seat }) {
          return seat(input.seatId).inventory.some(i => i.id === input.itemId)
        },
      })
      .clientImpl("visitLocation", {
        canRetry(input, { seat }) {
          return !seat(input.seatId).visitedLocations.has(input.locationSlug)
        },
      })
      .clientImpl("transferItem", {
        canRetry(input, { seat }) {
          return seat(input.fromSeatId).inventory.some(i => i.id === input.itemId)
        },
      })
      // rollDice, chooseDialogueOption: no clientImpl needed (no canRetry)
  )
  .channel(presenceChannel)
```

### `server.ts`

```ts
import { createServer } from "kio/server"
import { socketIoTransport } from "kio-transport-socketio"
import { prismaAdapter } from "kio-adapter-prisma"
import { serverEngine } from "./schema.server"

const server = createServer(serverEngine, {
  transport: socketIoTransport({ port: 3000 }),
  persistence: prismaAdapter(prisma),

  authenticate(upgradeRequest) {
    const session = await verifySession(upgradeRequest.headers.cookie)
    return {
      actorId: session.playerId,    // required by engine
      displayName: session.alias,   // consumer-defined, available in ctx.actor
    }
  },

  authorize(actor, operationName, shardRefs) {
    // Consumer maps actorId → seat via their own domain logic
    const seatId = seatAssignments.getSeatForPlayer(actor.actorId)
    return shardRefs.every(ref => canSeatAccess(seatId, ref))
  },

  // Default subscriptions for new actors — called once when the subscription
  // shard is first created. On subsequent connects, the engine reads the
  // existing subscription shard.
  defaultSubscriptions(actor) {
    const roomId = roomAssignments.getRoomForPlayer(actor.actorId)
    const seatId = seatAssignments.getSeatForPlayer(actor.actorId, roomId)
    return [
      { channelId: "game", shardId: "world" },
      { channelId: "game", shardId: `seat:${seatId}` },
      { channelId: "presence", shardId: `player:${actor.actorId}` },
    ]
  },

  onConnect(actor) {
    // setOnline/setOffline/changeGameStage are operations defined in the
    // full schema — omitted from this example for brevity
    server.submit("presence", "setOnline", { playerId: actor.actorId })
  },

  onDisconnect(actor) {
    server.submit("presence", "setOffline", { playerId: actor.actorId })
  },
})

// Server as actor: game timer expires
onGameTimerExpired(roomId, () => {
  server.submit("game", "changeGameStage", { gameStage: "FINISHED" })
})

// Presence uses autoBroadcast: false — flush on a 5-second interval.
// Operations apply immediately (server state is always current),
// but subscribers receive coalesced updates every 5 seconds.
setInterval(() => {
  server.broadcastDirtyShards("presence")
}, 5000)
```

### `client.ts` — framework-agnostic

```ts
import { createClient } from "kio/client"
import { socketIoTransport } from "kio-transport-socketio"
import { clientEngine } from "./schema.client"

const client = createClient(clientEngine, {
  transport: socketIoTransport({ url: "wss://api.example.com/ws" }),
})

// No client-initiated subscribe — the server manages subscriptions via the
// subscription shard. The client receives shards based on its subscription
// shard state, populated by defaultSubscriptions() on first connect and
// modified by server-submitted grant/revoke operations.

// Submit — fully typed from schema
const result = await client.channel("game").submit("useItem", {
  seatId: "seat:3",
  itemId: "potion-1",
})

// Read state — single resolved state, syncStatus indicates availability
const world = client.channel("game").state("world")
const mySeat = client.channel("game").state("seat", "seat:3")
```

### React integration

```tsx
import { useShardState, useSubmit, KioProvider } from "kio-react"

function App() {
  return (
    <KioProvider client={client}>
      <Game seatId="seat:3" />
    </KioProvider>
  )
}

function Game({ seatId }: { seatId: string }) {
  const worldShard = useShardState("game", "world")
  const seatShard = useShardState("game", "seat", seatId)
  const submit = useSubmit("game")

  // Discriminated union: check syncStatus, TypeScript narrows state
  if (worldShard.syncStatus === "loading" || seatShard.syncStatus === "loading") {
    return <LoadingScreen />
  }

  // After narrowing, destructure for clean access
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

### Location sharing via subscription shard

This example shows how the subscription shard enables location sharing without point-to-point messaging. The server controls who can see whose presence. The client reacts to subscription shard changes to render shared locations.

**Server-side** — consumer's game logic triggers subscription changes:

```ts
// When alice shares her location with bob, the consumer's domain logic
// grants bob access to alice's presence shard.
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

// In the server setup, after applying the share:
server.hooks.afterApply("game", "startShare", (operation, oldStates, newStates, ctx) => {
  // Grant bob access to alice's presence shard
  server.submit("subscriptions", "grant", {
    actorId: operation.input.targetPlayerId,
    ref: { channelId: "presence", shardId: `player:${ctx.actor.actorId}` },
  })
})

server.hooks.afterApply("game", "stopShare", (operation, oldStates, newStates, ctx) => {
  // Revoke bob's access to alice's presence shard
  server.submit("subscriptions", "revoke", {
    actorId: operation.input.targetPlayerId,
    ref: { channelId: "presence", shardId: `player:${ctx.actor.actorId}` },
  })
})
```

**Client-side** — consumer watches the subscription shard to discover shared players:

```tsx
function LocationSharingPanel({ myActorId }: { myActorId: string }) {
  // Watch own subscription shard to discover access changes
  const subscriptions = useShardState("subscriptions", "subscription", myActorId)
  if (subscriptions.syncStatus !== "latest") return null

  // Derive which other players' presence we have access to
  const sharedPlayerShardIds = subscriptions.state.refs
    .filter(r => r.channelId === "presence" && r.shardId !== `player:${myActorId}`)
    .map(r => r.shardId)

  return sharedPlayerShardIds.map(shardId => (
    <SharedPlayerLocation key={shardId} shardId={shardId} />
  ))
}

function SharedPlayerLocation({ shardId }: { shardId: string }) {
  // Declare interest in this shard — syncStatus reflects access state
  const presence = useShardState("presence", "player", shardId)

  if (presence.syncStatus === "unavailable") return null   // access not yet active
  if (presence.syncStatus === "loading") return <Loading />
  return <PlayerMarker gps={presence.state.gps} />
}
```

The flow:
1. Alice submits `startShare` → server applies, then grants bob access via `subscriptions/grant`
2. Bob's subscription shard updates → his `LocationSharingPanel` re-renders, showing alice's shard ID
3. `SharedPlayerLocation` mounts with alice's shard ID → ShardStore transitions from `"unavailable"` to `"loading"` to `"latest"` as the server delivers alice's presence state
4. Alice's GPS updates arrive via normal presence broadcasts
5. When alice stops sharing → server revokes → subscription shard updates → component unmounts → ShardStore returns to `"unavailable"`

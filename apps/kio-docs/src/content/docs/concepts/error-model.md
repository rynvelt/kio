---
title: Error Model
description: Three-tier error system — unexpected, expected, and consumer-defined
sidebar:
  order: 8
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

When an operation fails, you need to know whether it was a bug, a known engine rejection, or a domain-specific problem your code anticipated. Mixing these together makes error handling fragile — you end up catching broad exception types and guessing at the cause.

Kio separates errors into three tiers, each with different type safety guarantees and different handling expectations. The tiers are strictly layered: tier 1 is never exposed in detail to clients, tier 2 is a fixed set the engine defines, and tier 3 is a per-operation set the consumer defines. Together they form an exhaustive, type-safe union on the client.

## Tier 1: Unexpected engine errors (bugs)

Something went wrong internally — a null pointer, a persistence adapter throwing an unexpected exception. The consumer did not cause this and cannot handle it meaningfully.

- The server logs the full error with stack trace for debugging.
- The client receives a generic error: `{ code: "INTERNAL_ERROR", message: "An unexpected error occurred" }`. Internal details are never leaked.
- Returned as `status: "rejected"`.

This tier exists to draw a hard line between "something the consumer should handle" and "something the engine team needs to fix." Consumers should not try to pattern-match on `INTERNAL_ERROR` beyond logging or showing a generic failure message.

## Tier 2: Expected engine errors

The engine rejects the operation for a known, predictable reason. These codes are a fixed set exported by Kio — they do not change per operation or per channel.

| Code | Meaning |
|---|---|
| `VERSION_CONFLICT` | Shard version mismatch. Includes fresh state. `canRetry` decides. |
| `UNAUTHORIZED` | `authorize()` returned false. |
| `DUPLICATE_OPERATION` | Operation ID already seen (dedup). |
| `SHARD_NOT_FOUND` | Referenced shard doesn't exist. |
| `INVALID_INPUT` | StandardSchema validation failed on the input. |
| `INTERNAL_ERROR` | Unexpected engine error (tier 1, surfaced generically). |

One additional code is client-only. It is returned as `status: "blocked"` with no server round-trip:

| Code | Meaning |
|---|---|
| `PENDING_OPERATION` | Another operation on the same shard hasn't resolved yet. |

Because these codes are fixed, you can check for them directly:

```ts
if (result.status === "rejected" && result.error.code === "VERSION_CONFLICT") { ... }
```

## Tier 3: Consumer-defined errors (type-safe, per operation)

Domain logic often needs its own rejection reasons. "Item not found" or "insufficient quantity" are not engine concerns — they are game logic. Kio lets you declare these per operation in the shared schema, and the type system carries them through to the client.

### Declaring errors in the schema

Error codes are declared alongside the operation's input:

```ts
// schema.ts (shared)
.operation("useItem", {
  execution: "optimistic",
  versionChecked: true,
  deduplicate: true,
  input: v.object({ seatId: v.string(), itemId: v.string() }),
  errors: v.picklist(["ITEM_NOT_FOUND", "INSUFFICIENT_QUANTITY"]),
})
```

### Producing errors on the server

Server-side handlers receive a `reject()` callback. This is the only way to produce a typed consumer error:

```ts
// schema.server.ts
.serverImpl("useItem", {
  validate({ seat }, input, ctx, { reject }) {
    const item = seat(input.seatId).inventory.find(i => i.id === input.itemId)
    if (!item) return reject("ITEM_NOT_FOUND", "Item not in inventory")
    if (item.quantity < 1) return reject("INSUFFICIENT_QUANTITY", "No uses left")
  },
})
```

The contract is strict:

- **Call `reject()`** — a typed error reaches the client (tier 3). `reject()` returns `never`, so the handler stops.
- **Throw or let an error escape** — the engine catches it, logs it, and sends `INTERNAL_ERROR` (tier 1). Internal details stay on the server.
- **Return normally** — validation passed and the operation proceeds.

This design means you never accidentally leak internal details by throwing a domain error. If you want the client to see a specific code, you must explicitly call `reject()`.

### Deep validation logic

For complex validation that might throw its own exceptions, catch and translate them into `reject()` calls:

```ts
// schema.server.ts
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

Unknown exceptions intentionally fall through. The engine catches them, logs the full stack trace on the server, and sends the generic `INTERNAL_ERROR` to the client.

### Handling errors on the client

On the client, the error code is a typed union of the operation's declared codes plus the engine's built-in codes. TypeScript enforces exhaustive handling:

```ts
const result = await client.channel("game").submit("useItem", { seatId, itemId })
if (result.status === "rejected") {
  switch (result.error.code) {
    case "ITEM_NOT_FOUND":          // consumer-defined
    case "INSUFFICIENT_QUANTITY":    // consumer-defined
    case "VERSION_CONFLICT":         // engine-defined
    case "UNAUTHORIZED":             // engine-defined
    // ... exhaustive switch, TypeScript enforces all cases
  }
}
```

Because both tier 2 and tier 3 codes appear in the same union, a single `switch` covers every possible rejection reason. If you add a new error code to the schema, TypeScript will flag every `switch` that does not handle it.

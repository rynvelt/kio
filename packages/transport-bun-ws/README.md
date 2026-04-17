# @kiojs/transport-bun-ws

Bun-native server WebSocket transport for [Kio](https://github.com/rynvelt/kio). Produces a `ServerTransport` plus the Bun `websocket` handler object and an `upgrade` helper you plug into your own `Bun.serve`.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `createBunWsTransport()` — returns `{ transport, websocket, upgrade }`.
- `KioWsData` — the per-connection data attached to each socket (`connectionId` + the authenticated `actor`).

## Usage

```ts
import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createBunWsTransport } from "@kiojs/transport-bun-ws";
import { appEngine } from "./schema";

const { transport, websocket, upgrade } = createBunWsTransport();

const server = createServer(appEngine, {
  persistence: new MemoryStateAdapter(),
  transport,
});

Bun.serve({
  port: 4000,
  fetch(req, srv) {
    // Consumer owns authentication: derive an actor value from the request.
    const actor = { actorId: `user:${crypto.randomUUID()}` };
    if (upgrade(req, srv, actor)) return;
    return new Response("Kio server");
  },
  websocket,
});
```

The transport moves raw bytes. The server engine owns the codec — incoming binary frames arrive as `Uint8Array`, text frames as `string`. `upgrade` returns `true` when the request was a valid WebSocket upgrade (short-circuit the HTTP response); pass whatever shape your engine's actor schema expects.

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) for the full picture and `@kiojs/transport-ws` for the matching client-side transport.

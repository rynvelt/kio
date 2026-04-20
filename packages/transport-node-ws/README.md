# @kiojs/transport-node-ws

Node.js server WebSocket transport for [Kio](https://github.com/rynvelt/kio), built on the [`ws`](https://github.com/websockets/ws) library in `noServer` mode. Produces a `ServerTransport` plus a `handleUpgrade` helper you plug into your own `http.Server`'s `upgrade` event.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `createNodeWsTransport()` — returns `{ transport, handleUpgrade, close }`.

## Usage

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer, MemoryStateAdapter } from "@kiojs/server";
import { createNodeWsTransport } from "@kiojs/transport-node-ws";
import { appEngine } from "./schema";

const { transport, handleUpgrade } = createNodeWsTransport();

const server = createServer(appEngine, {
  persistence: new MemoryStateAdapter(),
  transport,
});

const app = new Hono();
app.get("/", (c) => c.text("Kio server"));

const httpServer = serve({ fetch: app.fetch, port: 4000 });

httpServer.on("upgrade", (req, socket, head) => {
  // Consumer owns authentication: derive an actor value from the request.
  const actor = { actorId: `user:${crypto.randomUUID()}` };
  handleUpgrade(req, socket, head, actor);
});
```

The transport moves raw bytes. The server engine owns the codec — incoming binary frames arrive as `Uint8Array`, text frames as `string`. Pass whatever actor shape your engine's actor schema expects.

Because the transport runs in `ws`'s `noServer` mode, the consumer's `upgrade` listener is the natural place to authenticate. Reject early with `socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy();` before calling `handleUpgrade`.

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) for the full picture and `@kiojs/transport-ws` for the matching client-side transport.

# @kiojs/transport-ws

Generic WebSocket client transport for [Kio](https://github.com/rynvelt/kio). Wraps a browser-style `WebSocket` and handles the reconnect lifecycle — on disconnect, it calls the provided `connect()` factory again after a configurable delay.

> **Early stage.** APIs may shift before `1.0`.

## What it exports

- `createWsTransport(options)` — returns a `ClientTransport` for `createClient`.
- `WsTransportOptions`:
  - `connect: () => WebSocket` — factory that creates a new socket (browser `WebSocket`, or a compatible shim such as `ws` on Node).
  - `reconnectDelayMs?: number` — delay before reconnect. Default `1000`.

## Usage

```ts
import { createClient } from "@kiojs/client";
import { createWsTransport } from "@kiojs/transport-ws";
import { appEngine } from "./schema";

const transport = createWsTransport({
  connect: () =>
    new WebSocket(`ws://localhost:4000?actorId=${encodeURIComponent(id)}`),
});

const client = createClient(appEngine, { transport });
```

The transport moves raw bytes. The client engine owns the codec — binary frames arrive as `Uint8Array`, text frames as `string`. Your `connect()` factory is the seam for auth: encode the actor id, a session token, or whatever credential scheme your server expects, in the URL or sub-protocol.

## Docs

See the top-level [Kio README](https://github.com/rynvelt/kio#readme) for the full picture and `@kiojs/transport-bun-ws` for the matching server-side transport.

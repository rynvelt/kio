# hono-node-counter

Minimal demo of Kio running on **Node.js** with a **Hono** HTTP stack sharing one `http.Server` with the Kio WebSocket upgrade.

## Run

```sh
bun install            # from the repo root
cd examples/hono-node-counter
bun run dev
```

The server listens on `http://localhost:4000`:

- `GET /` — plain text (Hono route)
- `GET /health` — JSON health check (Hono route)
- `WS /` — WebSocket upgrade handled by `@kiojs/transport-node-ws`

Any Kio client (e.g. the browser frontend in `examples/counter`) can point at `ws://localhost:4000` and interact with the `counter` and `presence` channels — this example only replaces the server-side runtime.

## What it demonstrates

- `@hono/node-server`'s `serve()` returns a standard `http.Server`-compatible instance you can attach an `upgrade` listener to.
- `createNodeWsTransport()` runs `ws` in `noServer` mode — the consumer owns auth in the upgrade listener, then hands the handshake to Kio via `handleUpgrade`.
- Kio's `createServer` doesn't care about the runtime; the same API shape as the Bun transport demo.

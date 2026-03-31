---
title: Transport Interface
description: ServerTransport and ClientTransport — pluggable wire adapters
sidebar:
  order: 2
---

:::note[Status: Design Only]
This page describes the target design. Implementation has not started.
:::

The transport's job is narrow: move bytes between connections. It doesn't know about shards, operations, or state. The engine serializes messages via the Codec, the transport delivers them.

## Server-side interface

The server transport manages multiple connections. It accepts a handler object that the engine provides, and calls back into it when connections arrive, depart, or send data.

```ts
interface ServerTransport {
  listen(handler: ServerTransportHandler): void
  send(connectionId: string, data: Uint8Array): void
  sendMany(connectionIds: string[], data: Uint8Array): void
  disconnect(connectionId: string): void
  shutdown(): Promise<void>
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
  extra: Record<string, unknown>
}
```

`listen()` starts accepting connections. The engine passes itself (as a `ServerTransportHandler`) so the transport can report events. `send()` delivers bytes to a single connection. `sendMany()` delivers the same bytes to many connections — useful for broadcasts where every subscriber gets identical data. `disconnect()` forcibly drops a connection. `shutdown()` tears down the transport and resolves when cleanup is complete.

The `IncomingConnection` object normalizes framework-specific connection details. `headers` and `query` carry the HTTP upgrade request's headers and query parameters. `extra` is an escape hatch for transport-specific metadata (Socket.IO's `auth` object, for example).

## Client-side interface

The client transport manages a single connection. Instead of a handler object, it uses individual callback registration — this keeps the consumer-facing API simple.

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

`connect()` initiates the connection to the given URL. `send()` pushes bytes to the server. `disconnect()` tears down the connection from the client side. The three `on*` methods register callbacks that the client engine uses to track connection state and receive data.

## Raw bytes everywhere

Both interfaces deal in `Uint8Array` — raw bytes. The engine's Codec handles serialization and deserialization on top. This separation means the transport never needs to understand message structure. A transport adapter that works today will keep working even if the message protocol changes, because it never inspects the payload.

## Adapter implementations

Two transport adapters are planned:

**Socket.IO adapter** wraps socket.io's server and client. It provides reconnection, heartbeats, and connection state recovery out of the box. Liveness detection comes from socket.io's built-in ping/pong mechanism. This is the easiest adapter to start with — socket.io handles the hard parts of connection management automatically.

**WebSocket adapter** wraps native WebSocket (or Bun's `Bun.serve` websocket). It's leaner and has fewer dependencies, but it must implement its own ping/pong loop and timeout logic to meet the liveness contract. Choose this adapter when you want minimal overhead or when you're running on a platform where socket.io isn't a good fit.

Both adapters export a server half and a client half. You install one transport package and use both sides.

## Liveness contract

The engine relies on the transport to detect dead connections. The `livenessTimeoutMs` property on `ServerTransport` declares how quickly the transport will fire `onDisconnection` after a client becomes unresponsive. The engine reads this value to understand the transport's detection guarantees — it never runs its own liveness checks at the transport level.

How each adapter meets this contract:

| Adapter | Liveness mechanism | Typical timeout |
|---|---|---|
| Socket.IO | Built-in ping/pong | Configurable (default ~20s) |
| WebSocket | Custom ping/pong loop | Configurable |

## Edge case: backgrounded mobile clients

TCP connections can survive app backgrounding — the OS handles keepalives even when the app isn't running. The transport sees the connection as alive, but the client isn't actually processing anything.

For this scenario, the consumer can add **application-level heartbeats** on top of the transport's liveness detection. The pattern: define a heartbeat operation on the presence channel, have the client submit it every N seconds, and run a server-side sweep that marks actors as inactive when their last heartbeat is too old. This is a consumer concern, not a transport concern — the transport's job ends at "the TCP connection is still open."

import type { ClientTransport } from "@kiojs/shared";

export interface WsTransportOptions {
	/** Factory that creates a new WebSocket connection */
	readonly connect: () => WebSocket;
	/** Delay in ms before reconnecting after a disconnect. Default: 1000 */
	readonly reconnectDelayMs?: number;
}

/**
 * Browser WebSocket client transport for Kio.
 *
 * The consumer provides a connect() factory that creates WebSocket instances.
 * The transport handles the reconnect lifecycle — on disconnect, it calls
 * connect() again after the configured delay.
 *
 * The transport moves raw bytes; the client engine owns the codec. Binary
 * frames are delivered as Uint8Array; text frames are delivered as string.
 *
 * Usage:
 * ```ts
 * const transport = createWsTransport({
 *   connect: () => new WebSocket("ws://localhost:4000"),
 * });
 * const client = createClient(engine, { transport });
 * ```
 */
export function createWsTransport(
	options: WsTransportOptions,
): ClientTransport {
	const reconnectDelay = options.reconnectDelayMs ?? 1000;

	let messageHandler: ((data: string | Uint8Array) => void) | null = null;
	let connectedHandler: (() => void) | null = null;
	let disconnectedHandler: ((reason: string) => void) | null = null;
	let ws: WebSocket | null = null;

	function connect() {
		ws = options.connect();
		ws.binaryType = "arraybuffer";

		ws.onopen = () => {
			connectedHandler?.();
		};

		ws.onmessage = (event) => {
			const data: string | Uint8Array =
				typeof event.data === "string"
					? event.data
					: new Uint8Array(event.data as ArrayBuffer);
			messageHandler?.(data);
		};

		ws.onclose = (event) => {
			disconnectedHandler?.(event.reason || "connection closed");
			setTimeout(connect, reconnectDelay);
		};
	}

	connect();

	return {
		send(data) {
			if (!ws) return;
			if (typeof data === "string") {
				ws.send(data);
			} else {
				// Uint8Array<ArrayBufferLike> is runtime-compatible with WebSocket's
				// BufferSource parameter; the ArrayBufferLike vs ArrayBuffer mismatch
				// is purely a TS generic quirk.
				ws.send(data as unknown as BufferSource);
			}
		},
		onMessage(handler) {
			messageHandler = handler;
		},
		onConnected(handler) {
			connectedHandler = handler;
		},
		onDisconnected(handler) {
			disconnectedHandler = handler;
		},
	};
}

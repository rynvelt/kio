import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
} from "@kio/shared";

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

	let messageHandler: ((message: ServerMessage) => void) | null = null;
	let connectedHandler: (() => void) | null = null;
	let disconnectedHandler: ((reason: string) => void) | null = null;
	let ws: WebSocket | null = null;

	function connect() {
		ws = options.connect();

		ws.onopen = () => {
			connectedHandler?.();
		};

		ws.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			messageHandler?.(message);
		};

		ws.onclose = (event) => {
			disconnectedHandler?.(event.reason || "connection closed");
			setTimeout(connect, reconnectDelay);
		};
	}

	connect();

	return {
		send(message: ClientMessage) {
			ws?.send(JSON.stringify(message));
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

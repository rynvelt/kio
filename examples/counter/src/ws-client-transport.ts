import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
} from "@kio/shared";

/**
 * Browser WebSocket client transport for Kio with auto-reconnect.
 * Inline implementation — not yet a package.
 */
export function createWsClientTransport(
	url: string,
	reconnectDelayMs = 1000,
): ClientTransport {
	let messageHandler: ((message: ServerMessage) => void) | null = null;
	let connectedHandler: (() => void) | null = null;
	let disconnectedHandler: ((reason: string) => void) | null = null;
	let ws: WebSocket | null = null;

	function connect() {
		ws = new WebSocket(url);

		ws.onopen = () => {
			connectedHandler?.();
		};

		ws.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			messageHandler?.(message);
		};

		ws.onclose = (event) => {
			disconnectedHandler?.(event.reason || "connection closed");
			// Auto-reconnect after delay
			setTimeout(connect, reconnectDelayMs);
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

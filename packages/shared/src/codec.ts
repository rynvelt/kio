/**
 * Serialization boundary between the engine and the transport.
 *
 * Real transports (WebSocket, HTTP, Hono, etc.) only move bytes; the engine
 * calls `codec.encode` before handing a message to the transport and
 * `codec.decode` on anything the transport delivers.
 *
 * The default `jsonCodec` is a JSON codec extended to round-trip `Set` and
 * `Map` (which `JSON.stringify` silently flattens to `{}`). Consumers can
 * swap in msgpack, protobuf, or a custom codec.
 */
export interface Codec {
	encode(message: unknown): string | Uint8Array;
	decode(data: string | Uint8Array): unknown;
}

const SET_TAG = "__set";
const MAP_TAG = "__map";

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Set) {
		return { [SET_TAG]: [...value] };
	}
	if (value instanceof Map) {
		return { [MAP_TAG]: [...value] };
	}
	return value;
}

function reviver(_key: string, value: unknown): unknown {
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (Array.isArray(obj[SET_TAG])) {
			return new Set(obj[SET_TAG] as unknown[]);
		}
		if (Array.isArray(obj[MAP_TAG])) {
			return new Map(obj[MAP_TAG] as [unknown, unknown][]);
		}
	}
	return value;
}

function toText(data: string | Uint8Array): string {
	if (typeof data === "string") return data;
	return new TextDecoder().decode(data);
}

/**
 * Default codec: JSON with Set/Map support.
 *
 * Round-trips:
 * - primitives, plain objects, arrays (standard JSON)
 * - Set (tagged as `{ __set: [...] }`)
 * - Map (tagged as `{ __map: [[k, v], ...] }`)
 *
 * Caveat: a plain object whose literal key is `__set` or `__map` with an array
 * value will be misinterpreted as a Set/Map by the decoder. Collisions are
 * unlikely in practice but worth knowing about.
 */
export const jsonCodec: Codec = {
	encode(message) {
		return JSON.stringify(message, replacer);
	},
	decode(data) {
		return JSON.parse(toText(data), reviver);
	},
};

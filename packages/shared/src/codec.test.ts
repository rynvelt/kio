import { describe, expect, test } from "bun:test";
import { jsonCodec } from "./codec";

function roundtrip(value: unknown): unknown {
	const encoded = jsonCodec.encode(value);
	return jsonCodec.decode(encoded);
}

describe("jsonCodec", () => {
	test("primitives round-trip", () => {
		expect(roundtrip("hello")).toBe("hello");
		expect(roundtrip(42)).toBe(42);
		expect(roundtrip(true)).toBe(true);
		expect(roundtrip(false)).toBe(false);
		expect(roundtrip(null)).toBe(null);
	});

	test("plain objects round-trip", () => {
		const value = { a: 1, b: "two", c: [1, 2, 3] };
		expect(roundtrip(value)).toEqual(value);
	});

	test("arrays round-trip", () => {
		expect(roundtrip([1, 2, 3])).toEqual([1, 2, 3]);
		expect(roundtrip([{ a: 1 }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("Set round-trips as Set", () => {
		const original = new Set(["a", "b", "c"]);
		const decoded = roundtrip(original);
		expect(decoded).toBeInstanceOf(Set);
		expect([...(decoded as Set<string>)]).toEqual(["a", "b", "c"]);
	});

	test("Map round-trips as Map", () => {
		const original = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);
		const decoded = roundtrip(original);
		expect(decoded).toBeInstanceOf(Map);
		const m = decoded as Map<string, number>;
		expect(m.get("a")).toBe(1);
		expect(m.get("b")).toBe(2);
	});

	test("empty Set round-trips", () => {
		const decoded = roundtrip(new Set());
		expect(decoded).toBeInstanceOf(Set);
		expect((decoded as Set<unknown>).size).toBe(0);
	});

	test("empty Map round-trips", () => {
		const decoded = roundtrip(new Map());
		expect(decoded).toBeInstanceOf(Map);
		expect((decoded as Map<unknown, unknown>).size).toBe(0);
	});

	test("Set inside an object round-trips", () => {
		const original = { name: "alice", tags: new Set(["admin", "dev"]) };
		const decoded = roundtrip(original) as {
			name: string;
			tags: Set<string>;
		};
		expect(decoded.name).toBe("alice");
		expect(decoded.tags).toBeInstanceOf(Set);
		expect([...decoded.tags]).toEqual(["admin", "dev"]);
	});

	test("Map with object values round-trips", () => {
		const original = new Map<string, { x: number }>([
			["p1", { x: 10 }],
			["p2", { x: 20 }],
		]);
		const decoded = roundtrip(original) as Map<string, { x: number }>;
		expect(decoded).toBeInstanceOf(Map);
		expect(decoded.get("p1")).toEqual({ x: 10 });
		expect(decoded.get("p2")).toEqual({ x: 20 });
	});

	test("Set of Sets round-trips", () => {
		const inner1 = new Set(["a"]);
		const inner2 = new Set(["b", "c"]);
		const outer = new Set([inner1, inner2]);
		const decoded = roundtrip(outer) as Set<Set<string>>;
		expect(decoded).toBeInstanceOf(Set);
		const arr = [...decoded];
		expect(arr).toHaveLength(2);
		expect(arr[0]).toBeInstanceOf(Set);
		expect(arr[1]).toBeInstanceOf(Set);
		const flattened = arr.flatMap((s) => [...s]).sort();
		expect(flattened).toEqual(["a", "b", "c"]);
	});

	test("Map with Set values round-trips", () => {
		const original = new Map<string, Set<number>>([
			["odds", new Set([1, 3, 5])],
			["evens", new Set([2, 4])],
		]);
		const decoded = roundtrip(original) as Map<string, Set<number>>;
		expect(decoded).toBeInstanceOf(Map);
		expect(decoded.get("odds")).toBeInstanceOf(Set);
		expect([...(decoded.get("odds") as Set<number>)]).toEqual([1, 3, 5]);
		expect([...(decoded.get("evens") as Set<number>)]).toEqual([2, 4]);
	});

	test("Set inside a broadcast-patch-shaped object round-trips", () => {
		// Mirrors the Immer patch shape — { op, path, value } where value may be a Set.
		const patch = {
			op: "replace",
			path: ["tags"],
			value: new Set(["admin", "ops"]),
		};
		const decoded = roundtrip(patch) as typeof patch;
		expect(decoded.op).toBe("replace");
		expect(decoded.path).toEqual(["tags"]);
		expect(decoded.value).toBeInstanceOf(Set);
		expect([...decoded.value]).toEqual(["admin", "ops"]);
	});

	test("encoding twice then decoding is idempotent (no double-wrapping)", () => {
		const original = new Set(["a"]);
		const first = jsonCodec.decode(jsonCodec.encode(original));
		const second = jsonCodec.decode(jsonCodec.encode(first));
		expect(second).toBeInstanceOf(Set);
		expect([...(second as Set<string>)]).toEqual(["a"]);
	});

	test("decode accepts Uint8Array input", () => {
		const encoded = jsonCodec.encode({ hello: "world" });
		expect(typeof encoded).toBe("string");

		// Simulate binary-frame delivery
		const bytes = new TextEncoder().encode(encoded as string);
		expect(jsonCodec.decode(bytes)).toEqual({ hello: "world" });
	});

	test("tag collision caveat: plain { __set: [...] } is misinterpreted", () => {
		// Documented limitation — collision with the tag sentinel.
		const decoded = roundtrip({ __set: ["a", "b"] });
		expect(decoded).toBeInstanceOf(Set);
		expect([...(decoded as Set<string>)]).toEqual(["a", "b"]);
	});
});

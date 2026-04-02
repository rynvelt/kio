import { expect } from "bun:test";

export function expectToBeDefined<T>(
	value: T | undefined | null,
): asserts value is T {
	expect(value).toBeDefined();
	expect(value).not.toBeNull();
}

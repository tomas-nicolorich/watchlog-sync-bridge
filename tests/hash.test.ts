import { describe, expect, it } from "vitest";
import { canonical, fnv1a } from "../src/hash";

describe("canonical", () => {
	it("sorts object keys recursively, independent of insertion order", () => {
		const a = { b: 1, a: 2, nested: { z: 1, y: 2 } };
		const b = { a: 2, nested: { y: 2, z: 1 }, b: 1 };
		expect(canonical(a)).toBe(canonical(b));
	});

	it("produces different output for different values at the same keys", () => {
		const a = { id: "1", rating: 7 };
		const b = { id: "1", rating: 9 };
		expect(canonical(a)).not.toBe(canonical(b));
	});

	it("is stable across repeated calls on the same input", () => {
		const value = { x: [1, 2, { k: "v" }], y: null };
		expect(canonical(value)).toBe(canonical(value));
	});

	it("sorts keys inside array elements too", () => {
		const a = { list: [{ b: 1, a: 2 }] };
		const b = { list: [{ a: 2, b: 1 }] };
		expect(canonical(a)).toBe(canonical(b));
	});

	it("preserves array element order (arrays are not sorted)", () => {
		const a = { list: [1, 2, 3] };
		const b = { list: [3, 2, 1] };
		expect(canonical(a)).not.toBe(canonical(b));
	});
});

describe("fnv1a", () => {
	it("is deterministic for the same input string", () => {
		expect(fnv1a("hello world")).toBe(fnv1a("hello world"));
	});

	it("produces different digests for different inputs", () => {
		expect(fnv1a("hello")).not.toBe(fnv1a("world"));
	});

	it("returns a non-empty hex-like string digest", () => {
		const digest = fnv1a("some content");
		expect(typeof digest).toBe("string");
		expect(digest.length).toBeGreaterThan(0);
		expect(digest).toMatch(/^[0-9a-f]+$/);
	});

	it("handles the empty string without throwing", () => {
		expect(() => fnv1a("")).not.toThrow();
		expect(fnv1a("")).toBe(fnv1a(""));
	});

	it("is sensitive to single-character changes (avalanche-ish, not a strict guarantee)", () => {
		expect(fnv1a("value-a")).not.toBe(fnv1a("value-b"));
	});
});

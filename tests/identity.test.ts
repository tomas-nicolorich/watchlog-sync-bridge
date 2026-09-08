import { describe, expect, it } from "vitest";
import { getOrCreateDeviceId, sanitizeDeviceIdForFilename } from "../src/identity";

describe("getOrCreateDeviceId (spec: Device id persists across restarts)", () => {
	it("returns the existing stored device id unchanged when one is already stored", () => {
		const generate = () => "freshly-generated-id";

		const result = getOrCreateDeviceId("existing-device-id", generate);

		expect(result).toBe("existing-device-id");
	});

	it("generates a new device id via the injected generator only when none is stored yet (first run)", () => {
		let calls = 0;
		const generate = () => {
			calls += 1;
			return "brand-new-id";
		};

		const result = getOrCreateDeviceId(undefined, generate);

		expect(result).toBe("brand-new-id");
		expect(calls).toBe(1);
	});

	it("treats an empty stored string as absent and generates a new id (defensive, not a valid persisted id)", () => {
		const generate = () => "brand-new-id";

		const result = getOrCreateDeviceId("", generate);

		expect(result).toBe("brand-new-id");
	});

	it("does not call the generator at all when a stored id already exists (restart reuses the same id, spec scenario)", () => {
		const generate = () => {
			throw new Error("generator must not be called when a device id is already stored");
		};

		expect(() => getOrCreateDeviceId("stable-id-123", generate)).not.toThrow();
	});
});

describe("sanitizeDeviceIdForFilename (design.md: sanitized to [a-z0-9-]{1,40} before use in a path)", () => {
	it("lowercases a typical crypto.randomUUID() value and leaves it otherwise unchanged", () => {
		const uuid = "3fa2c1d0-9b4e-4a1a-8f9d-1234567890ab";

		const result = sanitizeDeviceIdForFilename(uuid);

		expect(result).toBe(uuid);
		expect(result).toMatch(/^[a-z0-9-]{1,40}$/);
	});

	it("replaces characters outside [a-z0-9-] with a dash and collapses repeats", () => {
		const result = sanitizeDeviceIdForFilename("My Device!! (Pixel 8)");

		expect(result).toMatch(/^[a-z0-9-]{1,40}$/);
		expect(result).toBe("my-device-pixel-8");
	});

	it("trims leading and trailing dashes produced by sanitizing", () => {
		const result = sanitizeDeviceIdForFilename("--Weird--Name--");

		expect(result).toBe("weird-name");
		expect(result.startsWith("-")).toBe(false);
		expect(result.endsWith("-")).toBe(false);
	});

	it("truncates a sanitized value longer than 40 characters", () => {
		const longId = "a".repeat(60);

		const result = sanitizeDeviceIdForFilename(longId);

		expect(result).toHaveLength(40);
		expect(result).toMatch(/^[a-z0-9-]{1,40}$/);
	});

	it("falls back to a fixed non-empty value when sanitizing would otherwise produce an empty string", () => {
		const result = sanitizeDeviceIdForFilename("!!!???***");

		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/^[a-z0-9-]{1,40}$/);
	});
});

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_SYNC_DIR_PATH, normalizeSyncDirPath } from "../src/settings";

describe("normalizeSyncDirPath (spec: User-Configurable Settings — export path)", () => {
	it("returns the default sync dir when given undefined (zero-configuration use)", () => {
		expect(normalizeSyncDirPath(undefined)).toBe(DEFAULT_SYNC_DIR_PATH);
	});

	it("returns the default sync dir when given an empty or whitespace-only string", () => {
		expect(normalizeSyncDirPath("")).toBe(DEFAULT_SYNC_DIR_PATH);
		expect(normalizeSyncDirPath("   ")).toBe(DEFAULT_SYNC_DIR_PATH);
	});

	it("trims surrounding whitespace from a custom path", () => {
		expect(normalizeSyncDirPath("  Movies/Sync  ")).toBe("Movies/Sync");
	});

	it("strips leading and trailing slashes so the path is always vault-relative", () => {
		expect(normalizeSyncDirPath("/Movies/Sync/")).toBe("Movies/Sync");
	});

	it("leaves a well-formed custom path unchanged", () => {
		expect(normalizeSyncDirPath("WatchLog/Sync")).toBe("WatchLog/Sync");
	});

	it("falls back to the default for a path with a dot-prefixed folder (invisible to the Vault index)", () => {
		expect(normalizeSyncDirPath("WatchLog/.sync")).toBe(DEFAULT_SYNC_DIR_PATH);
		expect(normalizeSyncDirPath(".hidden/Sync")).toBe(DEFAULT_SYNC_DIR_PATH);
	});
});

describe("DEFAULT_SETTINGS (spec: Plugin works with default settings)", () => {
	it("defaults pollSeconds and syncDirPath to zero-configuration values", () => {
		expect(DEFAULT_SETTINGS.pollSeconds).toBe(120);
		expect(DEFAULT_SETTINGS.syncDirPath).toBe(DEFAULT_SYNC_DIR_PATH);
	});

	it("defaults autoReloadWatchLog to false (spike confirmed live auto-refresh needs no fallback)", () => {
		expect(DEFAULT_SETTINGS.autoReloadWatchLog).toBe(false);
	});
});

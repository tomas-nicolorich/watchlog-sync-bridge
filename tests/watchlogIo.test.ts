import { describe, expect, it, vi } from "vitest";
import { commitMergedData, recoverPendingWrite } from "../src/watchlogIo";
import { FakeAdapter } from "./fakeAdapter";

const WATCHLOG_PATH = ".obsidian/plugins/watchlog/data.json";
const BRIDGE_DIR = ".obsidian/plugins/watchlog-sync-bridge";
const NOW = 1_700_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

describe("commitMergedData - backup (spec: Backup created before first write)", () => {
	it("creates a backup of the pre-write data.json before writing it for the first time", async () => {
		const original = JSON.stringify({ titles: [{ id: "a", rating: 7 }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: original });

		await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [{ id: "a", rating: 9 }],
			backupTaken: false,
			now: NOW,
			nowIso: NOW_ISO,
		});

		const backupCall = adapter.calls.find((c) => c.op === "write" && c.path.startsWith(`${BRIDGE_DIR}/backups/`));
		expect(backupCall).toBeDefined();
		expect(adapter.files.get(backupCall!.path)).toBe(original);

		const backupIndex = adapter.calls.indexOf(backupCall!);
		const targetWriteIndex = adapter.calls.findIndex((c) => c.op === "write" && c.path === WATCHLOG_PATH);
		expect(backupIndex).toBeLessThan(targetWriteIndex);
	});

	it("does not take a second backup once one was already taken", async () => {
		const original = JSON.stringify({ titles: [{ id: "a", rating: 7 }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: original });

		const result = await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [{ id: "a", rating: 9 }],
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
		});

		const backupCalls = adapter.calls.filter((c) => c.op === "write" && c.path.startsWith(`${BRIDGE_DIR}/backups/`));
		expect(backupCalls).toEqual([]);
		expect(result.backupTaken).toBe(true);
		expect(result.committed).toBe(true);
	});
});

describe("commitMergedData - validation (spec: An invalid merge result is never committed)", () => {
	it("aborts and never writes data.json when a pre-existing id is missing from the merged result", async () => {
		const original = JSON.stringify({ titles: [{ id: "a" }, { id: "b" }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: original });
		const log = vi.fn();

		const result = await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [{ id: "a" }, { id: "c" }], // same count, but "b" silently replaced by "c"
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
			log,
		});

		expect(result.committed).toBe(false);
		expect(adapter.files.get(WATCHLOG_PATH)).toBe(original);
		expect(adapter.calls.filter((c) => c.op === "write" && c.path === WATCHLOG_PATH)).toEqual([]);
		expect(log).toHaveBeenCalled();
	});

	it("aborts when the merged titles array shrinks below the pre-existing count", async () => {
		const original = JSON.stringify({ titles: [{ id: "a" }, { id: "b" }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: original });

		const result = await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [],
			backupTaken: true,
			now: NOW,
		});

		expect(result.committed).toBe(false);
		expect(adapter.files.get(WATCHLOG_PATH)).toBe(original);
	});
});

describe("commitMergedData - bridge-state isolation (spec: lastModified is stored in the bridge's own plugin data, not WatchLog's)", () => {
	it("never writes a bridge-owned lastModified/titleMeta field into WatchLog's data.json", async () => {
		const original = JSON.stringify({ titles: [{ id: "a", rating: 7 }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: original });

		await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [{ id: "a", rating: 9 }],
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
		});

		const written = JSON.parse(adapter.files.get(WATCHLOG_PATH) as string) as {
			titles: Array<Record<string, unknown>>;
			titleMeta?: unknown;
			lastModified?: unknown;
		};

		expect(written.titleMeta).toBeUndefined();
		expect(written.lastModified).toBeUndefined();
		for (const title of written.titles) {
			expect(title.lastModified).toBeUndefined();
			expect(title.titleMeta).toBeUndefined();
		}
	});
});

describe("crash safety (spec: Atomic write survives a mid-write crash)", () => {
	it("recovers data.json to the intended full content after a simulated mid-write crash, never leaving a partial mix", async () => {
		const original = JSON.stringify({ titles: [{ id: "a", rating: 7 }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: original });
		adapter.simulateCrashOnWrite(WATCHLOG_PATH);

		const commitResult = await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [{ id: "a", rating: 9 }],
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
		});

		expect(commitResult.committed).toBe(false);
		expect(commitResult.pendingWrite).toBeDefined();
		// The simulated crash truncated data.json on disk into unparseable JSON.
		expect(() => JSON.parse(adapter.files.get(WATCHLOG_PATH) as string)).toThrow();

		const recovered = await recoverPendingWrite({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			pendingWrite: commitResult.pendingWrite,
		});

		expect(recovered.pendingWrite).toBeUndefined();
		expect(recovered.restoredFrom).toBe("pending");
		const finalContent = JSON.parse(adapter.files.get(WATCHLOG_PATH) as string) as {
			titles: Array<{ id: string; rating: number }>;
		};
		expect(finalContent.titles).toEqual([{ id: "a", rating: 9 }]);
	});

	it("clears the pending marker on load without restoring anything when data.json already parses and matches the pending target", async () => {
		const merged = JSON.stringify({ titles: [{ id: "a", rating: 9 }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: merged });

		const commitResult = await commitMergedData({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			mergedTitles: [{ id: "a", rating: 9 }],
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
		});
		expect(commitResult.committed).toBe(true);
		expect(commitResult.pendingWrite).toBeUndefined();

		// Simulate a stale marker surviving from an earlier, already-successful
		// write (e.g. the process died just after the target write but before
		// the marker itself was cleared).
		const staleMarker = { targetHash: "does-not-matter", startedAt: NOW_ISO };
		const recovered = await recoverPendingWrite({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			pendingWrite: { ...staleMarker, targetHash: "will-not-match" },
		});

		// data.json parses fine but doesn't match the stale target hash: clear
		// the marker and let the next cycle re-merge (design.md step 5).
		expect(recovered.pendingWrite).toBeUndefined();
		expect(recovered.restoredFrom).toBeUndefined();
	});
});

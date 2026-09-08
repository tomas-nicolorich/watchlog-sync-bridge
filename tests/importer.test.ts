import { describe, expect, it, vi } from "vitest";
import { runImportCycle } from "../src/importer";
import type { TitleMeta } from "../src/types";
import { FakeAdapter } from "./fakeAdapter";

const WATCHLOG_PATH = ".obsidian/plugins/watchlog/data.json";
const BRIDGE_DIR = ".obsidian/plugins/watchlog-sync-bridge";
const SYNC_DIR = "WatchLog/.sync";
const NOW = 1_700_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

function peerDoc(
	deviceId: string,
	titles: Record<string, unknown>,
	titleMeta: Record<string, unknown> = {},
): string {
	return JSON.stringify({ schema: 1, deviceId, exportedAt: NOW_ISO, titlesHash: "x", titles, titleMeta });
}

describe("runImportCycle - additions (spec: Title added on device A appears on device B)", () => {
	it("merges a title added on a peer device into local data.json", async () => {
		const local = JSON.stringify({ titles: [{ id: "existing", dateAdded: "2024-01-01" }] });
		const adapter = new FakeAdapter({
			[WATCHLOG_PATH]: local,
			[`${SYNC_DIR}/device-a.json`]: peerDoc("device-a", { newTitle: { id: "newTitle", dateAdded: "2024-02-01" } }),
		});

		const result = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState: {},
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
		});

		expect(result.committed).toBe(true);
		expect(result.addedIds).toEqual(["newTitle"]);
		const written = JSON.parse(adapter.files.get(WATCHLOG_PATH) as string) as { titles: Array<{ id: string }> };
		expect(written.titles.map((t) => t.id).sort()).toEqual(["existing", "newTitle"]);
	});

	it("does not write anything when no peer offers new or changed content", async () => {
		const local = JSON.stringify({ titles: [{ id: "existing", dateAdded: "2024-01-01" }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: local });

		const result = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState: {},
			backupTaken: true,
			now: NOW,
		});

		expect(result.committed).toBe(false);
		expect(adapter.calls.filter((c) => c.op === "write")).toEqual([]);
	});
});

describe("runImportCycle - anti-ping-pong (design.md fixpoint, merge.ts invariants)", () => {
	it("propagates a scalar edit from a peer, then does not bounce it back or re-write on the next cycle", async () => {
		const T0 = 1_000;
		const T1 = 2_000;
		const localTitleState: Record<string, TitleMeta> = { x: { lastModified: T0, scalarHash: "old" } };
		const local = JSON.stringify({ titles: [{ id: "x", rating: 5, dateAdded: "2024-01-01" }] });
		const adapter = new FakeAdapter({
			[WATCHLOG_PATH]: local,
			[`${SYNC_DIR}/device-a.json`]: peerDoc(
				"device-a",
				{ x: { id: "x", rating: 9, dateAdded: "2024-01-01" } },
				{ x: { lastModified: T1, scalarHash: "new" } },
			),
		});

		const first = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState,
			backupTaken: true,
			now: NOW,
			nowIso: NOW_ISO,
		});

		expect(first.committed).toBe(true);
		expect(first.titleState.x?.lastModified).toBe(T1);
		const afterFirst = JSON.parse(adapter.files.get(WATCHLOG_PATH) as string) as {
			titles: Array<{ id: string; rating: number }>;
		};
		expect(afterFirst.titles[0]?.rating).toBe(9);

		const writesToTargetAfterFirst = adapter.calls.filter(
			(c) => c.op === "write" && c.path === WATCHLOG_PATH,
		).length;

		const second = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState: first.titleState,
			backupTaken: true,
			now: NOW + 60_000,
			nowIso: new Date(NOW + 60_000).toISOString(),
		});

		expect(second.committed).toBe(false);
		expect(second.titleState.x?.lastModified).toBe(T1);
		const writesToTargetAfterSecond = adapter.calls.filter(
			(c) => c.op === "write" && c.path === WATCHLOG_PATH,
		).length;
		expect(writesToTargetAfterSecond).toBe(writesToTargetAfterFirst);
	});
});

describe("runImportCycle - malformed peers (spec: Malformed peer export does not crash the plugin)", () => {
	it("skips a peer file with malformed JSON, logs it, and still merges other valid peers", async () => {
		const local = JSON.stringify({ titles: [{ id: "existing" }] });
		const adapter = new FakeAdapter({
			[WATCHLOG_PATH]: local,
			[`${SYNC_DIR}/device-bad.json`]: "{ not valid json",
			[`${SYNC_DIR}/device-good.json`]: peerDoc("device-good", { good: { id: "good" } }),
		});
		const log = vi.fn();

		const result = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState: {},
			backupTaken: true,
			now: NOW,
			log,
		});

		expect(result.committed).toBe(true);
		expect(result.skippedPeers).toContain(`${SYNC_DIR}/device-bad.json`);
		const written = JSON.parse(adapter.files.get(WATCHLOG_PATH) as string) as { titles: Array<{ id: string }> };
		expect(written.titles.map((t) => t.id).sort()).toEqual(["existing", "good"]);
		expect(log).toHaveBeenCalled();
	});

	it("rejects a peer export whose schema version is not 1, without crashing", async () => {
		const local = JSON.stringify({ titles: [{ id: "existing" }] });
		const adapter = new FakeAdapter({
			[WATCHLOG_PATH]: local,
			[`${SYNC_DIR}/device-old.json`]: JSON.stringify({
				schema: 2,
				deviceId: "device-old",
				titles: { x: { id: "x" } },
				titleMeta: {},
			}),
		});

		const result = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState: {},
			backupTaken: true,
			now: NOW,
		});

		expect(result.skippedPeers).toContain(`${SYNC_DIR}/device-old.json`);
		expect(result.committed).toBe(false);
	});

	it("degrades a peer's missing lastModified to baseline 0 rather than letting it win an unearned conflict", async () => {
		const localTitleState: Record<string, TitleMeta> = { x: { lastModified: 500, scalarHash: "s" } };
		const local = JSON.stringify({ titles: [{ id: "x", rating: 1, dateAdded: "2024-01-01" }] });
		const adapter = new FakeAdapter({
			[WATCHLOG_PATH]: local,
			// Peer offers a conflicting scalar but no titleMeta entry at all for "x".
			[`${SYNC_DIR}/device-a.json`]: peerDoc("device-a", { x: { id: "x", rating: 999, dateAdded: "2024-01-01" } }),
		});

		const result = await runImportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			bridgeDir: BRIDGE_DIR,
			syncDir: SYNC_DIR,
			selfDeviceId: "device-b",
			localTitleState,
			backupTaken: true,
			now: NOW,
		});

		// Local lastModified (500) beats the peer's degraded baseline (0), so
		// the peer's rating must NOT win and the local tracked lastModified
		// must NOT be bumped by the peer's unearned attempt. (merge.ts may
		// still normalize a missing `history` field into `history: []` on the
		// winning entry, which can trigger a harmless write — that is a
		// pre-existing merge.ts property, out of this PR's scope, and does
		// not affect data integrity or the LWW outcome asserted here.)
		const finalContent = JSON.parse(adapter.files.get(WATCHLOG_PATH) as string) as {
			titles: Array<{ id: string; rating: number }>;
		};
		expect(finalContent.titles.find((t) => t.id === "x")?.rating).toBe(1);
		expect(result.titleState.x?.lastModified).toBe(500);
	});
});

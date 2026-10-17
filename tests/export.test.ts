import { describe, expect, it } from "vitest";
import { buildExportDoc, type ExportAdapter, runExportCycle } from "../src/export";
import type { TitleEntry, TitleMeta } from "../src/types";

const NOW = 1_700_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const WATCHLOG_PATH = ".obsidian/plugins/watchlog/data.json";
const EXPORT_PATH = "WatchLog/Sync/device-a.json";

type Call = { op: "read" | "write" | "rename" | "exists" | "remove"; path: string; to?: string };

class FakeAdapter implements ExportAdapter {
	files = new Map<string, string>();
	calls: Call[] = [];

	constructor(initialFiles: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initialFiles)) {
			this.files.set(path, content);
		}
	}

	async read(path: string): Promise<string> {
		this.calls.push({ op: "read", path });
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`file not found: ${path}`);
		}
		return content;
	}

	async write(path: string, data: string): Promise<void> {
		this.calls.push({ op: "write", path });
		this.files.set(path, data);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		this.calls.push({ op: "rename", path: oldPath, to: newPath });
		const content = this.files.get(oldPath);
		if (content === undefined) {
			throw new Error(`rename source not found: ${oldPath}`);
		}
		if (this.files.has(newPath)) {
			throw new Error("Destination file already exists!");
		}
		this.files.set(newPath, content);
		this.files.delete(oldPath);
	}

	async exists(path: string): Promise<boolean> {
		this.calls.push({ op: "exists", path });
		return this.files.has(path);
	}

	async remove(path: string): Promise<void> {
		this.calls.push({ op: "remove", path });
		this.files.delete(path);
	}
}

describe("buildExportDoc", () => {
	it("produces an id-keyed snapshot matching the local titles entries (spec: Export reflects current local titles)", () => {
		const titles: TitleEntry[] = [
			{ id: "a", rating: 7, dateAdded: "2024-01-01" },
			{ id: "b", rating: 3, dateAdded: "2024-02-01" },
		];
		const titleState: Record<string, TitleMeta> = {
			a: { lastModified: 0, scalarHash: "h-a" },
			b: { lastModified: 0, scalarHash: "h-b" },
		};

		const doc = buildExportDoc(titles, titleState, "device-a", NOW_ISO);

		expect(doc.titles.a).toEqual(titles[0]);
		expect(doc.titles.b).toEqual(titles[1]);
		expect(doc.titleMeta.a).toEqual(titleState.a);
		expect(doc.titleMeta.b).toEqual(titleState.b);
		expect(doc.schema).toBe(1);
		expect(doc.deviceId).toBe("device-a");
		expect(doc.exportedAt).toBe(NOW_ISO);
	});

	it("routes entries lacking a string id into unkeyed diagnostics, never into the keyed titles map (design.md TitleEntry contract)", () => {
		const titles = [{ rating: 5 } as unknown as TitleEntry, { id: "a", rating: 1 }];

		const doc = buildExportDoc(titles, {}, "device-a", NOW_ISO);

		expect(Object.keys(doc.titles)).toEqual(["a"]);
		expect(doc.unkeyed).toEqual([{ rating: 5 }]);
	});

	it("omits unkeyed and deviceLabel entirely when not applicable", () => {
		const doc = buildExportDoc([{ id: "a" }], {}, "device-a", NOW_ISO);

		expect(doc.unkeyed).toBeUndefined();
		expect(doc.deviceLabel).toBeUndefined();
	});
});

describe("runExportCycle", () => {
	it("never writes to WatchLog's own data.json (spec: Export never mutates WatchLog's data.json)", async () => {
		const originalContent = JSON.stringify({ titles: [{ id: "a", rating: 7 }] });
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: originalContent });

		await runExportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			exportPath: EXPORT_PATH,
			deviceId: "device-a",
			priorTitleState: {},
			now: NOW,
			nowIso: NOW_ISO,
		});

		const nonReadCallsOnWatchLog = adapter.calls.filter((c) => c.path === WATCHLOG_PATH && c.op !== "read");
		expect(nonReadCallsOnWatchLog).toEqual([]);
		expect(adapter.files.get(WATCHLOG_PATH)).toBe(originalContent);
	});

	it("writes an export file whose titles match WatchLog's local titles (spec: Export reflects current local titles)", async () => {
		const localTitles = [{ id: "a", rating: 7, dateAdded: "2024-01-01" }];
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: JSON.stringify({ titles: localTitles }) });

		await runExportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			exportPath: EXPORT_PATH,
			deviceId: "device-a",
			priorTitleState: {},
			now: NOW,
			nowIso: NOW_ISO,
		});

		const written = JSON.parse(adapter.files.get(EXPORT_PATH) as string);
		expect(written.titles.a).toEqual(localTitles[0]);
		expect(written.schema).toBe(1);
	});

	it("writes the export file in place, never via temp file, remove, or rename (yaos syncs those as a delete)", async () => {
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: JSON.stringify({ titles: [] }) });

		await runExportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			exportPath: EXPORT_PATH,
			deviceId: "device-a",
			priorTitleState: {},
			now: NOW,
			nowIso: NOW_ISO,
		});

		const mutations = adapter.calls.filter((c) => c.op !== "read" && c.op !== "exists");
		expect(mutations).toEqual([{ op: "write", path: EXPORT_PATH }]);
	});

	it("overwrites an existing export file on a subsequent cycle", async () => {
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: JSON.stringify({ titles: [{ id: "a", rating: 1 }] }) });

		await runExportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			exportPath: EXPORT_PATH,
			deviceId: "device-a",
			priorTitleState: {},
			now: NOW,
			nowIso: NOW_ISO,
		});

		adapter.files.set(WATCHLOG_PATH, JSON.stringify({ titles: [{ id: "a", rating: 9 }] }));

		await expect(
			runExportCycle({
				adapter,
				watchlogDataPath: WATCHLOG_PATH,
				exportPath: EXPORT_PATH,
				deviceId: "device-a",
				priorTitleState: {},
				now: NOW,
				nowIso: NOW_ISO,
			}),
		).resolves.toBeDefined();

		const written = JSON.parse(adapter.files.get(EXPORT_PATH) as string);
		expect(written.titles.a.rating).toBe(9);
	});

	it("reconciles titleState using the current titles and returns it alongside the doc (design.md exportIfChanged sequence)", async () => {
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: JSON.stringify({ titles: [{ id: "a", rating: 9 }] }) });
		const priorTitleState: Record<string, TitleMeta> = { a: { lastModified: 100, scalarHash: "stale-hash" } };

		const result = await runExportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			exportPath: EXPORT_PATH,
			deviceId: "device-a",
			priorTitleState,
			now: NOW,
			nowIso: NOW_ISO,
		});

		expect(result.titleState.a?.lastModified).toBe(NOW);
		expect(result.doc.titleMeta.a).toEqual(result.titleState.a);
	});

	it("treats a missing or non-array titles field defensively as an empty list rather than throwing", async () => {
		const adapter = new FakeAdapter({ [WATCHLOG_PATH]: JSON.stringify({ someOtherKey: true }) });

		const result = await runExportCycle({
			adapter,
			watchlogDataPath: WATCHLOG_PATH,
			exportPath: EXPORT_PATH,
			deviceId: "device-a",
			priorTitleState: {},
			now: NOW,
			nowIso: NOW_ISO,
		});

		expect(result.doc.titles).toEqual({});
		expect(result.titleState).toEqual({});
	});
});

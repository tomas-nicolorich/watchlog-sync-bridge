/**
 * Builds this device's export snapshot from WatchLog's local `data.json`
 * and writes it atomically to its own vault-visible per-device peer file
 * (design.md module boundaries: `src/export.ts`, "Yes (adapter)").
 *
 * Read-only against WatchLog's `data.json` — spec.md "Export never mutates
 * WatchLog's data.json" is load-bearing here: this module MUST NEVER call
 * `adapter.write()`/`adapter.rename()` against `watchlogDataPath`.
 */
import { canonical, fnv1a } from "./hash";
import { reconcileTitleState } from "./titleState";
import type { ExportDoc, TitleEntry, TitleMeta } from "./types";

/**
 * The minimal adapter surface export.ts depends on — a narrow slice of
 * Obsidian's `DataAdapter`, kept small on purpose so this module (and its
 * tests) never need a full adapter stub.
 */
export interface ExportAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
}

export interface ExportCycleParams {
	adapter: ExportAdapter;
	/** WatchLog's own data file, e.g. ".obsidian/plugins/watchlog/data.json". Read-only. */
	watchlogDataPath: string;
	/** This device's own vault-visible peer file, e.g. "WatchLog/.sync/{deviceId}.json". */
	exportPath: string;
	deviceId: string;
	deviceLabel?: string;
	priorTitleState: Readonly<Record<string, TitleMeta>>;
	/** Epoch ms clock, injectable for deterministic tests. */
	now: number;
	/** ISO-8601 export timestamp; defaults to `new Date(now).toISOString()` when omitted. */
	nowIso?: string;
}

export interface ExportCycleResult {
	doc: ExportDoc;
	titleState: Record<string, TitleMeta>;
}

/**
 * Builds the id-keyed export snapshot for the current local titles list
 * (spec.md "Export reflects current local titles"). Pure — no adapter I/O —
 * so it is independently unit-testable from the write path.
 *
 * Entries are copied verbatim (design.md "unknown-field passthrough");
 * entries lacking a string `id` cannot be merged by id and are routed into
 * `unkeyed` for diagnostics only, never into the keyed `titles` map.
 */
export function buildExportDoc(
	titles: readonly TitleEntry[],
	titleState: Readonly<Record<string, TitleMeta>>,
	deviceId: string,
	exportedAtIso: string,
	deviceLabel?: string,
): ExportDoc {
	const keyedTitles: Record<string, TitleEntry> = {};
	const keyedMeta: Record<string, TitleMeta> = {};
	const unkeyed: TitleEntry[] = [];

	for (const entry of titles) {
		if (typeof entry.id === "string" && entry.id !== "") {
			keyedTitles[entry.id] = entry;
			const state = titleState[entry.id];
			if (state !== undefined) {
				keyedMeta[entry.id] = state;
			}
		} else {
			unkeyed.push(entry);
		}
	}

	return {
		schema: 1,
		deviceId,
		exportedAt: exportedAtIso,
		titlesHash: fnv1a(canonical(keyedTitles)),
		titles: keyedTitles,
		titleMeta: keyedMeta,
		...(deviceLabel !== undefined ? { deviceLabel } : {}),
		...(unkeyed.length > 0 ? { unkeyed } : {}),
	};
}

/**
 * Reads WatchLog's local `data.json` (read-only), reconciles the bridge's
 * `titleState` clock against the current titles, builds this device's
 * export snapshot, and writes it atomically (temp-file-then-rename —
 * spec.md "Export write is atomic") to its own per-device export path.
 */
export async function runExportCycle(params: ExportCycleParams): Promise<ExportCycleResult> {
	const raw = await params.adapter.read(params.watchlogDataPath);
	const titles = parseTitles(raw);

	const titleState = reconcileTitleState(titles, params.priorTitleState, params.now);
	const exportedAtIso = params.nowIso ?? new Date(params.now).toISOString();
	const doc = buildExportDoc(titles, titleState, params.deviceId, exportedAtIso, params.deviceLabel);

	await writeAtomic(params.adapter, params.exportPath, JSON.stringify(doc));

	return { doc, titleState };
}

/**
 * Defensively parses WatchLog's `data.json`: a missing or non-array
 * `titles` field degrades to an empty list rather than throwing (spec.md's
 * documented defensive behavior). Shared with `importer.ts`, which reads the
 * same file to obtain the local side of a merge.
 */
export function parseTitles(raw: string): TitleEntry[] {
	const parsed = JSON.parse(raw) as { titles?: unknown };
	return Array.isArray(parsed.titles) ? (parsed.titles as TitleEntry[]) : [];
}

/**
 * Atomic write: write to a sibling temp path, then rename over the final
 * path, so a concurrent reader (yaos's sync engine) only ever observes the
 * fully-old or fully-new content, never a partial file (spec.md "Export
 * write is atomic"). The temp path is never the final path, so a direct
 * write to `path` never happens.
 */
async function writeAtomic(adapter: ExportAdapter, path: string, content: string): Promise<void> {
	const tempPath = `${path}.tmp`;
	await adapter.write(tempPath, content);
	await adapter.rename(tempPath, path);
}

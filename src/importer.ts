/**
 * Discovers peer per-device export files, drives the pure merge, and commits
 * the result via `watchlogIo.ts` (design.md module boundaries: `src/importer.ts`,
 * "Yes (adapter)"; sequence diagram "importIfChanged").
 *
 * Threat matrix (design.md): peer export JSON arrives over sync and is
 * therefore adversarial input. Every peer file is schema-validated and
 * size-capped; a rejected peer never blocks the cycle or reaches `data.json`.
 * A missing/malformed `lastModified` degrades to baseline `0`, never
 * `Date.now()`, so a corrupt or hostile peer can never win a conflict it did
 * not legitimately win.
 */
import { mergeTitles, type PeerExport } from "./merge";
import { parseTitles } from "./export";
import { commitMergedData, type LogFn, type WatchlogIoAdapter } from "./watchlogIo";
import type { PendingWrite, TitleEntry, TitleMeta } from "./types";

/** 5 MB — generous for a per-device title index, small enough to reject a
 * corrupt or hostile peer file before it is ever parsed. */
const MAX_PEER_FILE_BYTES = 5_000_000;

export interface ImporterAdapter extends WatchlogIoAdapter {
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface ImportCycleParams {
	adapter: ImporterAdapter;
	/** WatchLog's own data file — read for the local side of the merge, and
	 * (on a real change) written via `watchlogIo.commitMergedData`. */
	watchlogDataPath: string;
	/** This plugin's own directory, e.g. ".obsidian/plugins/watchlog-sync-bridge". */
	bridgeDir: string;
	/** Vault-visible directory containing per-device export files. */
	syncDir: string;
	selfDeviceId: string;
	/** Defaults to `${selfDeviceId}.json` — excluded from peer discovery so a
	 * device never merges its own export back into itself. */
	selfExportFileName?: string;
	localTitleState: Readonly<Record<string, TitleMeta>>;
	backupTaken: boolean;
	now: number;
	nowIso?: string;
	log?: LogFn;
}

export interface ImportCycleResult {
	committed: boolean;
	/** The titleState to persist: merge.ts's resolved meta on a real commit,
	 * unchanged `localTitleState` otherwise (no-op or aborted write) — this
	 * is what makes the anti-ping-pong fixpoint hold at the importer level. */
	titleState: Record<string, TitleMeta>;
	addedIds: string[];
	changedIds: string[];
	backupTaken: boolean;
	pendingWrite?: PendingWrite;
	/** Peer file paths rejected during discovery (malformed JSON, wrong
	 * schema, oversized, or otherwise invalid) — logged, never fatal. */
	skippedPeers: string[];
}

const noopLog: LogFn = () => {};

/**
 * One import cycle: read local titles, discover and validate peer exports,
 * merge, and commit via `watchlogIo` only when the merge actually changed or
 * added something (sequence diagram: "no change? -> skip write").
 */
export async function runImportCycle(params: ImportCycleParams): Promise<ImportCycleResult> {
	const log = params.log ?? noopLog;
	const selfExportFileName = params.selfExportFileName ?? `${params.selfDeviceId}.json`;
	const unchanged = (): ImportCycleResult => ({
		committed: false,
		titleState: { ...params.localTitleState },
		addedIds: [],
		changedIds: [],
		backupTaken: params.backupTaken,
		skippedPeers: [],
	});

	let localRaw: string;
	try {
		localRaw = await params.adapter.read(params.watchlogDataPath);
	} catch (err) {
		log("importer: failed to read local data.json, aborting import cycle", err);
		return unchanged();
	}
	const localTitles = parseTitles(localRaw);

	let listing: { files: string[]; folders: string[] };
	try {
		listing = await params.adapter.list(params.syncDir);
	} catch (err) {
		log("importer: failed to list the peer sync directory, treating as no peers", err);
		listing = { files: [], folders: [] };
	}

	const peers: PeerExport[] = [];
	const skippedPeers: string[] = [];

	for (const file of listing.files) {
		if (!file.endsWith(".json") || isSelfExport(file, selfExportFileName)) {
			continue;
		}

		let raw: string;
		try {
			raw = await params.adapter.read(file);
		} catch (err) {
			log(`importer: failed to read peer file ${file}, skipping`, err);
			skippedPeers.push(file);
			continue;
		}

		const validated = validatePeerDoc(raw);
		if (validated === undefined) {
			log(`importer: peer file ${file} failed schema validation, skipping`);
			skippedPeers.push(file);
			continue;
		}
		peers.push(validated);
	}

	const mergeResult = mergeTitles(localTitles, params.localTitleState, peers, params.selfDeviceId);

	if (mergeResult.addedIds.length === 0 && mergeResult.changedIds.length === 0) {
		return { ...unchanged(), skippedPeers };
	}

	const commitResult = await commitMergedData({
		adapter: params.adapter,
		watchlogDataPath: params.watchlogDataPath,
		bridgeDir: params.bridgeDir,
		mergedTitles: mergeResult.titles,
		backupTaken: params.backupTaken,
		now: params.now,
		nowIso: params.nowIso,
		log: params.log,
	});

	return {
		committed: commitResult.committed,
		titleState: commitResult.committed ? mergeResult.meta : { ...params.localTitleState },
		addedIds: commitResult.committed ? mergeResult.addedIds : [],
		changedIds: commitResult.committed ? mergeResult.changedIds : [],
		backupTaken: commitResult.backupTaken,
		pendingWrite: commitResult.pendingWrite,
		skippedPeers,
	};
}

function isSelfExport(filePath: string, selfExportFileName: string): boolean {
	return filePath === selfExportFileName || filePath.endsWith(`/${selfExportFileName}`);
}

/**
 * Validates and normalizes a peer export doc (design.md threat matrix):
 * `schema === 1`, `titles` a plain object whose values each carry a string
 * `id`, `titleMeta` values degrade to a `lastModified` baseline of `0` when
 * missing or malformed. Returns `undefined` to reject the peer wholesale on
 * any structural failure — the caller never lets a rejected peer reach
 * `data.json`.
 */
function validatePeerDoc(raw: string): PeerExport | undefined {
	if (raw.length > MAX_PEER_FILE_BYTES) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}

	const doc = parsed as Record<string, unknown>;
	if (doc.schema !== 1) {
		return undefined;
	}
	if (typeof doc.deviceId !== "string" || doc.deviceId === "") {
		return undefined;
	}
	if (!isPlainObject(doc.titles)) {
		return undefined;
	}

	const titles: Record<string, TitleEntry> = {};
	for (const [id, value] of Object.entries(doc.titles)) {
		if (typeof value !== "object" || value === null) {
			continue;
		}
		const entry = value as Record<string, unknown>;
		if (typeof entry.id !== "string" || entry.id === "") {
			continue;
		}
		titles[id] = entry as TitleEntry;
	}

	const rawMeta = isPlainObject(doc.titleMeta) ? doc.titleMeta : {};
	const titleMeta: Record<string, TitleMeta> = {};
	for (const [id, value] of Object.entries(rawMeta)) {
		titleMeta[id] = { lastModified: normalizeLastModified(value), scalarHash: normalizeScalarHash(value) };
	}

	return { deviceId: doc.deviceId, titles, titleMeta };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A missing or malformed `lastModified` degrades to baseline `0`, never
 * `Date.now()` (design.md threat matrix) — a corrupt or hostile peer can
 * never win a scalar conflict it did not legitimately win.
 */
function normalizeLastModified(value: unknown): number {
	if (isPlainObject(value)) {
		const lastModified = value.lastModified;
		if (typeof lastModified === "number" && Number.isFinite(lastModified) && lastModified >= 0) {
			return lastModified;
		}
	}
	return 0;
}

function normalizeScalarHash(value: unknown): string {
	if (isPlainObject(value) && typeof value.scalarHash === "string") {
		return value.scalarHash;
	}
	return "";
}

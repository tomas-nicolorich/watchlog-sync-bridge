/**
 * Write safety for WatchLog's own `data.json` (design.md "Write Safety for
 * WatchLog's data.json"): backup + validate + verify + a crash marker,
 * because Obsidian's `DataAdapter` offers no cross-platform atomic replace
 * to rely on.
 *
 * This module owns all mutating I/O against WatchLog's `data.json`. It never
 * decides *what* the merged content should be (that is `merge.ts`'s job) —
 * callers pass the already-merged `titles` array; this module backs up,
 * refuses garbage, validates, stages, writes, verifies, and exposes crash
 * recovery for the next load.
 */
import { canonical, fnv1a } from "./hash";
import type { PendingWrite, TitleEntry } from "./types";

/**
 * The minimal adapter surface this module depends on — kept narrow on
 * purpose, matching `export.ts`'s `ExportAdapter` pattern, so tests never
 * need a full Obsidian `DataAdapter` stub.
 */
export interface WatchlogIoAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export type LogFn = (message: string, detail?: unknown) => void;
const noopLog: LogFn = () => {};

export interface CommitParams {
	adapter: WatchlogIoAdapter;
	/** WatchLog's own data file. This module reads and, on success, writes it. */
	watchlogDataPath: string;
	/** This plugin's own directory, e.g. ".obsidian/plugins/watchlog-sync-bridge". */
	bridgeDir: string;
	/** The already-merged titles array (merge.ts's output) to commit. */
	mergedTitles: readonly TitleEntry[];
	/** Whether a backup has already been taken on this device (BridgeData.backupTaken). */
	backupTaken: boolean;
	/** Epoch ms clock, injectable for deterministic tests. */
	now: number;
	/** ISO-8601 timestamp; defaults to `new Date(now).toISOString()` when omitted. */
	nowIso?: string;
	log?: LogFn;
}

export interface CommitResult {
	committed: boolean;
	/** Updated backup-taken flag for the caller to persist. */
	backupTaken: boolean;
	/** Set only when a write was attempted against the real target and did
	 * not (yet) verify as successful — the caller must persist this and
	 * retry `recoverPendingWrite` on next load. Undefined on success or on
	 * an abort that never reached the target write. */
	pendingWrite?: PendingWrite;
	/** Present when `committed` is false; a short machine-readable reason. */
	reason?: string;
}

/**
 * Backs up (if needed), validates, stages, writes, and verifies a merged
 * `titles` array against WatchLog's `data.json` (design.md steps 1, 3, 4).
 */
export async function commitMergedData(params: CommitParams): Promise<CommitResult> {
	const log = params.log ?? noopLog;
	const nowIso = params.nowIso ?? new Date(params.now).toISOString();

	let beforeRaw: string;
	try {
		beforeRaw = await params.adapter.read(params.watchlogDataPath);
	} catch (err) {
		log("watchlogIo: failed to read data.json before commit, aborting", err);
		return { committed: false, backupTaken: params.backupTaken, reason: "read-failed" };
	}

	let before: Record<string, unknown>;
	try {
		before = JSON.parse(beforeRaw) as Record<string, unknown>;
	} catch (err) {
		// Refuse to act on garbage (design.md step 2) — falls out naturally
		// here because we need `before` to compute countBefore/beforeIds below.
		log("watchlogIo: data.json is not valid JSON, refusing to act on it", err);
		return { committed: false, backupTaken: params.backupTaken, reason: "source-invalid-json" };
	}
	const beforeTitles = Array.isArray(before.titles) ? (before.titles as TitleEntry[]) : undefined;
	if (beforeTitles === undefined) {
		log("watchlogIo: data.json's titles is not an array, refusing to act on it");
		return { committed: false, backupTaken: params.backupTaken, reason: "source-titles-not-array" };
	}

	let backupTaken = params.backupTaken;
	if (!backupTaken) {
		const backupPath = `${params.bridgeDir}/backups/watchlog-data.${nowIso.replace(/[:.]/g, "-")}.json`;
		await params.adapter.write(backupPath, beforeRaw);
		backupTaken = true;
	}

	const beforeIds = new Set(beforeTitles.filter(hasStringId).map((entry) => entry.id));
	const merged = { ...before, titles: params.mergedTitles };
	const serialized = JSON.stringify(merged);

	const validation = validateMergedContent(serialized, beforeIds, beforeTitles.length);
	if (!validation.ok) {
		log(`watchlogIo: invalid merge result, refusing to commit (${validation.reason})`);
		return { committed: false, backupTaken, reason: validation.reason };
	}

	const targetHash = safeHash(serialized);
	const pendingDataPath = `${params.bridgeDir}/pending-data.json`;
	await params.adapter.write(pendingDataPath, serialized);
	const pendingWrite: PendingWrite = { targetHash: targetHash as string, startedAt: nowIso };

	try {
		await params.adapter.write(params.watchlogDataPath, serialized);
	} catch (err) {
		log("watchlogIo: crash/error while writing data.json; pending write left for crash recovery", err);
		return { committed: false, backupTaken, pendingWrite, reason: "write-crashed" };
	}

	let readback: string;
	try {
		readback = await params.adapter.read(params.watchlogDataPath);
	} catch (err) {
		log("watchlogIo: failed to read back data.json after writing; pending write left for crash recovery", err);
		return { committed: false, backupTaken, pendingWrite, reason: "readback-failed" };
	}

	if (safeHash(readback) !== pendingWrite.targetHash) {
		log("watchlogIo: readback hash mismatch after write; pending write left for crash recovery");
		return { committed: false, backupTaken, pendingWrite, reason: "readback-mismatch" };
	}

	return { committed: true, backupTaken };
}

export interface RecoverParams {
	adapter: WatchlogIoAdapter;
	watchlogDataPath: string;
	bridgeDir: string;
	pendingWrite: PendingWrite | undefined;
	log?: LogFn;
}

export interface RecoverResult {
	/** Undefined once the marker is resolved (cleared or already unset). */
	pendingWrite?: PendingWrite;
	/** Present only when data.json was actually rewritten during recovery. */
	restoredFrom?: "pending";
}

/**
 * Crash recovery on load (design.md step 5). Call this once at startup with
 * whatever `pendingWrite` marker was persisted in the bridge's own data.
 *
 * - No marker: nothing to do.
 * - data.json parses and matches the pending target hash: the write actually
 *   completed before the crash — clear the marker.
 * - data.json parses but does not match: a stale-but-valid file (the crash
 *   happened before the target write reached disk) — clear the marker and
 *   let the next cycle re-merge.
 * - data.json fails to parse: restore from the staged `pending-data.json` if
 *   it still validates against the target hash.
 *
 * Restoring from the newest backup as a final fallback (per design.md step 5)
 * is out of this PR's scope — it needs directory listing, which is deferred
 * to the lifecycle wiring in Phase 9 alongside the rest of `BridgeData`
 * persistence. Documented here, not silently dropped.
 */
export async function recoverPendingWrite(params: RecoverParams): Promise<RecoverResult> {
	const log = params.log ?? noopLog;
	if (params.pendingWrite === undefined) {
		return {};
	}

	let current: string | undefined;
	try {
		current = await params.adapter.read(params.watchlogDataPath);
	} catch (err) {
		log("watchlogIo: crash recovery could not read data.json, attempting restore from staged copy", err);
	}

	if (current !== undefined) {
		const currentHash = safeHash(current);
		if (currentHash !== undefined) {
			// Parses either way: the write completed, or a stale-but-valid file
			// remains. Either way there is nothing corrupt to repair; clear the
			// marker and (if the hash differs) let the next cycle re-merge.
			if (currentHash !== params.pendingWrite.targetHash) {
				log("watchlogIo: pending write target not observed on disk; clearing marker for the next cycle");
			}
			return {};
		}
	}

	const pendingDataPath = `${params.bridgeDir}/pending-data.json`;
	try {
		const staged = await params.adapter.read(pendingDataPath);
		if (safeHash(staged) === params.pendingWrite.targetHash) {
			await params.adapter.write(params.watchlogDataPath, staged);
			log("watchlogIo: restored data.json from staged pending-data.json after a crash");
			return { restoredFrom: "pending" };
		}
		log("watchlogIo: staged pending-data.json failed validation, cannot auto-restore from it");
	} catch (err) {
		log("watchlogIo: staged pending-data.json missing or unreadable, cannot auto-restore from it", err);
	}

	// Neither the live file nor the staged copy is usable; keep the marker so
	// the next load retries recovery rather than silently forgetting it.
	return { pendingWrite: params.pendingWrite };
}

function hasStringId(entry: TitleEntry): entry is TitleEntry & { id: string } {
	return typeof entry.id === "string" && entry.id !== "";
}

function safeHash(raw: string): string | undefined {
	try {
		return fnv1a(canonical(JSON.parse(raw)));
	} catch {
		return undefined;
	}
}

interface ValidationResult {
	ok: boolean;
	reason?: string;
}

/**
 * Validate before commit (design.md step 3): the serialized merged content
 * must parse, `titles` must be an array, its count must not shrink below
 * `countBefore`, and every pre-existing id must still be present.
 */
function validateMergedContent(
	serialized: string,
	beforeIds: ReadonlySet<string>,
	countBefore: number,
): ValidationResult {
	let parsed: { titles?: unknown };
	try {
		parsed = JSON.parse(serialized) as { titles?: unknown };
	} catch {
		return { ok: false, reason: "merged-not-valid-json" };
	}
	if (!Array.isArray(parsed.titles)) {
		return { ok: false, reason: "merged-titles-not-array" };
	}
	const titles = parsed.titles as TitleEntry[];
	if (titles.length < countBefore) {
		return { ok: false, reason: "merged-count-below-before" };
	}
	const mergedIds = new Set(titles.filter(hasStringId).map((entry) => entry.id));
	for (const id of beforeIds) {
		if (!mergedIds.has(id)) {
			return { ok: false, reason: "merged-missing-preexisting-id" };
		}
	}
	return { ok: true };
}

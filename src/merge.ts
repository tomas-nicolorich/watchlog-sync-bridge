/**
 * Pure per-id union merge, history de-dup, dateAdded earliest-wins, and
 * last-write-wins scalar resolution (design.md "Merge Algorithm").
 *
 * Zero Obsidian dependency — this is one of the two TDD cores (module
 * boundaries table). All decision logic lives here; I/O modules
 * (`watchlogIo.ts`, `importer.ts`) stay thin wrappers around this function.
 */
import { canonical, fnv1a } from "./hash";
import { scalarHash } from "./titleState";
import type { ExportDoc, HistoryEntry, TitleEntry, TitleMeta } from "./types";

/** The subset of a peer's export doc that merge needs (design.md interfaces). */
export type PeerExport = Pick<ExportDoc, "deviceId" | "titles" | "titleMeta">;

export interface MergeResult {
	titles: TitleEntry[];
	meta: Record<string, TitleMeta>;
	addedIds: string[];
	changedIds: string[];
}

interface Owner {
	lm: number;
	dev: string;
}

/**
 * Merges `localTitles` with any number of peer exports.
 *
 * Total order on scalar-conflict candidates: `(lastModified DESC, deviceId
 * ASC)`. This is what makes the winner independent of the order peers are
 * visited (design.md "Why this converges"): the result is idempotent,
 * commutative in peer order, never loses an entry or a history event, and
 * never moves `dateAdded` forward.
 */
export function mergeTitles(
	localTitles: readonly TitleEntry[],
	localMeta: Readonly<Record<string, TitleMeta>>,
	peers: readonly PeerExport[],
	selfDeviceId: string,
): MergeResult {
	const byId = new Map<string, TitleEntry>();
	const owner = new Map<string, Owner>();
	const keep: TitleEntry[] = [];
	const addedIds = new Set<string>();
	const changedIds = new Set<string>();

	for (const entry of localTitles) {
		if (hasStringId(entry)) {
			byId.set(entry.id, clone(entry));
			owner.set(entry.id, { lm: localMeta[entry.id]?.lastModified ?? 0, dev: selfDeviceId });
		} else {
			keep.push(clone(entry));
		}
	}

	// Sorting is determinism-for-output-ordering only, not a correctness
	// crutch: the total order below already makes the winner independent of
	// visiting order (design.md "Peer sorting is belt-and-braces").
	const sortedPeers = [...peers].sort((a, b) => compareStrings(a.deviceId, b.deviceId));

	for (const peer of sortedPeers) {
		for (const [id, peerEntry] of Object.entries(peer.titles)) {
			const peerOwner: Owner = { lm: peer.titleMeta[id]?.lastModified ?? 0, dev: peer.deviceId };

			const localEntry = byId.get(id);
			const localOwner = owner.get(id);

			if (localEntry === undefined || localOwner === undefined) {
				byId.set(id, clone(peerEntry));
				owner.set(id, peerOwner);
				addedIds.add(id);
				continue;
			}

			// Newer lastModified wins; an exact tie resolves by the
			// lexicographically smaller deviceId (deterministic regardless of
			// which device runs the merge — spec: "Equal tracked lastModified
			// values resolve by deterministic deviceId order").
			const peerWins =
				peerOwner.lm > localOwner.lm || (peerOwner.lm === localOwner.lm && compareStrings(peerOwner.dev, localOwner.dev) < 0);
			const winner = peerWins ? peerEntry : localEntry;

			const merged: TitleEntry = {
				...clone(winner),
				id,
				// Append-style facts keep their own rules, independent of the
				// scalar-conflict winner (design.md: "those are append-style
				// facts, not edits").
				dateAdded: earliestDateAdded(localEntry.dateAdded, peerEntry.dateAdded),
				history: unionHistory(localEntry.history ?? [], peerEntry.history ?? []),
			};

			if (canonical(merged) !== canonical(localEntry)) {
				changedIds.add(id);
			}

			byId.set(id, merged);
			if (peerWins) {
				// Persist the winner's owner so a later peer in this same cycle
				// (or a re-merge next cycle) compares against the correct
				// (lastModified, deviceId) pair, not a stale local one.
				owner.set(id, peerOwner);
			}
		}
	}

	const meta: Record<string, TitleMeta> = {};
	for (const [id, entry] of byId.entries()) {
		const entryOwner = owner.get(id);
		// Every id in byId was added through a branch above that also sets
		// owner for that same id, so this is always defined.
		const lastModified = entryOwner?.lm ?? 0;
		meta[id] = { lastModified, scalarHash: scalarHash(entry) };
	}

	const titles = [...byId.values(), ...keep].sort(compareByDateAddedThenId);

	return {
		titles,
		meta,
		addedIds: [...addedIds].sort(),
		changedIds: [...changedIds].sort(),
	};
}

function hasStringId(entry: TitleEntry): entry is TitleEntry & { id: string } {
	return typeof entry.id === "string" && entry.id !== "";
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Ordinal (locale-independent) string comparison — deterministic across environments, unlike `localeCompare`. */
function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function dateAddedTimestamp(value: TitleEntry["dateAdded"]): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
	}
	return Number.POSITIVE_INFINITY;
}

/**
 * Earliest-wins (design.md "dateAdded uses earliest-wins semantics"). A
 * missing side always loses to a defined one.
 */
function earliestDateAdded(a: TitleEntry["dateAdded"], b: TitleEntry["dateAdded"]): TitleEntry["dateAdded"] {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return dateAddedTimestamp(a) <= dateAddedTimestamp(b) ? a : b;
}

function compareByDateAddedThenId(a: TitleEntry, b: TitleEntry): number {
	const timeDiff = dateAddedTimestamp(a.dateAdded) - dateAddedTimestamp(b.dateAdded);
	if (timeDiff !== 0) return timeDiff;
	const idA = typeof a.id === "string" ? a.id : "";
	const idB = typeof b.id === "string" ? b.id : "";
	return compareStrings(idA, idB);
}

/**
 * Stable de-dup key for a history entry (design.md "History Union and
 * De-duplication"): a stable string `id` takes the `id:`-prefixed fast
 * path; otherwise falls back to a content hash of the entry's normalized
 * fields. Both paths are unconditionally implemented per design.md's
 * pseudocode — there is no live branching on a spike outcome here. The
 * verification spike (tasks.md Phase 2, gating this phase per "Spike
 * Gating") only confirms which path real WatchLog history data actually
 * exercises; it does not change which code runs. This is documented as
 * PROVISIONAL in the sense that spike b1 (tasks.md 2.4) has not yet
 * inspected a real `history[0]` shape — see spike-findings.md.
 */
function historyKey(entry: HistoryEntry): string {
	if (typeof entry.id === "string" && entry.id !== "") {
		return `id:${entry.id}`;
	}
	return `c:${fnv1a(canonical(entry))}`;
}

// PROVISIONAL, same spirit as titleState.ts's SCALAR_HASH_EXCLUDED_FIELDS:
// no concrete WatchLog history timestamp field name is confirmed yet (spike
// b1 is still pending). This list is a best-effort guess used ONLY to order
// the merged `history` array for display/determinism; it never affects
// de-duplication (that is entirely governed by `historyKey` above, which is
// spec-tested and does not depend on this list). Revisit once spike b1 data
// is recorded in spike-findings.md.
const HISTORY_TIMESTAMP_FIELD_CANDIDATES = ["timestamp", "date", "dateWatched", "watchedAt", "createdAt", "time"] as const;

function historyTimestamp(entry: HistoryEntry): number {
	for (const field of HISTORY_TIMESTAMP_FIELD_CANDIDATES) {
		const value = entry[field];
		if (typeof value === "number") return value;
		if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (!Number.isNaN(parsed)) return parsed;
		}
	}
	return 0;
}

/**
 * Unions two history arrays and removes duplicates representing the same
 * underlying event (design.md `unionHistory`). Never drops an entry present
 * in either source — required invariant: no `history` entry is ever lost.
 */
function unionHistory(a: readonly HistoryEntry[], b: readonly HistoryEntry[]): HistoryEntry[] {
	const out = a.map((entry) => clone(entry));
	const seen = new Set(a.map(historyKey));

	for (const entry of b) {
		const key = historyKey(entry);
		if (!seen.has(key)) {
			out.push(clone(entry));
			seen.add(key);
		}
	}

	return out.sort((x, y) => {
		const timeDiff = historyTimestamp(x) - historyTimestamp(y);
		if (timeDiff !== 0) return timeDiff;
		return compareStrings(historyKey(x), historyKey(y));
	});
}

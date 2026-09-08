import { canonical, fnv1a } from "./hash";
import type { TitleEntry, TitleMeta } from "./types";

/**
 * Fields excluded from the scalar-content surface before hashing, on top of
 * the always-excluded `id`/`dateAdded`/`history` (design.md: "a field
 * WatchLog rewrites on every render inflates lastModified" — spike b2).
 *
 * Populated from the real desktop verification spike run recorded in
 * spike-findings.md (2026-09-07): the sampled title entry's `dateModified`
 * and `communityRatingLastFetched` are both auto-rewritten by WatchLog's own
 * background metadata refresh, not by user edits. Including either would
 * make scalarHash change on every refresh cycle and spuriously bump this
 * bridge's tracked lastModified, letting a stale device win an LWW conflict
 * it never actually edited.
 */
const SCALAR_HASH_EXCLUDED_FIELDS: readonly string[] = ["dateModified", "communityRatingLastFetched"];

const ALWAYS_EXCLUDED_FIELDS = new Set(["id", "dateAdded", "history", ...SCALAR_HASH_EXCLUDED_FIELDS]);

/**
 * `scalarHash(entry) := fnv1a(canonical(entry minus id, dateAdded, history))`
 * (design.md "Bridge-tracked per-title lastModified" decision). Treats the
 * non-append surface of a title entry as one opaque blob so unknown/future
 * WatchLog fields participate in change detection automatically, with no
 * allowlist.
 */
export function scalarHash(entry: TitleEntry): string {
	const scalarSurface = Object.fromEntries(
		Object.entries(entry).filter(([key]) => !ALWAYS_EXCLUDED_FIELDS.has(key)),
	);
	return fnv1a(canonical(scalarSurface));
}

/**
 * Reconciles the bridge's per-title `lastModified` clock against the
 * current local `titles` list (spec.md "Per-Title lastModified Tracking").
 *
 * - Unknown id (no prior snapshot): seed `{ lastModified: 0, scalarHash }`
 *   — baseline, not `now`, so a freshly-installed device cannot win every
 *   conflict against titles already being tracked elsewhere.
 * - Known id, `scalarHash` differs from the stored snapshot: a real local
 *   edit — set `lastModified = now`, store the new hash.
 * - Known id, hash equal: untouched.
 * - An id present in `priorState` but absent from `titles` (deleted or
 *   temporarily missing locally) keeps its prior state entry unchanged —
 *   deletions never propagate and the id can still return via a peer.
 *
 * Entries lacking a string `id` are skipped defensively (they cannot be
 * tracked or merged by id at all).
 */
export function reconcileTitleState(
	titles: readonly TitleEntry[],
	priorState: Readonly<Record<string, TitleMeta>>,
	now: number,
): Record<string, TitleMeta> {
	const nextState: Record<string, TitleMeta> = { ...priorState };

	for (const entry of titles) {
		if (typeof entry.id !== "string" || entry.id === "") {
			continue;
		}

		const currentHash = scalarHash(entry);
		const prior = priorState[entry.id];

		if (prior === undefined) {
			nextState[entry.id] = { lastModified: 0, scalarHash: currentHash };
			continue;
		}

		if (prior.scalarHash !== currentHash) {
			nextState[entry.id] = { lastModified: now, scalarHash: currentHash };
		} else {
			nextState[entry.id] = prior;
		}
	}

	return nextState;
}

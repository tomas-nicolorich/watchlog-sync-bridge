/**
 * Shared type declarations (design.md "Interfaces / Contracts").
 *
 * Type-only, zero runtime code, zero Obsidian dependency — safe to import
 * from every pure and I/O module alike.
 */

/**
 * Defensive: only `id` is required. Everything else passes through
 * untouched (design.md: "unknown-field passthrough - never drop what we
 * don't understand").
 */
export type TitleEntry = {
	id: string;
	dateAdded?: string | number;
	history?: HistoryEntry[];
	[k: string]: unknown;
};

export type HistoryEntry = { id?: string; [k: string]: unknown };

/**
 * Bridge-owned per-title metadata. Kept in a sidecar map, never injected
 * into a TitleEntry, so exported entries stay byte-identical to WatchLog's
 * own shape.
 */
export interface TitleMeta {
	/** epoch ms; 0 = baseline, never observed to change */
	lastModified: number;
	/** fnv1a(canonical(entry minus id/dateAdded/history)) */
	scalarHash: string;
}

/** Export file: WatchLog/.sync/{deviceId}.json */
export interface ExportDoc {
	schema: 1;
	deviceId: string;
	/** display only, never merge input */
	deviceLabel?: string;
	/** ISO-8601, diagnostics only, NOT a merge input */
	exportedAt: string;
	/** FNV-1a of canonical(titles); change detection */
	titlesHash: string;
	/** keyed by entry.id, values VERBATIM */
	titles: Record<string, TitleEntry>;
	/** SIDECAR, keyed by the same id; bridge-owned */
	titleMeta: Record<string, TitleMeta>;
	/** entries lacking a string id: diagnostics only, never merged */
	unkeyed?: TitleEntry[];
}

/**
 * Crash-recovery marker for an in-flight `data.json` write (design.md "Write
 * Safety for WatchLog's data.json", steps 4-5). Set before the real target
 * write begins, cleared only after a verified successful write or a
 * successful crash-recovery restore.
 */
export interface PendingWrite {
	targetHash: string;
	startedAt: string;
}

/** Local plugin data (.obsidian/plugins/watchlog-sync-bridge/data.json) */
export interface BridgeData {
	deviceId: string;
	/**
	 * Extends design.md's documented shape with `syncDirPath` (vault-relative
	 * directory for this device's per-device export file, default
	 * `WatchLog/.sync` — see `src/settings.ts`): spec.md's User-Configurable
	 * Settings requirement is explicit that export path SHOULD be
	 * configurable, which design.md's interface listing omitted. Documented
	 * here as a design deviation rather than applied silently.
	 */
	settings: { pollSeconds: number; autoReloadWatchLog: boolean; deviceLabel?: string; syncDirPath: string };
	lastExport?: { mtime: number; size: number; titlesHash: string };
	/** by title id - the LWW clock, bridge-owned */
	titleState: Record<string, TitleMeta>;
	/** by filename */
	peerState: Record<string, { mtime: number; size: number }>;
	backupTaken: boolean;
	/** crash-recovery marker */
	pendingWrite?: PendingWrite;
}

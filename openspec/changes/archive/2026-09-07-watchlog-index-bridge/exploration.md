# Exploration: WatchLog Index Bridge — cross-device data.json sync via yaos blob-sync

## Current State

Greenfield repo (no code yet). All facts below are inherited from `CLAUDE.md`'s
prior investigation, not re-derived from WatchLog/yaos source in this
exploration session (no local source access from this repo):

- yaos hardcodes `.obsidian/` exclusion (`alwaysExcludedPrefixes()` in
  `src/sync/exclude.ts`), unconditional, no override.
- yaos's discovery pipeline runs on Obsidian's `Vault` API
  (`getFiles`/`getMarkdownFiles`/`vault.on("create"|"modify"|"rename"|"delete")`),
  which never surfaces config-dir paths regardless of exclude rules — core
  Obsidian behavior, not a yaos-specific choice. Patching yaos's exclude list
  alone cannot fix this.
- yaos supports non-`.md` vault files as sync "blobs"
  (`src/paths/pathCategory.ts` + `src/sync/blobSync.ts`) — no yaos changes
  needed for a vault-visible export file.
- WatchLog's UI is driven only by `this.data.titles` via
  `loadData()`/`saveData()`; it does not rebuild from markdown notes. It
  listens for external `data.json` changes via `vault.on("raw", ...)`,
  desktop-only (does not fire on mobile).
- yaos's own `diskIndex.ts` already reconciles by polling mtime/hash rather
  than relying on native fs events everywhere — direct precedent for this
  bridge's polling design.
- Obsidian's official Vault API docs (`docs.obsidian.md/Plugins/Vault`) do
  **not** document a `"raw"` event, platform differences, or whether
  `adapter.write()` triggers `"modify"`/`"raw"` events — confirms `"raw"` is
  undocumented/internal-only, reinforcing (not resolving) the need for a
  verification spike.
- BRAT installs and updates beta plugins identically on desktop and mobile
  (community plugin browser + "Add a beta plugin for testing" GitHub-repo
  flow on both platforms) — confirmed via web search.

## Affected Areas

No existing files (greenfield project). Planned/future modules this
exploration reasons about:

- `manifest.json`, `main.ts` (plugin entry) — not yet created; would host the
  trigger loop, export/import logic.
- `.obsidian/plugins/watchlog/data.json` — external, WatchLog-owned; read
  target on export, write target on import merge.
- A new vault-visible export path (e.g. `WatchLog/.sync/{deviceId}.json`) —
  new file(s) this plugin creates, blob-synced unmodified by yaos.
- yaos's `blobSync.ts` / `pathCategory.ts` / `diskIndex.ts` — referenced only
  as behavioral precedent, never modified (explicit non-goal).

## Approaches

### 1. Trigger mechanism (export side)

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| (a) Poll `adapter.stat()` interval | Uniform desktop+mobile; matches yaos's `diskIndex.ts` precedent; simple, testable | Latency bound by poll interval | Low |
| (b) `vault.on("raw")` desktop + poll fallback mobile | Near-instant desktop reaction | `"raw"` undocumented; two code paths; still needs full polling path for mobile regardless | Medium |
| (c) Piggyback WatchLog UI action hooks | Most precise if it exists | Unverifiable without WatchLog source — CLAUDE.md records no public API/hooks; likely not viable | Unknown/blocked |

Sub-recommendation: (a) as the v1 baseline (only option uniformly correct
without unverified assumptions); (b) only later, as a desktop-only latency
optimization, after a spike confirms `"raw"` fires for adapter-originated
writes; (c) not designed around until real source is available.

### 2. Export format

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| Whole-file mirror of `data.json` | Trivial | If yaos blob sync is whole-file LWW (unconfirmed this session), two devices writing the **same shared filename** would race/clobber before either merges | Low |
| Normalized subset (`titles` keyed by `id`), **one file per device** | Avoids the write-clobber race entirely under LWW — each device only ever writes its own file; gives the importer exactly the shape it needs (keyed union) | Requires discovering N per-device files on import (bounded, small) | Medium |
| Append-only per-device changelog of title-additions/edits | Strongest merge safety — never overwrites `history`, only appends; naturally supports union+de-dup | Unbounded growth needs a compaction strategy | Medium-High |

Sub-recommendation: per-device files are near-mandatory **if** yaos blob sync
really is whole-file LWW (the single most determinative unverified fact —
validate in propose/design). Normalized keyed-subset snapshot is the
pragmatic v1 pick; the changelog is a plausible v2 evolution if `history`
fidelity matters more than simplicity.

### 3. Merge policy (import side)

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| Per-`id` union + LWW by per-entry timestamp | Simple, deterministic | WatchLog isn't confirmed to have a per-entry `lastModified` (only `dateAdded`, which is creation time, not edit time); whole-entry replace risks dropping legitimate `history` | Low-Medium |
| Per-`id` union + union `history` entries with de-dup + keep earliest `dateAdded` | Never loses data; `dateAdded` semantics correct (first-seen wins) | Needs a stable de-dup key for `history` entries — entry schema/IDs not fully documented | Medium |

Sub-recommendation: union-of-history-with-de-dup + earliest-`dateAdded`,
matching the goal of not clobbering `history`/`dateAdded`. The de-dup key
mechanics must be pinned down in sdd-design against the real `history` entry
shape.

### 4. Getting WatchLog to notice the merged data.json

| Platform | Assessment |
|---|---|
| Desktop | Unverified whether `adapter.write()` reliably re-triggers WatchLog's `"raw"` listener. Needs a verification spike (write via `adapter.write()` from a throwaway test plugin, observe whether WatchLog's UI updates without manual reload) before design depends on it. |
| Mobile | `"raw"` confirmed (per CLAUDE.md) not to fire at all — almost certainly needs an explicit user nudge (reopen WatchLog view / app reload) unless WatchLog exposes an undiscovered reload command (no evidence either way). |

Sub-recommendation: design for the worst case (desktop auto-detection
unreliable, mobile definitely needs a nudge); ship a documented "manual
reload/reopen WatchLog view" fallback for both platforms regardless of what
the desktop spike finds.

### 5. Distribution

BRAT confirmed suitable for both desktop and mobile — community-plugin-
browsable and its "Add a beta plugin for testing" GitHub-repo flow works
identically on mobile. Low effort, no blockers.

### 6. Alternatives considered and rejected

| Alternative | Verdict | Reason |
|---|---|---|
| Fork yaos | Rejected | Architecturally insufficient — `Vault` API never surfaces config-dir paths regardless of exclude list |
| Fork WatchLog for vault-scan rebuild | Rejected | Bigger surface, no source access, violates stated non-goals |
| Manual copy-paste | Rejected | The exact toil problem this project exists to eliminate |
| Sync `data.json` via a separate external tool outside yaos | Fallback, not primary | Works but adds a second sync mechanism/trust boundary; worth keeping if items 1/4 turn out fully blocked |

## Recommendation

v1: **poll-based trigger** (both platforms, no `"raw"` dependency for
correctness) + **per-device, `id`-keyed `titles` subset export** + **per-`id`
union merge with history-union/de-dup and earliest-`dateAdded`** +
**defensive "assume manual reload needed everywhere, relax only after
spike"** for WatchLog notice + **BRAT** distribution (confirmed). This
combination is the only one that doesn't rest on either of the two most
load-bearing unverified assumptions (`"raw"` firing for adapter-originated
writes; yaos blob sync being true whole-file LWW) — it is correct in the
worst case and can only improve once those are confirmed.

## Data Gaps

- No direct source access to WatchLog or yaos in this repo/session — this
  exploration reasons from CLAUDE.md's summary only. Items 1 (WatchLog UI
  hooks) and 4 (raw-event/adapter.write interaction, WatchLog reload API)
  are unverified and MUST be treated as open questions needing a
  verification spike in sdd-propose/sdd-design, not settled facts, before
  implementation commits to either.
- Whether yaos blob sync is genuinely whole-file LWW (vs. finer-grained
  merge) is an inherited working assumption, not independently confirmed
  against yaos source this session — it directly determines the
  export-format decision (item 2) and should be verified early.
- WatchLog's `history` entry schema (stable ID/timestamp for de-dup) is
  undocumented beyond "a history log" in CLAUDE.md — merge de-dup mechanics
  (item 3) can't be fully pinned down until confirmed.

## Ready for Proposal

Yes, with caveat: sdd-propose should carry forward the two flagged
verification items (desktop trigger/notice reliability, mobile notice
mechanism) as either an explicit spike task ahead of the proposal, or
clearly risk-flagged assumptions for early design-phase testing. Export
format, merge policy, and distribution conclusions are solid enough to
propose against directly.

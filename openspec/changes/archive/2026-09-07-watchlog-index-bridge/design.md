# Design: WatchLog Index Bridge

## Technical Approach

A single-purpose Obsidian plugin (`watchlog-sync-bridge`, TypeScript + esbuild, `isDesktopOnly: false`). Each device polls WatchLog's `.obsidian/plugins/watchlog/data.json` via `adapter.read()`, exports an `id`-keyed `titles` subset to its **own** vault-visible file `WatchLog/.sync/{deviceId}.json` (rides yaos blob sync unmodified), discovers peer files, merges them into local `data.json` via `adapter.write()`, and tells the user to reload WatchLog if it did not pick the change up live. Correctness never depends on the undocumented `"raw"` event or on `adapter.write()` triggering vault events; those are optimizations only.

The merge is **set-monotonic** (no `id` is ever removed, so deletions do not propagate) but **not content-frozen**: `history` unions, `dateAdded` keeps the earliest, and scalar-field edits resolve **last-write-wins** on a per-title `lastModified` the bridge tracks **itself**, in its **own** plugin data. WatchLog's `data.json` schema stays owned by WatchLog — the bridge only ever reads it and writes back WatchLog-shaped entries; no bridge metadata is ever added to that file.

Binding product decisions (proposal, user-confirmed): minutes-scale staleness, poll-only, manual reload acceptable, **deletions never propagate**, **scalar field edits DO propagate** (LWW on bridge-tracked `lastModified`), 2-3 devices with no stale-file cleanup.

## Module Boundaries

| Module | Responsibility | Obsidian API? |
|---|---|---|
| `main.ts` | Plugin lifecycle, wiring, commands, status bar | Yes |
| `src/identity.ts` | Create/persist `deviceId`, sanitize into a filename | No (data via main) |
| `src/watchlogIo.ts` | Read/parse/validate/backup/atomic-write WatchLog `data.json` | Yes (adapter) |
| `src/export.ts` | Build export doc, change detection, write own peer file | Yes (adapter) |
| `src/importer.ts` | Discover + read peer files, drive merge, commit result | Yes (adapter) |
| `src/merge.ts` | **Pure** merge/union/de-dup/LWW resolution | **No — TDD core** |
| `src/titleState.ts` | **Pure** per-title `lastModified`/`scalarHash` tracking + reconciliation | **No — TDD core** |
| `src/hash.ts` | Canonical JSON + FNV-1a 64 (change detection, scalar hash, history de-dup) | No |
| `src/scheduler.ts` | Triggers, single-flight lock, backoff | Yes (timers/events) |
| `src/settings.ts` | Settings type + settings tab | Yes |

Rule: all decision logic lives in `merge.ts`/`titleState.ts`/`hash.ts` with zero Obsidian imports so it is unit-testable without a vault. I/O modules stay thin.

## Architecture Decisions

### Decision: Device identity from a self-generated UUID in the plugin's own `data.json`

| Option | Tradeoff | Verdict |
|---|---|---|
| `crypto.randomUUID()` persisted in own `data.json` | Simple, works on mobile; **does not survive reinstall/plugin-data wipe** | **Chosen** |
| Machine-derived ID (`app.appId`, hostname) | Undocumented/internal or unavailable on mobile | Rejected |
| User-typed device name | Human-friendly, but collides and adds setup friction | Rejected (exposed as optional `deviceLabel` for display only) |

Rationale: the plugin's own `data.json` lives under `.obsidian/`, which yaos never syncs — so it is per-device *by construction*, exactly the property we need. **Tradeoff accepted:** a reinstall mints a new `deviceId`, leaving one orphan `WatchLog/.sync/*.json`. It is harmless (import is a union; a stale peer only re-adds titles that already exist) and cleanup is a confirmed v1 non-goal. `deviceId` is sanitized to `[a-z0-9-]{1,40}` before use in a path.

### Decision: Per-device export files, `id`-keyed, unknown-field passthrough

Per-device filenames make the whole-file-LWW question moot: no two devices ever write the same blob. Entries are copied **verbatim** rather than through a field allowlist, because WatchLog's real entry schema is unknown beyond `id`/`dateAdded`/`history`; an allowlist would silently drop fields on every round trip.

### Decision: Bridge-tracked per-title `lastModified`, stored in the bridge's own `data.json`

WatchLog's entries carry no modification timestamp (`dateAdded` is creation time), and its `data.json` schema is WatchLog's to own — the bridge must not invent fields in it. So the bridge keeps its own map in `.obsidian/plugins/watchlog-sync-bridge/data.json`:

```
titleState: Record<titleId, { lastModified: number /* epoch ms */; scalarHash: string }>
```

| Option | Tradeoff | Verdict |
|---|---|---|
| Bridge-owned `titleState` map in the bridge's own plugin data | No foreign writes into WatchLog's file; per-device by construction (`.obsidian/` is never synced); costs one hash per title per poll | **Chosen** |
| Add `lastModified` to WatchLog's `titles[]` entries | Would survive reinstall, but mutates a schema we do not own and could confuse or be stripped by WatchLog | Rejected |
| Sidecar file inside the synced `WatchLog/.sync/` folder | Would be shared across devices, defeating the "what *this* device last observed" semantics | Rejected |

**Change detection (per poll):** `scalarHash(entry) := fnv1a(canonical(entry minus id, dateAdded, history))` — the non-append, "scalar" surface treated as one opaque blob. For every title with a string `id`:
- unknown `id` → seed `{ lastModified: 0, scalarHash }`. **Baseline 0, not `Date.now()`**, so installing the bridge on a device with a pre-existing library does not stamp the whole library as freshly edited and let install order decide every conflict.
- known `id`, `scalarHash` differs from stored → a real local edit: set `lastModified = Date.now()`, store the new hash.
- known `id`, hash equal → untouched.
- `id` gone from `data.json` → keep the state entry (deletions never propagate; the entry can return via a peer).

**Ping-pong prevention (load-bearing):** after a merge commits, `titleState[id]` is set to the **winner's** `lastModified` and the merged `scalarHash`, never `Date.now()`. Otherwise the importing device would read its own merge result back on the next poll, treat it as a local edit, bump the timestamp, and win the next round — an endless cross-device bounce. The merge therefore returns resolved metadata alongside the merged titles, and `importer.ts` persists both in the same commit.

### Decision: Whole-entry LWW on the non-append surface; deterministic `deviceId` tiebreak

For an `id` present on both sides with differing scalars, candidates are ordered by `(lastModified DESC, deviceId ASC)` and the max wins; the winner's **entire** non-append field set replaces the loser's. `dateAdded` and `history` are excluded from this contest and keep their own rules (earliest / union), because those are append-style facts, not edits.

- **Why whole-entry, not field-by-field:** the proposal scopes this to "an edit on device A reaches device B", not a field-level CRDT. Field-level merge would need per-field timestamps (3-5× the state) and still produce entries that never existed on either device. Comparing the scalar surface as one opaque blob also means **unknown WatchLog fields participate automatically** — no allowlist, no diffing, and the unknown-field passthrough decision still holds for every uncontested entry.
- **Why smaller `deviceId` wins ties:** ties mean both sides claim the same instant (both at baseline `0`, or clock skew), so there is no evidence favouring either — only convergence matters. `(lastModified, deviceId)` is a **total order**, so the winner is independent of peer iteration order, which is what makes the merge commutative and idempotent. Ascending was picked arbitrarily and is asserted by a unit test so it cannot drift.
- **Accepted tradeoff:** the winner's field *absences* also win, so if two devices ever run different WatchLog versions, the older one winning a conflict can drop a newer field. Dependencies already assume the same WatchLog on both devices; spike b1 records the real field set. Field-level merge remains an explicit non-goal.

### Decision: Poll-only, 120 s default

Staleness tolerance is minutes and yaos needs its own propagation time, so a 120 s interval (settings range 30 s - 15 min) is far inside budget. Cost per tick is one `adapter.stat()` plus one `adapter.list()` — no reads, no parses, no writes unless a `(mtime,size)` pair changed. Per-title `scalarHash` work happens only inside that changed branch, so the steady-state tick stays O(1) regardless of library size. `vault.on("modify"|"create")` on `WatchLog/.sync/` is registered as a *latency optimization only*; the poll is the correctness backstop on both platforms.

## Data Flow

```
Device A                          yaos blob sync                 Device B
--------                          --------------                 --------
WatchLog data.json
  | (poll: stat -> read -> per-title scalarHash)
  v
titleState.ts  -- bumps lastModified for locally edited ids
  |            (state lives in the BRIDGE's own data.json, never WatchLog's)
  v
export.ts --write--> WatchLog/.sync/A.json  ====>  WatchLog/.sync/A.json
   (titles verbatim + titleMeta sidecar)                    |
                                     (poll/vault event) importer.ts
                                                            |
                        merge.ts (pure: union of ids, LWW scalars, history union)
                                                            |
                                    watchlogIo.ts: backup -> validate -> write
                                                            |
                                              WatchLog data.json (B)
                                                            |
                     persist resolved titleState (winner's lastModified, NOT now)
                                                            |
                                     status bar + "Reload WatchLog data" command
```

### Sequence: one bridge cycle (per device, per tick)

```
scheduler       export/titleState      importer       merge      watchlogIo   WatchLog
   |  tick             |                   |            |            |           |
   |--acquire lock---->|                   |            |            |           |
   |--exportIfChanged()------------------->|            |            |           |
   |   stat(data.json) -> unchanged? -> skip            |            |           |
   |   read+parse -> reconcileTitleState(titles, state) |            |           |
   |      per id: scalarHash differs? -> lastModified = now          |           |
   |      new id? -> seed { lastModified: 0, scalarHash }            |           |
   |   titlesHash != lastHash OR state bumped? -> write .sync/{me}.json          |
   |--importIfChanged()------------------->|            |            |           |
   |            list(.sync/) -> peers != me             |            |           |
   |            stat each -> all unchanged? -> skip cycle            |           |
   |            read+validate peers -------------------->|           |           |
   |                    mergeTitles(local, localState, peers, myDeviceId)        |
   |                      -> { titles, meta, addedIds, changedIds }  |           |
   |                            no change? -> skip write |           |           |
   |                            changed  ->|--backupOnce()---------->|           |
   |                                       |--validate+write-------->|-data.json>|
   |                                       |--readback verify--------|           |
   |                                       |--persist titleState := meta         |
   |                                          (winner's lastModified, NOT now)   |
   |<--release lock------------------------|                         |           |
   |  status bar: "merged N - reload WatchLog"; optional auto-reload attempt     |
```

## Interfaces / Contracts

```ts
// Export file: WatchLog/.sync/{deviceId}.json
interface ExportDoc {
  schema: 1;
  deviceId: string;
  deviceLabel?: string;          // display only, never merge input
  exportedAt: string;            // ISO-8601, diagnostics only, NOT a merge input
  titlesHash: string;            // FNV-1a of canonical(titles); change detection
  titles: Record<string, TitleEntry>;  // keyed by entry.id, values VERBATIM
  titleMeta: Record<string, TitleMeta>; // SIDECAR, keyed by the same id; bridge-owned
  unkeyed?: TitleEntry[];        // entries lacking a string id: diagnostics only, never merged
}

// Bridge-owned per-title metadata. Kept in a sidecar map, never injected into a
// TitleEntry, so exported entries stay byte-identical to WatchLog's own shape.
interface TitleMeta {
  lastModified: number;          // epoch ms; 0 = baseline, never observed to change
  scalarHash: string;            // fnv1a(canonical(entry minus id/dateAdded/history))
}

// Defensive: only `id` is required. Everything else passes through untouched.
type TitleEntry = {
  id: string;
  dateAdded?: string | number;
  history?: HistoryEntry[];
  [k: string]: unknown;          // unknown-field passthrough - never drop what we don't understand
};
type HistoryEntry = { id?: string; [k: string]: unknown };

// Local plugin data (.obsidian/plugins/watchlog-sync-bridge/data.json)
interface BridgeData {
  deviceId: string;
  settings: { pollSeconds: number; autoReloadWatchLog: boolean; deviceLabel?: string };
  lastExport?: { mtime: number; size: number; titlesHash: string };
  titleState: Record<string, TitleMeta>;    // by title id - the LWW clock, bridge-owned
  peerState: Record<string, { mtime: number; size: number }>;   // by filename
  backupTaken: boolean;
  pendingWrite?: { targetHash: string; startedAt: string };     // crash-recovery marker
}
```

**Mirrored surface:** only WatchLog's top-level `titles` array is exported and merged. Every other top-level key in WatchLog's `data.json` (settings, view state, anything unknown) is **read, preserved verbatim, and written back unchanged** — never exported, never overwritten from a peer. This keeps device-local config device-local. Bridge bookkeeping (`titleState`, `deviceId`, hashes) never appears in WatchLog's file; the only fields the bridge reasons about there are `titles` and, within an entry, `id`/`dateAdded`/`history` plus one opaque scalar remainder.

## Merge Algorithm (pure, `src/merge.ts`)

```
mergeTitles(localTitles, localMeta, peers, selfDeviceId)
    -> { titles, meta, addedIds, changedIds }
  byId := Map( localTitles where typeof e.id === "string" -> [e.id, clone(e)] )
  owner:= Map( id -> { lm: localMeta[id]?.lastModified ?? 0, dev: selfDeviceId } )
  keep := localTitles where id is not a string          // untouched, re-appended verbatim
  for peer in peers sorted by peer.deviceId:            // order-independent, see below
    for (id, pe) in peer.titles:
      pm := { lm: peer.titleMeta[id]?.lastModified ?? 0, dev: peer.deviceId }
      if not byId.has(id):
        byId.set(id, clone(pe)); owner.set(id, pm); addedIds += id; continue
      le := byId.get(id); lm := owner.get(id)
      // total order: newer lastModified wins; tie -> lexicographically smaller deviceId
      peerWins := (pm.lm > lm.lm) or (pm.lm == lm.lm and pm.dev < lm.dev)
      winner   := peerWins ? pe : le
      merged   := clone(winner)                         // WHOLE non-append surface, absences included
      merged.id        := id
      merged.dateAdded := earliest(le.dateAdded, pe.dateAdded)  // undefined loses; ties -> equal anyway
      merged.history   := unionHistory(le.history ?? [], pe.history ?? [])
      if canonical(merged) != canonical(le): changedIds += id
      byId.set(id, merged)
      if peerWins: owner.set(id, pm)
  meta := Map( id -> { lastModified: owner[id].lm, scalarHash: scalarHash(byId[id]) } )
  return { titles: [...byId.values(), ...keep] sorted by (dateAdded asc, id asc), meta, ... }

scalarHash(e) := fnv1a(canonical(e minus id, dateAdded, history))
unionHistory(a, b):
  out := clone(a); seen := Set(a.map(historyKey))
  for h in b: k := historyKey(h)
              if not seen.has(k): out.push(clone(h)); seen.add(k)
  return out sorted by (timestampish(h) asc, historyKey asc)

historyKey(h) := (typeof h.id === "string" && h.id !== "") ? "id:" + h.id
                                                           : "c:" + fnv1a(canonical(h))
canonical(v)  := JSON.stringify with recursively sorted object keys  // stable across devices
```

**Why this converges.** `(lastModified, deviceId)` is a total order over candidates, so the scalar winner is the unique max regardless of the order peers are visited; `unionHistory` and `earliest(dateAdded)` are commutative and associative on their own. Peer sorting is therefore belt-and-braces determinism for output ordering, not a correctness crutch. `meta` is derived from the *merged* entry, but `scalarHash` excludes `dateAdded`/`history`/`id`, so `scalarHash(merged) == scalarHash(winner)` — which is exactly what stops the importing device from mistaking its own merge result for a local edit on the next poll.

**Set monotonicity (load-bearing):** an `id` present locally but absent from every peer is never touched, and no branch removes an entry. Deletions therefore cannot propagate — a confirmed v1 decision, not an oversight. Content, by contrast, *is* mutable: a peer with a newer `lastModified` overwrites local scalars. That is the newly confirmed field-edit requirement, not a regression of the "never clobber" rule, which now means precisely: never lose an entry, never lose a `history` event, never move `dateAdded` forward.

Required invariants for tests: idempotent (`merge(merge(x)) == merge(x)`), commutative in peer order, `|result| >= |local|`, no `history` entry ever lost, `dateAdded` never increases, and **fixpoint** — re-running export → merge on both devices with no user edits produces no further change and no `lastModified` bump (the anti-ping-pong property).

## Write Safety for WatchLog's `data.json`

Obsidian's `DataAdapter` offers no cross-platform atomic replace we can rely on, so safety comes from **backup + validate + verify + a crash marker**, not from an atomic primitive.

1. **Backup once (and whenever missing):** copy the raw bytes to `.obsidian/plugins/watchlog-sync-bridge/backups/watchlog-data.{ISO}.json`, keep the newest 3. Backups live in our own plugin dir — under `.obsidian/`, so yaos never syncs them and they never propagate a stale index.
2. **Refuse to act on garbage:** if WatchLog's `data.json` is missing, unparseable, or `titles` is not an array, abort the whole cycle — no export, no write — and surface one throttled `Notice`.
3. **Validate before commit:** serialize the merged document, re-`JSON.parse` it, and assert `titles` is an array, `count >= countBefore`, and every pre-existing local `id` is still present. Any failure aborts the write.
4. **Staging + marker:** write the validated text to `.../watchlog-sync-bridge/pending-data.json`, set `pendingWrite = { targetHash, startedAt }` in our own data, then `adapter.write()` the real target, then read it back and compare its hash. On success persist the merge's resolved `titleState` **and** clear the marker and the staging file. The residual crash window is one `adapter.write()` wide and is documented in the README. If the write succeeds but persisting `titleState` does not, the next poll simply sees changed scalars and re-stamps them as a local edit — noisier than ideal, never lossy.
5. **Crash recovery on load:** if `pendingWrite` is set, read WatchLog's `data.json`. Parses and hash matches -> clear marker. Parses but hash differs -> clear marker and let the next cycle re-merge. **Fails to parse -> restore from `pending-data.json` if it validates, else from the newest backup**, then `Notice` the user.
6. **Single-flight:** the scheduler holds a lock so export, import, and manual commands never overlap. Skip the write entirely when the merge produced no change (the common case).

## Verification Spike (early implementation task, throwaway)

Shipped as a **dev-only command** (`Dev: run bridge spike`, stripped before the v1 release tag) rather than a Node script, because item (a) must be observed on mobile too, inside a real Obsidian process.

| # | Exact observation | Settles |
|---|---|---|
| a1 | With WatchLog's view open on desktop, inject one synthetic title via `adapter.write()`; does the list update **without** reload? Record yes/no and latency. | (a) live pickup |
| a2 | Register our own `vault.on("raw", ...)`; does it fire for that adapter-originated write? Same probe on mobile. | (a) mechanism + platform split |
| a3 | Does `app.plugins.disablePlugin/enablePlugin("watchlog")` exist and refresh the view? | auto-reload UX viability |
| b1 | Dump `Object.keys()` + value types of a real `titles[0]` and of `titles[0].history[0]`. | (b) history de-dup key |
| b2 | Is there any modification-time-like field on an entry (not `dateAdded`)? | whether v2 can retire the bridge-tracked clock |
| c1 | Confirm two peer files under `WatchLog/.sync/` both survive a yaos round trip. | blob-sync assumption |

| Spike outcome | Design impact |
|---|---|
| a1/a2: `"raw"` fires and UI updates live (desktop) | **No v1 change.** Record as an optional v2 latency/UX win (suppress the reload prompt on desktop). Manual-reload fallback still ships. |
| a1/a2: no live pickup (either platform) | **No v1 change** — already the assumed worst case. Reload UX becomes the primary path. |
| a3: `app.plugins` cycle works | Keep `autoReloadWatchLog` default ON, still feature-detected and try/catch-wrapped. |
| a3: unavailable/ineffective | Default it OFF and hide the toggle; status bar + guidance only. |
| b1: `history` entries have a stable string `id` | `historyKey` takes its `id:` fast path — already in the algorithm, no change. |
| b1: no stable id | Content-hash fallback (already the default). Document that byte-identical duplicate events collapse into one. |
| b2: a real `lastModified`/`updatedAt` exists | **No v1 change** — the bridge-tracked clock must work without one anyway. File a v2 item to seed/replace `titleState.lastModified` from WatchLog's own field, which would also survive a bridge reinstall. |
| b2: entry has fields that change on every WatchLog render (view state, cached art) | **Adjust before implementing**: such fields would bump `lastModified` on every poll. Exclude them from `scalarHash` by name and record why. |
| b1: `titles` is not an array of `id`-bearing objects | **BLOCKER** — stop and revisit export format and merge before implementing them. |
| c1: peer files clobber each other | **BLOCKER** — the blob-sync assumption is wrong; escalate before continuing. |

## WatchLog-Notice Fallback UX

- **Status bar item** (`WatchLog ⟲`): `synced HH:MM` / `+N new, M updated - reload WatchLog` / `error` (`addedIds` and `changedIds` from the merge). Clicking runs the reload command.
- **Commands:** `Reload WatchLog data` (feature-detected `disablePlugin`+`enablePlugin` cycle, wrapped in try/catch; on failure shows a `Notice` telling the user to reopen the WatchLog view or restart Obsidian), `Export now`, `Import and merge now`, `Restore WatchLog data.json from backup`.
- **Notice** after a merge that added or changed entries only, throttled to one per cycle. Silent when nothing changed.
- **README** documents the manual reload as expected v1 behavior, per the confirmed decision that it is not a shipping blocker.

## File Changes

| File | Action | Description |
|---|---|---|
| `manifest.json` | Create | id `watchlog-sync-bridge`, `isDesktopOnly: false`, `minAppVersion` |
| `versions.json`, `package.json`, `tsconfig.json` | Create | BRAT/version metadata, deps, strict TS |
| `esbuild.config.mjs` | Create | CJS bundle -> `main.js`, `external: ["obsidian", "electron", ...builtins]`, es2018, prod minify |
| `.github/workflows/release.yml` | Create | On `v*` tag: build, create GitHub release with `main.js` + `manifest.json` |
| `main.ts` | Create | Lifecycle, wiring, commands, status bar, settings tab registration |
| `src/{identity,watchlogIo,export,importer,merge,titleState,hash,scheduler,settings,types}.ts` | Create | Per the module table |
| `tests/{merge,titleState,hash,identity}.test.ts` | Create | Vitest, pure-module coverage |
| `vitest.config.ts` | Create | Aliases `obsidian` to a stub so pure modules test headlessly |
| `README.md` | Create | Install via BRAT, manual-reload caveat, rollback/restore instructions |

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `mergeTitles`, `reconcileTitleState`, `scalarHash`, `unionHistory`, `historyKey`, `canonical`, `fnv1a`, `deviceId` sanitizing | Vitest on pure modules; property-style tests for idempotence, peer-order commutativity, `|result| >= |local|`, no-history-loss, `dateAdded` never increasing, unknown-field passthrough on uncontested entries, and **no-deletion-propagation** |
| Unit (LWW) | newer `lastModified` wins scalars both directions; equal timestamps resolve by smaller `deviceId` (both devices agree); new ids seed `lastModified: 0` not `now`; a poll with no content change bumps nothing; merged output re-fed to `reconcileTitleState` produces **zero** bumps (anti-ping-pong fixpoint) | Vitest with an injected clock; `merge` + `titleState` composed as one simulated two-device round trip |
| Integration | export -> peer file -> import -> merged `data.json` + persisted `titleState`; crash-marker recovery; corrupt-input abort; no-op skip | In-memory fake `DataAdapter` driving `export.ts`/`importer.ts`/`watchlogIo.ts` |
| E2E (manual) | Two real devices + yaos: add on A, appears on B within one cycle; **edit a rating/notes field on A, the edit lands on B and does not bounce back**; concurrent adds both survive; delete on A does not delete on B | Scripted manual checklist in the README; success criteria from the proposal |

Strict TDD applies: RED tests first for every `merge.ts` invariant. `openspec/config.yaml` records no test runner yet, so scaffolding vitest is a prerequisite task before implementation work.

## Threat Matrix

N/A — no routing, shell command, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The one adversarial-input surface (peer export JSON arriving over sync) is handled as an explicit design requirement: peer files are schema-validated (`schema === 1`, `titles` is a plain object, each value has a string `id`, and every `titleMeta` value has a finite non-negative numeric `lastModified`), size-capped, and rejected wholesale on parse failure; a rejected peer never blocks the cycle or reaches `data.json`. A missing or malformed `lastModified` degrades to baseline `0` rather than to `Date.now()`, so a corrupt or hostile peer can never win a scalar conflict it did not legitimately win.

## Migration / Rollout

No migration — greenfield; nothing has shipped, so `titleMeta` is part of the original `schema: 1` shape rather than a version bump. `ExportDoc.schema` is versioned so a future format can be detected; v1 ignores any export whose `schema !== 1`, and treats an absent `titleMeta` map as all-baseline (`0`). On first run `titleState` is empty, so it is seeded at baseline from whatever `data.json` already holds — no backfill pass and no synthetic edit wave. Rollout is BRAT install on both devices; first run backs up `data.json` before its first write.

## Non-Goals (reaffirmed)

- No modification, fork, vendoring, or patching of yaos or WatchLog source (including `exclude.ts`).
- **No writes of bridge-invented fields into WatchLog's `data.json`.** The `lastModified` clock lives only in the bridge's own plugin data and in the export sidecar.
- **No deletion propagation.** The merge never removes an `id`.
- **No field-level merge.** Unknown/untracked WatchLog fields are still passthrough-preserved, but they participate in conflict resolution only as part of one opaque `scalarHash`-compared blob — whole-entry LWW on the non-append surface, no per-field timestamps, no conflict UI.
- No stale-device-file cleanup or expiry (2-3 devices, confirmed).
- No desktop `"raw"`-based low-latency triggering in v1 (confirmed out of scope, not merely deferred).
- No append-only changelog export format or general-purpose sync engine.

**Formerly a non-goal, now in scope:** scalar field edits (rating, notes, ...) on a title that already exists on both devices. The earlier "local-wins on scalar conflicts" limitation is superseded by the user-confirmed field-edit decision in `proposal.md`.

## Risks Introduced by Field-Edit Propagation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Clock skew between devices misorders two real edits | Med | Only matters for edits inside the skew window on the *same* title; ties fall back to the deterministic `deviceId` rule so both devices still converge. Documented in the README, not solved with a vector clock (out of scope for 2-3 devices). |
| Merge result read back as a local edit → cross-device ping-pong | Med (if implemented naively) | Persist the winner's `lastModified` with the merge; fixpoint invariant is a required RED test. |
| Bridge reinstall wipes `titleState`, resetting every title to baseline `0` | Low | Baseline `0` loses to any real edit on a peer, so the reinstalled device cannot spuriously win; worst case a genuine pre-reinstall edit is forgotten. Same reinstall tradeoff already accepted for `deviceId`. |
| A field WatchLog rewrites on every render inflates `lastModified` | Low-Med | Spike b2 inspects the real entry shape; such fields get excluded from `scalarHash` by name before implementation. |
| Whole-entry LWW drops a field the winning device's WatchLog build does not know | Low | Dependencies already require the same WatchLog on both devices; field-level merge is an explicit non-goal. |

## Open Questions

- [ ] Spike b1: real `history` entry shape — content-hash fallback is designed in, so this refines rather than blocks.
- [ ] Spike b2: whether any entry field is volatile enough to need exclusion from `scalarHash` (affects noise, not correctness).
- [ ] Spike a3: whether `app.plugins.disablePlugin/enablePlugin` is available and effective (determines the `autoReloadWatchLog` default only).
- [ ] `minAppVersion` floor — pick the lowest version exposing the `DataAdapter` methods used; confirm during scaffolding.

# Tasks: WatchLog Index Bridge

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1900-2000 total across the whole change |
| 400-line budget risk | High (whole change); each individual work unit stays Medium or below |
| Chained PRs recommended | Yes |
| Suggested split | PR1 -> PR2 -> PR3 -> PR4 (4 units, split from the 3-unit example to keep every slice under the 800-line budget) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Rationale for 4 units instead of 3: grouping write-safety + lifecycle + notify + packaging into one PR estimates ~990 lines (over the 800 budget). Split into PR3 (write-safety: `watchlogIo.ts` + `importer.ts`, ~500 lines) and PR4 (lifecycle + notify UX + packaging + manual validation, ~470 lines) so no single PR exceeds budget. `auto-chain` means no user prompt is required; proceed with PR1 first using stacked-to-main (each PR is independently testable via vitest and mergeable in order; no tracker-branch coordination needed for a 2-3 device personal-scale plugin).

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|------------------|--------------------|
| 1 | Scaffold + spike + pure cores (`hash.ts`, `titleState.ts`) | PR1 | `npx vitest run tests/hash.test.ts tests/titleState.test.ts` | Manual: load plugin in real Obsidian desktop+mobile, run "Dev: run bridge spike", record a1-a3/b1/b2/c1 | Revert removes scaffold + spike command + 2 pure files; spike does only a throwaway synthetic write, no persistent state |
| 2 | `export.ts` + `merge.ts` (core merge logic) | PR2 | `npx vitest run tests/merge.test.ts tests/export.test.ts` | N/A — pure/fake-adapter unit tests only; not yet wired to the live scheduler | Revert removes `src/merge.ts`, `src/export.ts`, tests; no production write path enabled yet |
| 3 | `watchlogIo.ts` (write-safety) + `importer.ts` | PR3 | `npx vitest run tests/watchlogIo.test.ts tests/importer.test.ts` | Manual: fake-adapter suite covers backup/crash-marker; smoke-test writes against a throwaway copy of `data.json` before merge | Revert removes both files + tests; not yet wired into `main.ts`, so no live write path is enabled by this PR alone |
| 4 | Lifecycle (`identity`/`scheduler`/`settings`/`main.ts` wiring) + notify UX + packaging + manual validation | PR4 | `npx vitest run tests/identity.test.ts` (scheduler/settings/wiring verified manually) | Manual: two real devices + yaos, full Success Criteria checklist (Phase 11) | Uninstall via BRAT, restore `data.json` from bridge backup, delete `WatchLog/.sync/`; yaos propagates the deletion, nothing in yaos/WatchLog modified |

## Spike Gating (read before Phase 3+)

Phase 2 (verification spike) MUST complete and its findings be recorded before: Phase 4 (`titleState.ts` scalarHash exclusions - gated on spike b2), Phase 5 (`merge.ts` history de-dup key default - gated on spike b1, dual-path already designed so no branching, only confirms which path is primary), and Phase 9 (`autoReloadWatchLog` default and reload-fallback framing - gated on spike a1/a2/a3). If spike b1/c1 hit the documented BLOCKER outcomes (`titles` not an array of `id`-bearing objects, or peer files clobber under yaos), STOP after Phase 2 and escalate before starting Phase 4.

## Phase 1: Scaffold (PR1)

- [x] 1.1 Create `package.json`, `tsconfig.json` (strict), `manifest.json` (id `watchlog-sync-bridge`, `isDesktopOnly: false`), `versions.json`
- [x] 1.2 Create `esbuild.config.mjs`: bundle `main.ts` -> `main.js`, `external: ["obsidian","electron",...builtins]`, es2018, prod minify
- [x] 1.3 Install vitest; create `vitest.config.ts` aliasing `obsidian` to a stub module
- [x] 1.4 Add npm scripts: `test`, `build`, `typecheck`
- [x] 1.5 Verify harness: `npx vitest run` executes with 0 tests, no errors (proves TDD is now enforceable)

## Phase 2: Verification Spike (PR1, gates Phase 4/5/9)

- [x] 2.1 Implement dev-only command `Dev: run bridge spike` in `main.ts` per design.md's probe table (a1-a3, b1, b2, c1)
- [x] 2.2 Run on desktop: record a1 (live UI update on `adapter.write()`), a2 (`vault.on("raw")` fires?), a3 (`disablePlugin`/`enablePlugin` reload works?) — done 2026-09-07, see spike-findings.md (a1/a2/a3 all confirmed)
- [x] 2.3 Run on mobile: record a2 (raw event, expected absent) — done 2026-09-07 (Pixel 8): **a2 came back TRUE, not absent as expected** — see spike-findings.md and the corrected constraint in CLAUDE.md
- [x] 2.4 Record b1 (real `history[0]` shape / stable id) and b2 (any volatile/modification-time-like field) into `spike-findings.md` — done 2026-09-07 on both desktop and mobile (b2 exclusions applied to titleState.ts; b1's stable-history-id sub-question stays open — sampled entry had no history at all on either device)
- [ ] 2.5 Record c1: two peer files under `WatchLog/.sync/` both survive a yaos round trip — **HUMAN ACTION ITEM, still pending: the original c1 probe turned out unable to test this (same filenames written locally by whichever device runs it, regardless of yaos) — see spike-findings.md's c1 section for the proposed replacement test (two uniquely-named files, one per device, checked cross-device)**
- [x] 2.6 Decision gate: apply design.md's outcome table — confirm scalarHash exclusions (-> Phase 4), history de-dup default path (-> Phase 5), `autoReloadWatchLog` default (-> Phase 9); STOP and escalate only on the b1/c1 BLOCKER outcomes — done 2026-09-07: Phase 4 gate applied; Phase 9 gate RESOLVED for both platforms (WatchLog refreshes live on desktop AND mobile, simpler than anticipated — see spike-findings.md); Phase 5 gate stays unconfirmed-but-non-blocking (dual-path already implemented); no BLOCKER outcome hit. Only 2.5's replacement test remains open, and it doesn't block starting Phase 9's code.

## Phase 3: hash.ts (pure) (PR1)

- [x] 3.1 RED: tests for `canonical()` (recursive key-sort stability) and `fnv1a()` (deterministic digest) — design.md `hash.ts` contract
- [x] 3.2 GREEN: implement `src/hash.ts`
- [x] 3.3 REFACTOR: none expected; confirm no dependency on Obsidian types (found and fixed an esbuild es2018-target/BigInt-literal incompatibility instead — see hash.ts comment)

## Phase 4: titleState.ts (pure, second TDD core) (PR1)

- [x] 4.1 RED: unknown id seeds `lastModified: 0` (spec: "Newly observed titles seed lastModified at baseline 0")
- [x] 4.2 RED: changed `scalarHash` bumps `lastModified` to now, stores new hash (spec: "Editing a title's rating updates its tracked lastModified")
- [x] 4.3 RED: unchanged hash leaves `lastModified` untouched (spec: "Unchanged titles do not get their lastModified bumped")
- [x] 4.4 GREEN: implement `src/titleState.ts` `reconcileTitleState()` — **PROVISIONAL**: spike 2.6 has not run (Phase 2 requires a human on real Obsidian devices), so the scalarHash exclusion list is empty/default per spec.md's documented behavior, not derived from real spike b2 data. Must be revisited once spike-findings.md records b2. See `SCALAR_HASH_EXCLUDED_FIELDS` comment in `src/titleState.ts`.
- [x] 4.5 REFACTOR: extract exclusion list as a named const with a comment citing the spike finding (const is named and commented, but currently empty pending real spike data — see 4.4 note)

## Phase 5: merge.ts (pure, core) (PR2)

- [x] 5.1 RED: per-id union, concurrent adds both survive (spec: Per-ID Union Merge scenarios)
- [x] 5.2 RED: history union + de-dup, re-merge does not duplicate, using spike 2.6's confirmed de-dup key path (spec: History Union and De-duplication scenarios)
- [x] 5.3 RED: `dateAdded` earliest-wins (spec: "dateAdded uses earliest-wins semantics")
- [x] 5.4 RED: LWW scalar resolution incl. `deviceId` tiebreak, winner's `lastModified` persisted not `now` (spec: Cross-Device Propagation of Scalar Field Edits, all 5 scenarios)
- [x] 5.5 RED: deletion non-propagation, edit-not-mistaken-for-delete (spec: Deletion Non-Propagation, all 3 scenarios)
- [x] 5.6 RED: invariants — idempotent, commutative peer order, `|result| >= |local|`, fixpoint anti-ping-pong (design.md "Required invariants")
- [x] 5.7 GREEN: implement `src/merge.ts` `mergeTitles()` per design.md algorithm
- [x] 5.8 REFACTOR: extract `historyKey`/`unionHistory` helpers (implemented as named helpers from the start; confirmed no further extraction needed)

## Phase 6: export.ts (PR2)

- [x] 6.1 RED: export snapshot matches local titles, never writes `data.json` (spec: Export Trigger and Content, "Export never mutates")
- [x] 6.2 RED: export write is atomic (temp-then-rename) (spec: Export Write Integrity)
- [x] 6.3 GREEN: implement `src/export.ts` (`ExportDoc` build, change detection, own peer file write)
- [x] 6.4 REFACTOR: cleaned up an awkward hash-helper indirection introduced during GREEN (inlined `fnv1a(canonical(...))` directly instead of a wrapper function) — no other refactor needed

## Phase 7: watchlogIo.ts — write-safety (PR3)

- [x] 7.1 RED (fake `DataAdapter`): backup created before first write (spec: "Backup created before first write")
- [x] 7.2 RED: atomic write survives mid-write crash simulation (spec: "Atomic write survives a mid-write crash")
- [x] 7.3 RED: invalid merge result never committed, failure logged (spec: "An invalid merge result is never committed")
- [x] 7.4 GREEN: implement `src/watchlogIo.ts` (read/validate/backup/atomic-write, crash-marker per design.md steps 3-5)
- [x] 7.5 REFACTOR: consolidate fake-adapter fixtures shared with Phase 8 (`tests/fakeAdapter.ts`, used by both watchlogIo.test.ts and importer.test.ts)

## Phase 8: importer.ts (PR3)

- [x] 8.1 RED: title added on device A appears after import (spec: "Title added on device A appears on device B")
- [x] 8.2 RED: scalar edit propagates and does not bounce back (spec: "Scalar field edited... propagates", ping-pong scenario)
- [x] 8.3 RED: malformed peer JSON skipped, logged, no crash (spec: "Malformed peer export does not crash the plugin")
- [x] 8.4 GREEN: implement `src/importer.ts` (discover peers, drive merge, commit via `watchlogIo`, persist resolved `titleState`)
- [x] 8.5 REFACTOR: none expected — helpers (`validatePeerDoc`, `normalizeLastModified`, `normalizeScalarHash`, `isSelfExport`) were extracted as named functions from the start; confirmed no further extraction needed

## Phase 9: identity.ts + scheduler.ts + settings.ts + main.ts wiring + notify UX (PR4, gated on spike 2.6 a1/a2/a3)

- [x] 9.1 RED: `deviceId` persists across restarts, filename sanitized to `[a-z0-9-]{1,40}` (spec: Device Identity scenarios)
- [x] 9.2 GREEN: implement `src/identity.ts`
- [x] 9.3 GREEN: implement `src/scheduler.ts` (single-flight lock, poll timer, 120s default, 30s-15min range) (spec: Poll Scheduler scenarios) — verify with fake timers where feasible, else manual
- [x] 9.4 GREEN: implement `src/settings.ts` + settings tab (poll interval, export path) (spec: User-Configurable Settings)
- [x] 9.5 GREEN: wire `main.ts`: lifecycle, commands (`Reload WatchLog data`, `Export now`, `Import and merge now`, `Restore from backup`), status bar; set `autoReloadWatchLog` default per spike a3 finding
- [x] 9.6 GREEN: apply spike a1/a2 finding — desktop auto-refresh optimization if confirmed, else reload-fallback-only messaging — RESOLVED simpler than anticipated: both a1/a2 confirmed live auto-refresh on desktop AND mobile (spike-findings.md), so no platform branch was needed; `DEFAULT_SETTINGS.autoReloadWatchLog` defaults to `false` and the bridge never auto-triggers the disable/enable cycle, which is wired only as the manual "Reload WatchLog data" command

## Phase 10: Packaging (PR4)

- [x] 10.1 Create `.github/workflows/release.yml` (tag-triggered build + GitHub release of `main.js` + `manifest.json`)
- [x] 10.2 Write `README.md`: BRAT install, manual-reload caveat, rollback/restore instructions, spike findings summary
- [x] 10.3 Strip the `Dev: run bridge spike` command before tagging v1 (completes Phase 2 gate)

## Phase 11: Manual Validation (PR4, post-merge)

- [ ] 11.1 Two-device pass against proposal.md Success Criteria: add propagates, edit propagates without bounce-back, concurrent adds survive, history/dateAdded preserved, desktop+mobile parity, no yaos/WatchLog source modified

# Verification Spike Findings

Status: **a1/a2/a3/b1/b2 fully confirmed on both desktop and mobile
(2026-09-07, real devices: Linux desktop + Pixel 8).** Only c1 (the real
cross-device yaos round trip) remains open — the spike's own c1 probe design
turned out unable to test it (see c1 section below); a manual alternative
check is proposed there instead.

See `design.md`'s "Verification Spike" section for the full probe table and
outcome-to-design-impact mapping, and `tasks.md` Phase 2 (2.2-2.6) for the
checklist this file satisfies.

## a1 — Desktop live UI update on `adapter.write()`

- Result: **CONFIRMED, live, no reload needed.** `adapter.write()` to
  WatchLog's `data.json` triggered WatchLog's own `dataChangeListener` ->
  `refreshActiveTab()` -> `render()` chain synchronously — observed directly
  as a stack trace in WatchLog's own code reacting to the write (see note
  below). No app restart or plugin toggle was needed.
- Latency: write itself completed in 9ms (`a1_writeCompletedAt`); the raw
  event + WatchLog's live re-render fired within the same tick.
- Side note (not a bridge bug): the live re-render threw an uncaught
  `TypeError` inside WatchLog's own `calcTimeWatched` because the spike's
  throwaway synthetic title (`id`/`title`/`dateAdded`/`history` only) lacks
  fields WatchLog's renderer expects on a real entry (e.g. `watchedEpisodes`/
  `episodeDuration`). This is a pre-existing WatchLog edge case triggered by
  an intentionally minimal probe entry, not something our bridge causes in
  real usage — real entries our merge/export path handles always originate
  from a real WatchLog entry with full fields. The synthetic title was
  reverted immediately after the write (see `main.ts`'s `runBridgeSpike`),
  so no permanent data was affected.

## a2 — `vault.on("raw", ...)` fires for the adapter-originated write

- Desktop result: **CONFIRMED true** (`a2_rawFired: true`). This is also the
  evidence path for a1 — WatchLog's own refresh chain is very likely wired
  off this same event.
- Mobile result (Pixel 8, real Obsidian mobile app): **CONFIRMED true**
  (`a2 "raw" event fired: true`). This contradicts this project's own
  documented assumption in `CLAUDE.md` that `"raw"` is desktop-only — see
  the correction made there 2026-09-07. Likely explanation: `"raw"` (or an
  equivalent internal notification) fires reliably for a write that
  originates **from inside the running app** via `adapter.write()`, which is
  the only way this bridge ever writes `data.json`; the original
  desktop-only claim probably only holds for genuinely externally-originated
  filesystem changes (e.g. a native sync daemon writing outside Obsidian's
  process), which isn't a path this project's write flow ever takes.
- Mobile write latency: 13ms (`a1_writeCompletedAt` equivalent on mobile).

## a3 — `app.plugins.disablePlugin`/`enablePlugin` reload cycle

- Desktop: **CONFIRMED true** (`a3_pluginsApiAvailable: true`).
- Mobile (Pixel 8): **CONFIRMED true** as well.
- Effective (view refreshes after cycle): not separately tested — moot on
  both platforms now that a1/a2 confirm WatchLog refreshes live on both
  without any disable/enable cycle. The API's availability on both platforms
  still makes it a good manual "Reload WatchLog data" fallback/escape-hatch
  command for Phase 9, just not the default/primary path anymore.

## b1 — Real `titles[0]` and `history[0]` shape

- `titles[0]` keys (30 total, desktop sample): `id, title, type, status,
  priority, review, rating, notes, dateStarted, dateFinished, dateAdded,
  dateModified, totalEpisodes, episodeDuration, releaseDate, externalLink,
  seasons, watchedEpisodes, favorite, posterUrl, trailerUrl,
  manualTrailerUrl, director, cast, communityRating, communityVotes,
  communitySource, communityRatingLastFetched, manualPosterUrl, anilistId`.
- Mobile sample (same vault, synced via yaos): also 30 fields, same "no
  history entries found on sample" result — consistent with desktop, as
  expected for the same underlying `data.json` content.
- `history[0]` keys/types: **the sampled entry had no `history` field at
  all** ("no history entries found on sample") — not even an empty array.
  Confirms `history` is genuinely optional on real WatchLog entries, not
  just possibly-empty. Matches the defensive `local.history ?? []` /
  `peer.history ?? []` handling already in `src/merge.ts` — no code change
  needed for this finding.
- Stable per-entry history id present: not yet observed (no entry with
  history was sampled on either device). Still open — revisit if/when a
  title with real history is sampled.

## b2 — Any modification-time-like field other than `dateAdded`?

- Result: **YES — two candidates found**: `dateModified` (string) and
  `communityRatingLastFetched` (string). Both are populated by WatchLog's
  own background behavior (re-render / community metadata refresh), not by
  a user edit, so including them in `scalarHash` would make the hash change
  on every refresh cycle regardless of real content changes.
- Action taken: added both to `SCALAR_HASH_EXCLUDED_FIELDS` in
  `src/titleState.ts`, with two new regression tests in
  `tests/titleState.test.ts` (RED confirmed failing for the right reason,
  then GREEN after the fix) — full suite 58/58 passing, typecheck clean.

## c1 — Two peer files under `WatchLog/.sync/` survive a yaos round trip

- Result: **INCONCLUSIVE BY DESIGN — the probe itself cannot test this.**
  `main.ts`'s c1 probe always writes files named `spike-device-a.json` and
  `spike-device-b.json` **locally, regardless of which device runs it**, then
  immediately lists them back. Both the desktop run and the mobile run each
  showed those exact 2 filenames — but that only proves a single device can
  write-then-list its own files, which is trivially true and has nothing to
  do with yaos. It does NOT prove either file actually crossed devices via
  yaos sync. This is a design gap in the spike (caught 2026-09-07 while
  reviewing the mobile results), not a positive c1 finding — do not read
  "2 files present" as "sync confirmed."
- Also worth noting: this same-filename-on-every-device shape doesn't even
  match production risk — the real design (`export.ts`) always writes
  `WatchLog/.sync/{deviceId}.json`, a unique filename per device, so the
  genuine "do peer files clobber" concern the c1 BLOCKER outcome describes
  cannot occur in production the way this probe modeled it (same filename
  from two writers). The real open question is simpler: does yaos actually
  sync a plain file under a normal vault folder both ways at all — which
  `CLAUDE.md`'s constraints already assert should work (yaos's documented
  blob-sync path for non-markdown files), just not yet verified live on this
  vault.
- **Proposed real test (manual, not spike-based):** on desktop, create a
  small distinct file, e.g. `WatchLog/.sync/desktop-check.txt` containing
  `hello from desktop`. Let yaos sync. On mobile, confirm that exact file
  and content appears under `WatchLog/.sync/`. Then reverse: create
  `mobile-check.txt` on mobile, confirm it lands on desktop. This directly
  exercises the real blob-sync path with unique filenames, matching
  production, instead of the spike's flawed shared-filename probe.
- Status: still pending — awaiting the manual two-way file check above.

## Decision Gate (tasks.md 2.6)

- Phase 4 gate (b2, scalarHash exclusions): **APPLIED** — see action above.
- Phase 5 gate (b1, history de-dup key default path): still open — b1 above
  didn't sample an entry with history, so which de-dup path
  (`historyKey`'s id-based fast path vs. content-hash fallback) real data
  exercises most often is still unconfirmed. `merge.ts`'s dual-path
  implementation already handles both per design.md, so this is not
  blocking, just unconfirmed which path is primary.
- Phase 9 gate (a1/a2/a3, `autoReloadWatchLog` default and reload-fallback
  framing): **RESOLVED for both platforms.** a1+a2+a3 are all confirmed on
  desktop AND mobile — WatchLog refreshes live on both with no manual reload
  needed. `autoReloadWatchLog` can default to "no action needed" on both
  platforms; the disable/enable-plugin cycle (a3, confirmed available on
  both) becomes a documented fallback/escape-hatch command, not the default
  behavior. This is a simpler outcome than tasks.md originally anticipated
  (it expected mobile to need the fallback as its primary path).
- BLOCKER check: neither documented BLOCKER condition was hit (`titles` is
  an array of `id`-bearing objects; no clobbering was observed, though c1's
  own probe couldn't actually test clobbering — see above) — no escalation
  needed. Phase 9 can proceed; only the manual two-way `WatchLog/.sync/`
  file check (c1's replacement test above) remains outstanding, and it is
  not a hard blocker for starting Phase 9's lifecycle-wiring code (which
  doesn't depend on c1), just for closing out Phase 2 fully and for PR4's
  final two-device manual validation (Phase 11).

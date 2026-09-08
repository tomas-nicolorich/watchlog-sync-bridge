# Proposal: WatchLog Index Bridge

## Intent

WatchLog stores its whole library in `.obsidian/plugins/watchlog/data.json`. yaos never syncs `.obsidian/` (hardcoded, and Obsidian's `Vault` API cannot surface config-dir paths at all), so a title added on one device never appears on another even though its markdown note syncs fine. Ship a standalone companion plugin that bridges that one index file over yaos's existing, unmodified blob-sync path.

## Scope

### In Scope
- Poll-based export of the local `titles` index to a per-device, vault-visible JSON file (e.g. `WatchLog/.sync/{deviceId}.json`), read via `adapter.read()`.
- Import: watch peer export files with normal `vault.on("modify"|"create")` plus polling (mobile-safe), merge per `id` into local `data.json` via `adapter.write()`.
- Merge policy: per-`id` union, `history` union with de-dup, earliest `dateAdded` wins, scalar-field edits merged last-write-wins using a per-title `lastModified` timestamp that this plugin tracks itself (see Confirmed Product Decisions — field edits must propagate, and WatchLog exposes no modification timestamp of its own).
- **Verification spike inside this change** (early task, throwaway/manual, discarded after): (a) does `adapter.write()` re-trigger WatchLog's desktop `"raw"` listener and update its UI live; (b) the real `history` entry shape and a stable de-dup key. Findings may adjust, but are not expected to invalidate, the v1 approach — it was chosen to be correct under the worst case for both.
- Documented "reopen WatchLog view / reload" fallback on both platforms.
- BRAT-installable release (manifest, versions, build).

### Out of Scope
- Forking, vendoring, or patching yaos or WatchLog (including `exclude.ts`).
- A general-purpose sync engine, conflict UI, or syncing anything but this index.
- Desktop `"raw"`-based low-latency triggering (possible v2 after the spike).
- Append-only changelog export format (v2 if `history` fidelity demands it).

## Capabilities

### New Capabilities
- `index-export`: read WatchLog `data.json`, emit a normalized per-device export blob.
- `index-merge`: discover peer exports and merge entries back into local `data.json`.
- `bridge-lifecycle`: device identity, poll scheduler, settings, failure/logging behavior.

### Modified Capabilities
None.

## Approach

Per exploration.md's recommendation: poll-based triggering on both platforms (mirrors yaos's `diskIndex.ts`), per-device export files to avoid write-clobber under whole-file last-writer-wins blob sync, non-destructive union merge, and pessimistic assumptions about WatchLog noticing external writes. The spike runs before merge/notification design is frozen.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `manifest.json`, `main.ts`, build config | New | Plugin scaffold + esbuild |
| `src/export`, `src/merge`, `src/poll` | New | Bridge logic |
| `WatchLog/.sync/*.json` | New (runtime) | Per-device export blobs |
| `.obsidian/plugins/watchlog/data.json` | Modified (runtime) | Merge target, external file |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| WatchLog does not notice merged `data.json` | High | Spike; documented manual-reload fallback |
| `history` de-dup key unstable/absent | Med | Spike inspects real data; fall back to content hash |
| yaos blob sync not whole-file LWW | Med | Per-device files are safe either way |
| Corrupting WatchLog's `data.json` | Low | Backup before first write; atomic write; validate JSON |

## Rollback Plan

Disable/uninstall the plugin via BRAT. Restore `data.json` from the pre-write backup the plugin keeps. Delete `WatchLog/.sync/` and let yaos propagate the deletion. Nothing in yaos or WatchLog is modified, so removal is complete.

## Dependencies

- yaos installed and syncing the vault on all devices.
- WatchLog installed with an existing `data.json`.
- BRAT for install/update.

## Confirmed Product Decisions

Answered by the user directly, superseding the proposal's stated assumptions
(which happened to match):

- **Staleness**: minutes-scale delay after yaos sync is acceptable. v1 stays
  purely poll-based; the desktop `"raw"`-event optimization stays out of
  scope (confirmed, not just deferred).
- **Manual reload**: acceptable for v1 if WatchLog doesn't auto-notice the
  merged `data.json`. Not a shipping blocker.
- **Deletions**: v1 is additions/updates only. Deleting a title on one
  device does NOT remove it on others. Deletion propagation (tombstones) is
  explicitly out of scope, not just unaddressed.
- **Device lifecycle**: 2-3 devices, no cleanup/expiry mechanism for stale
  per-device export files in v1.
- **Field edits** (supersedes design.md's earlier "local-wins on scalar
  conflicts" draft): editing a field (rating, notes, etc.) on a title that
  already exists on both devices MUST propagate, not just brand-new titles.
  Since WatchLog's own `data.json` carries no per-entry modification
  timestamp, the bridge plugin tracks its own `lastModified` per title
  (updated whenever a poll observes that title's content changed since the
  plugin's last-known snapshot) and uses it for last-write-wins merge on
  scalar fields. This is new in-scope work for `sdd-design`/`sdd-spec` to
  formalize — it was not part of the original exploration/design draft.

## Success Criteria

- [ ] A title added on device A appears in WatchLog on device B (reload allowed) within one poll cycle after yaos sync.
- [ ] Merges never drop `history` entries or reset `dateAdded`.
- [ ] Concurrent adds on two devices both survive.
- [ ] Editing a scalar field on a title that exists on both devices propagates to the other device (via bridge-tracked `lastModified`, last-write-wins), not just brand-new titles.
- [ ] Spike findings recorded and reflected in spec/design before implementation of the notify path.
- [ ] Works on desktop and mobile with no yaos/WatchLog modifications.

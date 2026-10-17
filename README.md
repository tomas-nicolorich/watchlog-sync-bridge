# WatchLog Sync Bridge

A small, standalone Obsidian plugin that lets [WatchLog](https://community.obsidian.md/plugins/watchlog)'s
per-device movie/show library index reach parity across devices synced with
[yaos](https://github.com/kavinsood/yaos), without forking either plugin.

## Why this exists

yaos never syncs anything under `.obsidian/` (hardcoded, and Obsidian's
`Vault` API cannot surface config-directory paths at all), but WatchLog
stores its entire `titles` library inside
`.obsidian/plugins/watchlog/data.json`. This bridge polls that file on each
device, exports a per-device snapshot to a normal, vault-visible file under
`WatchLog/Sync/` (which rides yaos's existing, unmodified sync path for
plain vault files), and merges peer snapshots back into WatchLog's own
`data.json`. See `CLAUDE.md` and `openspec/changes/watchlog-index-bridge/`
for the full design rationale.

## Installing via BRAT

This plugin is distributed only through GitHub releases and
[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewer's Auto-update
Tool) — it is not, and cannot be, distributed through yaos itself (that's the
exact gap this project exists to route around).

1. Install the **BRAT** community plugin in Obsidian (Settings -> Community
   plugins -> Browse -> search "BRAT") and enable it.
2. In BRAT's settings, choose **Add Beta Plugin**.
3. Enter this repository's URL and confirm.
4. BRAT installs the latest tagged release (`main.js` + `manifest.json`) and
   enables the plugin automatically. Repeat on every device you want kept in
   sync.
5. Confirm **WatchLog Sync Bridge** is enabled in Settings -> Community
   plugins on each device, alongside your existing WatchLog and yaos
   installs.

BRAT also keeps the plugin updated automatically as new tagged releases are
published (see `.github/workflows/release.yml`).

## What to expect after installing

- Every ~2 minutes (configurable in the plugin's settings tab, 30s-15min
  range) each device exports its local WatchLog titles to
  `WatchLog/Sync/{deviceId}.json` and imports any peer export files it finds
  there, merging new/edited titles into its own `data.json`.
- A title added on one device appears on another after yaos has synced that
  export file and the importing device's next poll cycle runs — expect a
  minutes-scale delay, not instant sync.
- Editing a field (rating, notes, etc.) on a title that already exists on
  both devices propagates the same way, last-edit-wins.
- Deleting a title on one device does **not** remove it elsewhere in v1 —
  deletion propagation is an explicit non-goal (see the proposal's Confirmed
  Product Decisions).
- **WatchLog refreshes its view live** on both desktop and mobile once this
  bridge writes a merge — no manual reload is normally required (confirmed
  by the verification spike, see below). If it ever doesn't refresh on its
  own, run the **"Reload WatchLog data"** command (or reopen WatchLog's view)
  as a manual fallback.
- The status bar shows a `WatchLog ⟲` indicator: last sync time, or
  `+N new, M updated` right after a merge that changed something.

### Commands

| Command | What it does |
|---|---|
| `Export now` | Runs an export cycle immediately, outside the poll timer. |
| `Import and merge now` | Runs an import/merge cycle immediately. |
| `Reload WatchLog data` | Manual escape hatch: cycles WatchLog off/on via Obsidian's plugin API, for the rare case its own live refresh didn't pick up a change. |
| `Restore WatchLog data.json from backup` | Restores WatchLog's `data.json` from the newest backup this bridge took before its first-ever write on this device. |

## Verification spike summary

Before implementing the merge/notify logic, this change ran a throwaway
in-app verification spike on real desktop and mobile Obsidian installs to
settle two open questions: whether WatchLog notices an externally-written
`data.json` live, and the real shape of a WatchLog title entry. Full findings
are recorded in [`spike-findings.md`](./spike-findings.md); in short:

- WatchLog's UI **updates live, with no reload needed, on both desktop and
  mobile** whenever this bridge writes `data.json` via Obsidian's
  `adapter.write()`.
- Obsidian's `app.plugins.disablePlugin`/`enablePlugin` reload cycle is
  available on both platforms and is wired as the manual fallback command
  above, but is never triggered automatically by the bridge.
- Two WatchLog entry fields (`dateModified`, `communityRatingLastFetched`)
  are rewritten by WatchLog's own background behavior rather than by user
  edits, and are excluded from this bridge's own change-detection hashing so
  they never spuriously trigger a sync conflict.

## Rollback / uninstall

Nothing in yaos or WatchLog is ever modified by this plugin — removal is
complete and safe:

1. Disable and remove **WatchLog Sync Bridge** via BRAT (or Settings ->
   Community plugins) on each device.
2. If you want to undo any merge this bridge already applied, restore
   WatchLog's `data.json` from the backup this bridge took before its first
   write on that device: run the **"Restore WatchLog data.json from backup"**
   command before uninstalling, or manually copy the newest file from
   `.obsidian/plugins/watchlog-sync-bridge/backups/` over
   `.obsidian/plugins/watchlog/data.json`.
3. Delete the `WatchLog/Sync/` folder from the vault. yaos will propagate
   that deletion to your other devices like any other vault file — no yaos
   or WatchLog configuration changes are needed.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build   # bundles main.ts -> main.js via esbuild
```

Strict TDD applies to every pure module (`src/hash.ts`, `src/titleState.ts`,
`src/merge.ts`, `src/export.ts`'s pure helpers, `src/identity.ts`,
`src/scheduler.ts`, `src/settings.ts`'s pure helpers) — see
`openspec/changes/watchlog-index-bridge/` for the full spec, design, and task
history. `main.ts`'s Obsidian lifecycle wiring and the settings tab's UI
widgets are verified manually (typecheck + bundle build), matching the rest
of this project's Obsidian-API-heavy glue code.

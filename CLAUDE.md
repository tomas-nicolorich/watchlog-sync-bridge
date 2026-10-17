# WatchLog Sync Bridge

## Purpose

A small, standalone Obsidian plugin that lets WatchLog's per-device library
index (`.obsidian/plugins/watchlog/data.json`) reach parity across devices
synced with **yaos**, without forking either plugin.

## Why this exists

yaos (https://github.com/kavinsood/yaos) syncs a vault between devices via a
CRDT engine, but it hardcodes `.obsidian/` (the Obsidian config directory) as
permanently excluded from sync — see `src/sync/exclude.ts`. WatchLog
(https://community.obsidian.md/plugins/watchlog) stores its entire movie/show
library as a `titles` array inside `.obsidian/plugins/watchlog/data.json`,
which the plugin reads on load and never rebuilds from the vault's markdown
notes. Result: a title added via WatchLog's UI on one device never appears on
another device, even though the note file WatchLog writes out for that title
syncs over yaos just fine.

## Confirmed technical constraints (do not re-derive, verify if suspicious)

- **yaos never syncs anything under `.obsidian/`.** This is hardcoded in
  `alwaysExcludedPrefixes()` in yaos's `src/sync/exclude.ts`, unconditional,
  no user-facing override. Confirmed by reading the plugin's actual source at
  github.com/kavinsood/yaos (not just the minified build).
- **yaos's sync/candidate-discovery pipeline runs entirely on Obsidian's
  normal `Vault` API** (`app.vault.getFiles()`, `app.vault.getMarkdownFiles()`,
  `vault.on("create"|"modify"|"rename"|"delete")`). Obsidian's `Vault` API
  never surfaces anything under the config directory through that tree —
  this is core Obsidian behavior, not a yaos choice. So even an unexcluded
  `.obsidian/...` path would never be discovered or watched by yaos's normal
  pipeline. **This is why patching yaos's exclude list alone would not work**
  — do not attempt that route from this project.
- **yaos DOES support syncing plain, non-markdown files under normal vault
  folders** as "blobs" (see `src/paths/pathCategory.ts`: non-`.md`,
  non-excluded paths classify as `blob`, handled by `src/sync/blobSync.ts`).
  A JSON file placed in an ordinary vault folder (e.g. `WatchLog/Sync/`)
  syncs like any other vault file — no yaos changes needed.
- **WatchLog's UI list is driven only by `this.data.titles`** (the array in
  its own `data.json`), populated via the plugin's own `loadData()`/
  `saveData()`. It does not scan the `WatchLog/*/*.md` notes to rebuild that
  array. It watches its own `data.json` via `vault.on("raw", ...)`.
  **CORRECTED 2026-09-07 (real-device spike, both a Linux desktop and a
  Pixel 8 running Obsidian mobile — see `spike-findings.md`):** the earlier
  assumption that `"raw"` is strictly desktop-only was too broad. `"raw"`
  fired, and WatchLog live-refreshed with no reload/restart, on **both**
  platforms when our own plugin wrote to `data.json` via
  `app.vault.adapter.write()` from inside the running app. The likely real
  boundary is *origin of the write*, not *platform*: mobile's OS-level
  sandboxing plausibly still blocks watching **externally**-originated
  filesystem changes (e.g. from a native sync daemon outside Obsidian's own
  process), but an in-process `adapter.write()` call — which is the only way
  this bridge ever writes `data.json` — reliably triggers it on both
  platforms. This is unverified for genuinely external writes on mobile
  (not applicable here since yaos never touches `.obsidian/` either way),
  but for this project's actual write path, poll-based reload nudging is no
  longer assumed necessary by default on either platform; a manual "Reload
  WatchLog data" command remains a documented fallback/escape-hatch in case
  a future WatchLog/Obsidian version behaves differently.
- The upstream yaos README explicitly documents non-markdown plugin files as
  outside its sync guarantees — this is an intentional design boundary
  upstream, not a bug we're "fixing."

## Design direction (subject to the SDD proposal/spec/design in `openspec/`)

A companion plugin that:
1. On each device, periodically (poll-based, mobile-safe) reads WatchLog's
   local `.obsidian/plugins/watchlog/data.json` via `app.vault.adapter.read()`
   and exports its content (or a diffable subset) to a normal, vault-visible
   file so it rides yaos's existing, unmodified blob-sync path.
2. On each device, watches that vault-visible export file via the *normal*
   `vault.on("modify"|"create")` events (which DO fire for ordinary vault
   paths, unlike `.obsidian/`), and merges incoming entries back into the
   local `data.json` via `app.vault.adapter.write()`.
3. Needs a defined per-entry merge policy (WatchLog's `titles` entries carry
   `id`, `dateAdded`, and a `history` log — a naive overwrite could clobber
   local edits or duplicate history). This is exactly what the SDD spec/
   design phases need to pin down before implementation.
4. Needs a plan for getting WatchLog to actually notice the merged
   `data.json` change on each platform (desktop `"raw"` event may or may not
   fire for adapter-written files; mobile likely needs a nudge, possibly just
   documenting "reopen the WatchLog view" or an app reload as an accepted
   limitation).

## Non-goals

- Do not fork or vendor yaos or WatchLog source into this repo.
- Do not attempt to patch yaos's `exclude.ts` as a fix — confirmed
  insufficient (see constraints above).
- Not a general-purpose Obsidian sync engine — scoped to bridging exactly
  one plugin's per-device index file.

## Distribution

Intended to be installed on both devices via BRAT, pointed at this repo's
GitHub releases, same as any other community/beta Obsidian plugin — not
distributed through yaos's own sync mechanism (that's the exact problem this
project exists to route around).

## Planning artifacts

This project uses SDD (Spec-Driven Development) with the `openspec` backend.
See `openspec/` for the proposal, spec, design, and tasks for this change.

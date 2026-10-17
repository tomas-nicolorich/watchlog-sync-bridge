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

<!-- dgc-policy-v11 -->
# Dual-Graph Context Policy

This project uses a local dual-graph MCP server for efficient context retrieval.

## MANDATORY: Always follow this order

1. **Call `graph_continue` first** — before any file exploration, grep, or code reading.

2. **If `graph_continue` returns `needs_project=true`**: call `graph_scan` with the
   current project directory (`pwd`). Do NOT ask the user.

3. **If `graph_continue` returns `skip=true`**: project has fewer than 5 files.
   Do NOT do broad or recursive exploration. Read only specific files if their names
   are mentioned, or ask the user what to work on.

4. **Read `recommended_files`** using `graph_read` — **one call per file**.
   - `graph_read` accepts a single `file` parameter (string). Call it separately for each
     recommended file. Do NOT pass an array or batch multiple files into one call.
   - `recommended_files` may contain `file::symbol` entries (e.g. `src/auth.ts::handleLogin`).
     Pass them verbatim to `graph_read(file: "src/auth.ts::handleLogin")` — it reads only
     that symbol's lines, not the full file.
   - Example: if `recommended_files` is `["src/auth.ts::handleLogin", "src/db.ts"]`,
     call `graph_read(file: "src/auth.ts::handleLogin")` and `graph_read(file: "src/db.ts")`
     as two separate calls (they can be parallel).

5. **Check `confidence` and obey the caps strictly:**
   - `confidence=high` -> Stop. Do NOT grep or explore further.
   - `confidence=medium` -> If recommended files are insufficient, call `fallback_rg`
     at most `max_supplementary_greps` time(s) with specific terms, then `graph_read`
     at most `max_supplementary_files` additional file(s). Then stop.
   - `confidence=low` -> Call `fallback_rg` at most `max_supplementary_greps` time(s),
     then `graph_read` at most `max_supplementary_files` file(s). Then stop.

## Token Usage

A `token-counter` MCP is available for tracking live token usage.

- To check how many tokens a large file or text will cost **before** reading it:
  `count_tokens({text: "<content>"})`
- To log actual usage after a task completes (if the user asks):
  `log_usage({input_tokens: <est>, output_tokens: <est>, description: "<task>"})`
- To show the user their running session cost:
  `get_session_stats()`

Live dashboard URL is printed at startup next to "Token usage".

## Rules

- Do NOT use `rg`, `grep`, or bash file exploration before calling `graph_continue`.
- Do NOT do broad/recursive exploration at any confidence level.
- `max_supplementary_greps` and `max_supplementary_files` are hard caps - never exceed them.
- Do NOT dump full chat history.
- Do NOT call `graph_retrieve` more than once per turn.
- After edits, call `graph_register_edit` with the changed files. Use `file::symbol` notation (e.g. `src/auth.ts::handleLogin`) when the edit targets a specific function, class, or hook.

## Context Store

Whenever you make a decision, identify a task, note a next step, fact, or blocker during a conversation, call `graph_add_memory`.

**To add an entry:**
```
graph_add_memory(type="decision|task|next|fact|blocker", content="one sentence max 15 words", tags=["topic"], files=["relevant/file.ts"])
```

**Do NOT write context-store.json directly** — always use `graph_add_memory`. It applies pruning and keeps the store healthy.

**Rules:**
- Only log things worth remembering across sessions (not every minor detail)
- `content` must be under 15 words
- `files` lists the files this decision/task relates to (can be empty)
- Log immediately when the item arises — not at session end

## Session End

When the user signals they are done (e.g. "bye", "done", "wrap up", "end session"), proactively update `CONTEXT.md` in the project root with:
- **Current Task**: one sentence on what was being worked on
- **Key Decisions**: bullet list, max 3 items
- **Next Steps**: bullet list, max 3 items

Keep `CONTEXT.md` under 20 lines total. Do NOT summarize the full conversation — only what's needed to resume next session.

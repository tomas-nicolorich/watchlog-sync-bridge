# Spec: WatchLog Index Bridge

Combined new-capability spec (greenfield — no prior `openspec/specs/` exist for
these domains, so each capability below is a full spec, not a delta).
Domains: `index-export`, `index-merge`, `bridge-lifecycle`.

## Capability: index-export

### Purpose

Read WatchLog's local `data.json` and emit a normalized, per-device,
vault-visible export blob that rides yaos's unmodified blob-sync path.

### Requirements

#### Requirement: Export Trigger and Content

On each poll cycle the system MUST read WatchLog's local `data.json` via
`adapter.read()` and write a normalized, id-keyed snapshot of local `titles`
entries to this device's own per-device export file at a vault-visible path.
The system MUST NOT modify WatchLog's `data.json` during export.

##### Scenario: Export reflects current local titles

- GIVEN WatchLog's local `data.json` contains a set of `titles` entries
- WHEN an export poll cycle runs
- THEN the device's export file MUST contain an id-keyed snapshot matching those entries

##### Scenario: Export never mutates WatchLog's data.json

- GIVEN an export cycle runs
- WHEN it reads `data.json`
- THEN it MUST only read, never write, WatchLog's `data.json`

#### Requirement: Export Write Integrity

Each per-device export file write MUST be atomic (temp-file-then-rename or
equivalent) so peers never observe a partially-written export file.

##### Scenario: Export write is atomic

- GIVEN an export cycle is producing a new snapshot
- WHEN the export file is written
- THEN a concurrent read of that file by yaos's sync engine MUST see either the fully old or fully new content, never a partial file

#### Requirement: Per-Title lastModified Tracking

Because WatchLog's own `data.json` exposes no per-entry modification
timestamp, the bridge plugin MUST maintain its own per-title `lastModified`
timestamp, used exclusively by merge to resolve concurrent scalar-field edits
(see index-merge's Cross-Device Propagation of Scalar Field Edits). This
timestamp MUST be persisted only in the bridge plugin's own local plugin data
(its own `data.json` under its own `.obsidian/plugins/` directory), and MUST
NOT be written into WatchLog's `data.json` — the system MUST NOT invent or add
fields on WatchLog's own owned file. Each per-device export file MUST include
the tracked `lastModified` alongside each exported title so peers can compare
it during merge.

On each poll cycle, for every local title, the system MUST compare its
current scalar-field content against the plugin's last-known local snapshot
of that title. If content differs, the system MUST update that title's
tracked `lastModified` to the current time and update the stored snapshot. If
content is unchanged, `lastModified` MUST NOT be updated. When the system
observes a title id for which the plugin has no prior stored snapshot —
because the plugin was just installed, or because the title is genuinely
new — it MUST seed that title's tracked `lastModified` at baseline `0`, not
the current time.

##### Scenario: Editing a title's rating updates its tracked lastModified

- GIVEN a title's `rating` field was `7` in the plugin's last-known local snapshot
- WHEN a poll cycle observes the same title's `rating` is now `9` in WatchLog's `data.json`
- THEN the plugin MUST update that title's tracked `lastModified` to the current time
- AND MUST update its stored snapshot to the new value

##### Scenario: Unchanged titles do not get their lastModified bumped

- GIVEN a title's scalar fields are identical to the plugin's last-known local snapshot
- WHEN a poll cycle runs
- THEN that title's tracked `lastModified` MUST remain unchanged

##### Scenario: lastModified is stored in the bridge's own plugin data, not WatchLog's

- GIVEN the bridge plugin tracks `lastModified` for a title
- WHEN it persists that value
- THEN it MUST write it only to the bridge plugin's own local plugin data file
- AND MUST NOT add, modify, or invent any field on WatchLog's own `data.json`

##### Scenario: Newly observed titles seed lastModified at baseline 0, not current time

- GIVEN the plugin has no prior stored snapshot for a title id, either because it was just installed on a device with a pre-existing library or because the title is genuinely new
- WHEN a poll cycle first observes that title id
- THEN the plugin MUST seed that title's tracked `lastModified` at `0`, not the current time
- AND this MUST prevent a freshly-installed device from automatically winning every scalar-field conflict against titles already being tracked and edited on other devices

## Capability: index-merge

### Purpose

Discover peer per-device export files and merge their entries into the local
`data.json` without ever losing data, propagating deletions, or corrupting
the file WatchLog owns, while propagating new titles, appended `history`
entries, and last-write-wins scalar-field edits (via tracked `lastModified`)
between devices.

### Requirements

#### Requirement: Cross-Device Propagation of Additions

A title added on one device MUST become visible in WatchLog on another device
within one poll cycle after yaos has synced the exporting device's file,
subject to WatchLog noticing the `data.json` change per the Notification
requirement below.

##### Scenario: Title added on device A appears on device B

- GIVEN WatchLog on device A has a title entry not yet present on device B
- WHEN device A's next export cycle writes its export file, yaos syncs it, and device B's next import cycle runs
- THEN device B's local `data.json` MUST contain the new entry
- AND it MUST become visible in WatchLog's UI immediately (if the desktop notification spike confirms auto-refresh) or after the documented manual reload/reopen action otherwise

#### Requirement: Per-ID Union Merge

Merge MUST union `titles` entries by `id` across all discovered peer export
files and the local `data.json`. No entry present in any source MUST be
dropped by a merge cycle.

##### Scenario: Concurrent adds on two devices both survive

- GIVEN device A adds an entry with id X locally and device B adds an entry with id Y locally, before either has synced
- WHEN yaos syncs both export files and each device runs its next import cycle
- THEN device A's and device B's local `data.json` MUST both contain X and Y, with neither lost nor duplicated

##### Scenario: Same id created independently on two devices

- GIVEN device A and device B each create a local entry with the same id X but different field values, before syncing
- WHEN merge runs on either device
- THEN neither version MUST be silently discarded — history is unioned per the History requirement below and the merged `dateAdded` is the earliest of the two

#### Requirement: Cross-Device Propagation of Scalar Field Edits

When merging an entry that already exists in both the local `data.json` and a
peer's export, the system MUST compare the tracked `lastModified` value
carried in the peer's export against the local title's own tracked
`lastModified`. The scalar-field values (e.g. `rating`, `notes`) from
whichever side has the later `lastModified` MUST win and MUST be written to
the local entry, and the local tracked `lastModified` MUST be updated to
match the winning value's timestamp. This requirement applies only to
previously-shared titles being edited (distinct from Per-ID Union Merge,
which covers brand-new title creation, and from History Union and
De-duplication, which covers `history` appends). Editing an existing
`history` entry in place is explicitly out of scope for v1: only new-title
creation, `history` appends, and scalar-field edits via tracked
`lastModified` are in-scope merge-propagation behaviors. When the peer's
tracked `lastModified` and the local title's tracked `lastModified` are
exactly equal, the system MUST break the tie deterministically by comparing
`deviceId`: the entry from the device whose `deviceId` sorts lexicographically
smaller (ascending) MUST win. After a merge resolves any scalar-field
conflict, the local tracked `lastModified` for that title MUST be set to
exactly the winning side's `lastModified` value, and MUST NOT be reset to the
current time at merge commit.

##### Scenario: Scalar field edited on device A propagates to device B

- GIVEN title X exists identically on device A and device B, both already merged
- WHEN the user edits X's `rating` on device A only, device A's next export cycle records the new `lastModified`, yaos syncs the export, and device B's next import cycle runs
- THEN device B's local `data.json` MUST show X's edited `rating` value
- AND device B's tracked `lastModified` for X MUST be updated to match the merged value's timestamp

##### Scenario: Concurrent scalar edits on both devices — later lastModified wins

- GIVEN title X exists identically on device A and device B, both already merged, with tracked `lastModified` T0 on each
- WHEN the user edits X's `notes` on device A at time T1, and independently edits X's `rating` on device B at time T2 (T2 later than T1), before either device has imported the other's export
- THEN once both exports have synced and each device's next import cycle runs, both device A's and device B's local `data.json` MUST converge on device B's edited scalar-field values (the T2 write), because T2 is later than T1
- AND device A's `notes` edit made at T1 MUST be discarded by the merge, since it lost the last-write-wins comparison
- AND both devices' tracked `lastModified` for X MUST converge to T2

##### Scenario: History edits (not appends) remain out of scope

- GIVEN a `history` entry already merged into local `data.json` is modified in place on one device — not appended, but an existing entry's own fields changed
- WHEN merge runs
- THEN the system is NOT required to detect or propagate that in-place history edit; only new-title creation, `history` appends (per History Union and De-duplication), and scalar-field edits via tracked `lastModified` (this requirement) are in-scope propagation behaviors for v1

##### Scenario: Equal tracked lastModified values resolve by deterministic deviceId order

- GIVEN title X has the same tracked `lastModified` value on device A and device B (e.g. both still at baseline `0`, or a genuine timestamp tie), with different scalar-field values on each side
- WHEN merge runs on either device
- THEN the entry from the device whose `deviceId` sorts lexicographically smaller (ascending) MUST win the conflict
- AND both devices MUST converge on the same winning values regardless of which device runs the merge first

##### Scenario: Merged lastModified is copied from the winner, not stamped with the current time

- GIVEN a merge on device B resolves a scalar-field conflict on title X in device A's favor, with device A's tracked `lastModified` at T1
- WHEN device B commits the merge result
- THEN device B's tracked `lastModified` for X MUST be set to exactly T1, the winning side's value, and MUST NOT be set to the current time
- AND if it were instead stamped with the current time, device B's next poll cycle would see X's scalar content as freshly changed relative to its own last-known snapshot, re-export it with a newer `lastModified` than T1, and cause device A to re-import and re-apply the same edit back — an unbounded cross-device ping-pong of the same edit that never converges

#### Requirement: History Union and De-duplication

Merge MUST union each entry's `history` array across sources and remove
duplicate entries representing the same underlying event, using a stable
per-entry de-dup key. If the verification spike (see below) finds no stable
`id`/timestamp field on history entries, the system MUST fall back to a
content hash of the entry's normalized fields as the de-dup key.

##### Scenario: History additions from two devices both survive

- GIVEN entry X has history entry H1 added on device A and H2 added on device B, both unsynced yet
- WHEN either device merges the other's export
- THEN the merged entry's `history` MUST contain both H1 and H2 with no duplicates

##### Scenario: Re-merging the same peer export does not duplicate history

- GIVEN device A already merged history entry H1 from device B's export in a prior cycle, and device B's export still lists H1
- WHEN device A merges device B's export again in a later cycle
- THEN device A's local history for that entry MUST still contain exactly one copy of H1

##### Scenario: `dateAdded` uses earliest-wins semantics

- GIVEN entry X has `dateAdded` T1 on device A and T2 on device B, with T1 earlier
- WHEN merge combines both versions
- THEN the merged entry's `dateAdded` MUST be T1

#### Requirement: Deletion Non-Propagation

The system MUST NOT remove, tombstone, or omit a local `titles` entry solely
because that entry is absent from a peer's export file. Deletion propagation
is explicitly out of scope for v1 (confirmed product decision). This
prohibition is unaffected by and orthogonal to scalar-field edit propagation
(see Cross-Device Propagation of Scalar Field Edits): an edited title remains
present with the same `id` on both devices — only a field value changes — and
MUST NOT be treated as, or implemented via, a delete-then-recreate.

##### Scenario: Editing a title is never mistaken for a delete-then-recreate

- GIVEN title X is edited on device A (a scalar field changes) rather than deleted
- WHEN device B imports device A's export
- THEN device B MUST apply the edit via last-write-wins merge and MUST NOT treat it as a deletion of the old entry followed by recreation
- AND X's `id`, `dateAdded`, and `history` MUST remain unchanged by the edit propagation

##### Scenario: Deleting an entry on device A does not remove it on device B

- GIVEN device A previously exported entry X and device B already merged X into its local `data.json`
- WHEN the user deletes X in WatchLog on device A, device A's next export omits X, and device B imports that updated export
- THEN device B's local `data.json` MUST still contain X unchanged
- AND the merge system MUST NOT treat X's absence from device A's export as a delete signal

##### Scenario: Missing ids in a peer snapshot are not treated as tombstones

- GIVEN a peer export file is missing ids that were present in an earlier snapshot
- WHEN merge runs
- THEN those ids MUST remain untouched in local `data.json`; absence is treated purely as "not in this snapshot," never as intent to delete

#### Requirement: Data Integrity on data.json Writes

Before its first-ever write to `data.json` on a device, the system MUST
create and retain a backup of the pre-write file. Every write MUST be atomic
(temp-file-then-rename or equivalent), and the fully-constructed new content
MUST pass JSON validation before being committed to disk. A crash or
termination during a write MUST NOT leave `data.json` truncated or invalid.

##### Scenario: Backup created before first write

- GIVEN the plugin is about to perform its first-ever merge write on a device
- WHEN the write is triggered
- THEN a backup of the pre-write `data.json` MUST be created and retained before the write proceeds

##### Scenario: Atomic write survives a mid-write crash

- GIVEN a merge write is in progress
- WHEN the process crashes or is killed mid-write
- THEN `data.json` on disk MUST reflect either the fully old or fully new content, never a partial or corrupt mix

##### Scenario: An invalid merge result is never committed

- GIVEN a merge computation produces content that fails JSON validation
- WHEN the system attempts to write it
- THEN the write MUST be aborted, `data.json` MUST remain untouched, and the failure MUST be logged

#### Requirement: WatchLog Notification Verification Gate

Because it is unverified whether `adapter.write()` re-triggers WatchLog's
desktop `"raw"` listener, and whether `history` entries carry a stable id,
this change MUST run an early, throwaway verification spike before the
notification/merge de-dup behavior is finalized. Either spike outcome MUST
NOT block v1 delivery.

##### Scenario: Spike confirms desktop auto-refresh

- GIVEN the spike's test plugin writes `data.json` via `adapter.write()`
- WHEN WatchLog's desktop `"raw"` listener fires and its UI updates without manual reload
- THEN the merge write path relies on native auto-refresh on desktop, with manual reload documented as a fallback only

##### Scenario: Spike finds no desktop auto-refresh (accepted v1 outcome)

- GIVEN the spike's test plugin writes `data.json` via `adapter.write()`
- WHEN WatchLog's UI does not update without user action
- THEN the system MUST document "reopen WatchLog view / reload" as the required post-merge step on desktop, matching mobile
- AND this outcome MUST NOT block v1 release

##### Scenario: Spike finds no stable history de-dup key

- GIVEN the spike inspects real `history` entry data and finds no stable per-entry id
- WHEN merge needs to de-duplicate unioned history entries
- THEN it MUST fall back to a content hash of normalized entry fields as the de-dup key, with union/earliest-`dateAdded` behavior otherwise unchanged

## Capability: bridge-lifecycle

### Purpose

Device identity, poll scheduling, settings, and failure handling that the
export and merge capabilities depend on, with desktop/mobile parity.

### Requirements

#### Requirement: Device Identity

Each installation MUST have a stable, unique device identifier, persisted
locally and unchanged across restarts, used to name/key its per-device
export file.

##### Scenario: Device id persists across restarts

- GIVEN the plugin generated a device id on first run
- WHEN Obsidian restarts and the plugin reloads
- THEN the same device id and export filename MUST be reused

##### Scenario: No stale-device cleanup in v1 (confirmed product decision)

- GIVEN a device is retired and its export file stops updating
- WHEN other devices import
- THEN the system MUST NOT attempt to detect or clean up stale per-device export files; this is out of scope for v1's 2-3 device target

#### Requirement: Poll Scheduler

The system MUST run export and import/merge cycles on a periodic, configurable
timer defaulting to a minutes-scale interval, and MUST NOT depend on any
native filesystem-change event for correctness on any platform.

##### Scenario: Default interval applies when unconfigured

- GIVEN the user has not changed the poll interval setting
- WHEN the plugin loads
- THEN it MUST use a minutes-scale default interval for both export and import cycles

##### Scenario: Poll works on mobile without native fs events

- GIVEN the plugin runs on Obsidian mobile, where `"raw"` events never fire
- WHEN a poll cycle elapses
- THEN export and import MUST execute correctly using only `adapter.read()`/`adapter.write()`/`vault.on("modify"|"create")` and the timer

#### Requirement: User-Configurable Settings

The system SHOULD expose settings for poll interval and export path, with
defaults sufficient for zero-configuration use.

##### Scenario: Plugin works with default settings

- GIVEN the user installs the plugin and changes no settings
- WHEN it runs
- THEN export and merge MUST function correctly using default paths and interval

#### Requirement: Failure Handling and Logging

The system MUST log read/parse/write failures without crashing Obsidian and
MUST leave existing local data untouched when a cycle fails partway.

##### Scenario: Malformed peer export does not crash the plugin

- GIVEN a peer's export file is malformed JSON
- WHEN import runs
- THEN the system MUST skip that file, log the failure, and continue merging other valid peer files without crashing or corrupting local `data.json`

#### Requirement: Desktop and Mobile Parity

Export, import/merge, poll scheduling, and data-integrity behavior MUST be
identical on desktop and mobile, using only APIs available on both platforms.

##### Scenario: Identical merge outcome regardless of platform

- GIVEN the same peer export files and local `data.json` state
- WHEN merge runs on desktop vs. mobile
- THEN the resulting local `data.json` content MUST be identical

##### Scenario: Mobile requires manual WatchLog reload (documented, not a bug)

- GIVEN merge has written an updated `data.json` on mobile
- WHEN WatchLog's view is already open
- THEN the updated data MUST become visible only after reopening the view or reloading, per the documented v1 limitation

import { Notice, Plugin } from "obsidian";
import type { ImporterAdapter } from "./src/importer";
import { runImportCycle } from "./src/importer";
import { runExportCycle } from "./src/export";
import { getOrCreateDeviceId, sanitizeDeviceIdForFilename } from "./src/identity";
import { recoverPendingWrite } from "./src/watchlogIo";
import { Scheduler } from "./src/scheduler";
import { DEFAULT_SETTINGS, WatchLogSyncBridgeSettingTab, normalizeSyncDirPath } from "./src/settings";
import type { BridgeData } from "./src/types";

/** WatchLog's own local index file — read always, written only by `importOnce`
 * via `watchlogIo.commitMergedData` (design.md "Write Safety for WatchLog's
 * data.json"). */
const WATCHLOG_DATA_PATH = ".obsidian/plugins/watchlog/data.json";

type SyncStatus = "idle" | "synced" | "merged" | "error";

/**
 * WatchLog Sync Bridge — lifecycle wiring (design.md "Module Boundaries":
 * `main.ts` owns "Plugin lifecycle, wiring, commands, status bar").
 *
 * Wires the already-tested pure/adapter modules (`identity`, `export`,
 * `importer`, `watchlogIo`, `scheduler`, `settings`) into a real Obsidian
 * plugin: loads/persists `BridgeData` via `loadData()`/`saveData()`
 * (`.obsidian/plugins/watchlog-sync-bridge/data.json`), runs export+import on
 * a poll timer, and exposes manual commands plus a status bar indicator.
 *
 * **Spike-confirmed simplification (spike-findings.md, 2026-09-07):** a1/a2
 * confirmed WatchLog live-refreshes on BOTH desktop and mobile whenever this
 * bridge writes `data.json` via `adapter.write()` — no reload action needed
 * by default on either platform. This file therefore never triggers the
 * `disablePlugin`/`enablePlugin` cycle automatically; it is wired only as the
 * manual "Reload WatchLog data" command below (an escape hatch, per a3),
 * consistent with `DEFAULT_SETTINGS.autoReloadWatchLog: false`.
 *
 * This work unit also strips the throwaway `Dev: run bridge spike` command
 * (tasks.md 10.3) — its findings are preserved in `spike-findings.md`.
 */
export default class WatchLogSyncBridgePlugin extends Plugin {
	data!: BridgeData;
	settings!: BridgeData["settings"];

	private readonly scheduler = new Scheduler();
	private statusBarItem?: HTMLElement;
	private bridgeDir = "";

	async onload(): Promise<void> {
		this.bridgeDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

		await this.loadBridgeData();
		await this.recoverFromCrashIfNeeded();

		this.statusBarItem = this.addStatusBarItem();
		this.setStatus("idle");

		this.addSettingTab(new WatchLogSyncBridgeSettingTab(this.app, this));

		this.addCommand({
			id: "export-now",
			name: "Export now",
			callback: () => this.runManual(() => this.exportOnce(), "export"),
		});
		this.addCommand({
			id: "import-and-merge-now",
			name: "Import and merge now",
			callback: () => this.runManual(() => this.importOnce(), "import"),
		});
		this.addCommand({
			id: "reload-watchlog-data",
			name: "Reload WatchLog data",
			callback: () => this.reloadWatchLog(),
		});
		this.addCommand({
			id: "restore-from-backup",
			name: "Restore WatchLog data.json from backup",
			callback: () => this.restoreFromBackup(),
		});

		this.scheduler.start(this.data.settings.pollSeconds, () => this.tick());
	}

	onunload(): void {
		this.scheduler.stop();
	}

	/** Persists `this.data` — also the `SettingsHost` contract `settings.ts`'s
	 * setting tab depends on. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.data);
	}

	/**
	 * Loads `BridgeData` from this plugin's own local data file, applying
	 * setting defaults for any field absent from a prior version and
	 * resolving `deviceId` via `identity.ts` (spec.md "Device id persists
	 * across restarts"). Persists immediately if a device id was just minted.
	 */
	private async loadBridgeData(): Promise<void> {
		const stored = (await this.loadData()) as Partial<BridgeData> | null;
		const deviceId = getOrCreateDeviceId(stored?.deviceId, () => crypto.randomUUID());

		this.data = {
			deviceId,
			settings: {
				...DEFAULT_SETTINGS,
				...stored?.settings,
				syncDirPath: normalizeSyncDirPath(stored?.settings?.syncDirPath),
			},
			lastExport: stored?.lastExport,
			titleState: stored?.titleState ?? {},
			peerState: stored?.peerState ?? {},
			backupTaken: stored?.backupTaken ?? false,
			pendingWrite: stored?.pendingWrite,
		};
		this.settings = this.data.settings;

		if (stored?.deviceId !== deviceId) {
			await this.saveSettings();
		}
	}

	/**
	 * Crash recovery on load (design.md step 5, `watchlogIo.recoverPendingWrite`).
	 * A no-op when no `pendingWrite` marker was persisted.
	 */
	private async recoverFromCrashIfNeeded(): Promise<void> {
		const result = await recoverPendingWrite({
			adapter: this.app.vault.adapter,
			watchlogDataPath: WATCHLOG_DATA_PATH,
			bridgeDir: this.bridgeDir,
			pendingWrite: this.data.pendingWrite,
			log: this.log.bind(this),
		});

		if (result.pendingWrite !== this.data.pendingWrite) {
			this.data.pendingWrite = result.pendingWrite;
			await this.saveSettings();
		}
		if (result.restoredFrom === "pending") {
			new Notice("WatchLog Sync Bridge: recovered data.json from a staged write after a crash.");
		}
	}

	/** One poll tick: export, then import/merge — matches design.md's
	 * sequence diagram ordering. Each half logs and continues past its own
	 * failure so one broken half never blocks the other. */
	private async tick(): Promise<void> {
		try {
			await this.exportOnce();
		} catch (err) {
			this.log("export cycle failed", err);
			this.setStatus("error");
		}
		try {
			await this.importOnce();
		} catch (err) {
			this.log("import cycle failed", err);
			this.setStatus("error");
		}
	}

	private exportPath(): string {
		return `${this.data.settings.syncDirPath}/${sanitizeDeviceIdForFilename(this.data.deviceId)}.json`;
	}

	private async ensureDirExists(dir: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
	}

	/** spec.md "Export Trigger and Content" via `export.ts`'s already-tested
	 * `runExportCycle`. */
	private async exportOnce(): Promise<void> {
		await this.ensureDirExists(this.data.settings.syncDirPath);

		const result = await runExportCycle({
			adapter: this.app.vault.adapter,
			watchlogDataPath: WATCHLOG_DATA_PATH,
			exportPath: this.exportPath(),
			deviceId: this.data.deviceId,
			deviceLabel: this.data.settings.deviceLabel,
			priorTitleState: this.data.titleState,
			now: Date.now(),
		});

		this.data.titleState = result.titleState;
		await this.saveSettings();
	}

	/** spec.md "index-merge" capability via `importer.ts`'s already-tested
	 * `runImportCycle`. Updates the status bar and shows a throttled Notice
	 * only when a merge actually changed something (design.md "WatchLog-Notice
	 * Fallback UX"). */
	private async importOnce(): Promise<void> {
		const selfExportFileName = `${sanitizeDeviceIdForFilename(this.data.deviceId)}.json`;
		// watchlogIo writes its first-merge backup here; mobile's adapter.write()
		// fails when the parent folder is missing.
		await this.ensureDirExists(`${this.bridgeDir}/backups`);

		const result = await runImportCycle({
			adapter: this.app.vault.adapter as ImporterAdapter,
			watchlogDataPath: WATCHLOG_DATA_PATH,
			bridgeDir: this.bridgeDir,
			syncDir: this.data.settings.syncDirPath,
			selfDeviceId: this.data.deviceId,
			selfExportFileName,
			localTitleState: this.data.titleState,
			backupTaken: this.data.backupTaken,
			now: Date.now(),
			log: this.log.bind(this),
		});

		this.data.titleState = result.titleState;
		this.data.backupTaken = result.backupTaken;
		this.data.pendingWrite = result.pendingWrite;
		await this.saveSettings();

		if (result.skippedPeers.length > 0) {
			this.log("skipped malformed peer export file(s)", result.skippedPeers);
		}

		if (result.committed && (result.addedIds.length > 0 || result.changedIds.length > 0)) {
			this.setStatus("merged", result.addedIds.length, result.changedIds.length);
			new Notice(
				`WatchLog Sync Bridge: +${result.addedIds.length} new, ${result.changedIds.length} updated. ` +
					"WatchLog refreshes automatically — if it doesn't, run 'Reload WatchLog data'.",
			);
		} else {
			this.setStatus("synced");
		}
	}

	/**
	 * Manual "Reload WatchLog data" escape hatch (design.md "WatchLog-Notice
	 * Fallback UX" commands; spike a3, confirmed available on both desktop
	 * and mobile). Feature-detected and try/catch-wrapped — the bridge never
	 * calls this automatically; it exists only for a user to invoke when
	 * WatchLog's own automatic live refresh did not pick up a change.
	 */
	private async reloadWatchLog(): Promise<void> {
		const plugins = (this.app as unknown as { plugins?: Record<string, unknown> }).plugins;
		const disablePlugin = plugins?.disablePlugin;
		const enablePlugin = plugins?.enablePlugin;

		if (typeof disablePlugin !== "function" || typeof enablePlugin !== "function") {
			new Notice(
				"WatchLog Sync Bridge: automatic reload isn't available on this Obsidian version. Please reopen the WatchLog view manually.",
			);
			return;
		}

		try {
			await (disablePlugin as (id: string) => Promise<void>)("watchlog");
			await (enablePlugin as (id: string) => Promise<void>)("watchlog");
			new Notice("WatchLog Sync Bridge: reloaded the WatchLog plugin.");
		} catch (err) {
			this.log("WatchLog reload cycle failed", err);
			new Notice("WatchLog Sync Bridge: could not reload WatchLog automatically. Please reopen its view manually.");
		}
	}

	/**
	 * Restores WatchLog's `data.json` from the newest retained backup
	 * (design.md step 5's "final fallback", explicitly deferred to this
	 * Phase 9 wiring layer rather than `watchlogIo.ts`, since it needs
	 * directory listing that module's narrower adapter surface doesn't
	 * expose). Backup filenames are ISO-8601-derived and dash-only
	 * (`watchlog-data.{ISO with ':'/'.' replaced by '-'}.json`), so a plain
	 * lexicographic sort orders them chronologically.
	 */
	private async restoreFromBackup(): Promise<void> {
		const backupsDir = `${this.bridgeDir}/backups`;

		let listing: { files: string[]; folders: string[] };
		try {
			listing = await this.app.vault.adapter.list(backupsDir);
		} catch (err) {
			this.log("no backups directory found", err);
			new Notice("WatchLog Sync Bridge: no backups directory found; nothing to restore from.");
			return;
		}

		const newest = listing.files.filter((file) => file.endsWith(".json")).sort().at(-1);
		if (newest === undefined) {
			new Notice("WatchLog Sync Bridge: no backup files found.");
			return;
		}

		try {
			const raw = await this.app.vault.adapter.read(newest);
			JSON.parse(raw); // Refuse to restore a corrupt backup (design.md "refuse to act on garbage").
			await this.app.vault.adapter.write(WATCHLOG_DATA_PATH, raw);
			new Notice(`WatchLog Sync Bridge: restored data.json from backup ${newest}.`);
		} catch (err) {
			this.log("restore from backup failed", err);
			new Notice("WatchLog Sync Bridge: restore failed — see console for details.");
		}
	}

	/** Routes a manual command through the scheduler's single-flight lock
	 * (design.md "Single-flight") so it never overlaps a scheduled tick. */
	private async runManual(task: () => Promise<void>, label: string): Promise<void> {
		const ran = await this.scheduler.runExclusive(async () => {
			try {
				await task();
			} catch (err) {
				this.log(`manual ${label} failed`, err);
				this.setStatus("error");
				new Notice(`WatchLog Sync Bridge: ${label} failed — see console for details.`);
			}
		});
		if (!ran) {
			new Notice("WatchLog Sync Bridge: a sync cycle is already running — try again in a moment.");
		}
	}

	/** Status bar item (design.md "WatchLog-Notice Fallback UX": `WatchLog ⟲`
	 * `synced HH:MM` / `+N new, M updated` / `error`). */
	private setStatus(state: SyncStatus, addedCount = 0, changedCount = 0): void {
		if (!this.statusBarItem) {
			return;
		}
		if (state === "merged") {
			this.statusBarItem.setText(`WatchLog ⟲ +${addedCount} new, ${changedCount} updated`);
			return;
		}
		if (state === "error") {
			this.statusBarItem.setText("WatchLog ⟲ error");
			return;
		}
		const time = new Date().toTimeString().slice(0, 5);
		this.statusBarItem.setText(`WatchLog ⟲ synced ${time}`);
	}

	private log(message: string, detail?: unknown): void {
		console.error(`[watchlog-sync-bridge] ${message}`, detail);
	}
}

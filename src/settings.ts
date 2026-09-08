/**
 * Settings type, defaults, and settings tab (design.md module boundaries:
 * `src/settings.ts`, "Yes" Obsidian API; spec.md "User-Configurable
 * Settings").
 *
 * `DEFAULT_SETTINGS` and `normalizeSyncDirPath` are pure and unit-tested
 * (`tests/settings.test.ts`). `WatchLogSyncBridgeSettingTab` is Obsidian
 * `Setting`-widget glue and is verified manually per tasks.md 9.4 — the same
 * "typecheck + bundle smoke test" bar PR1-PR3 already used for comparable
 * Obsidian-API-heavy code.
 */
import { type App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_POLL_SECONDS, MAX_POLL_SECONDS, MIN_POLL_SECONDS, clampPollSeconds } from "./scheduler";
import type { BridgeData } from "./types";

/** spec.md "settings for poll interval and export path" — design.md's data
 * flow diagram's `WatchLog/.sync/{deviceId}.json`. */
export const DEFAULT_SYNC_DIR_PATH = "WatchLog/.sync";

export type BridgeSettings = BridgeData["settings"];

/**
 * Zero-configuration defaults (spec.md "Plugin works with default settings").
 *
 * `autoReloadWatchLog` defaults to `false`: the mobile+desktop verification
 * spike (spike-findings.md, 2026-09-07) confirmed WatchLog live-refreshes on
 * both platforms whenever this bridge writes `data.json` via
 * `adapter.write()`, with no reload action needed by default. The
 * `disablePlugin`/`enablePlugin` cycle (spike a3, confirmed available on
 * both platforms) is wired only as the manual "Reload WatchLog data" command
 * (an escape hatch a user can invoke) — the bridge itself never triggers it
 * automatically, so this setting currently gates nothing in the default
 * automatic path and exists for a user who wants to opt into an automatic
 * best-effort reload attempt after a merge that changed data.
 */
export const DEFAULT_SETTINGS: BridgeSettings = {
	pollSeconds: DEFAULT_POLL_SECONDS,
	autoReloadWatchLog: false,
	syncDirPath: DEFAULT_SYNC_DIR_PATH,
};

/**
 * Normalizes a user-supplied export directory path: trims whitespace, strips
 * leading/trailing slashes so it stays vault-relative, and falls back to
 * `DEFAULT_SYNC_DIR_PATH` for undefined/empty/whitespace-only input
 * (spec.md "Plugin works with default settings" — zero-configuration use).
 */
export function normalizeSyncDirPath(value: string | undefined): string {
	if (typeof value !== "string") {
		return DEFAULT_SYNC_DIR_PATH;
	}
	const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
	return trimmed.length > 0 ? trimmed : DEFAULT_SYNC_DIR_PATH;
}

/**
 * Minimal surface this settings tab needs from the plugin instance, beyond
 * the real `Plugin` base `PluginSettingTab`'s constructor requires — kept
 * narrow, matching every other module's narrow-adapter-interface pattern.
 */
export interface SettingsHost {
	settings: BridgeSettings;
	saveSettings(): Promise<void>;
}

/**
 * Obsidian settings tab: poll interval (clamped via `clampPollSeconds`) and
 * export directory path (normalized via `normalizeSyncDirPath`). Manual-only
 * verification (tasks.md 9.4) — this class only wires already-tested pure
 * functions to `Setting` widgets.
 */
export class WatchLogSyncBridgeSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: Plugin & SettingsHost,
	) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc(`How often to export/import (${MIN_POLL_SECONDS}-${MAX_POLL_SECONDS}s, default ${DEFAULT_POLL_SECONDS}s).`)
			.addText((text) =>
				text.setValue(String(this.host.settings.pollSeconds)).onChange(async (value) => {
					this.host.settings.pollSeconds = clampPollSeconds(Number(value));
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Export directory")
			.setDesc(`Vault-relative folder for this device's export file (default "${DEFAULT_SYNC_DIR_PATH}").`)
			.addText((text) =>
				text.setValue(this.host.settings.syncDirPath).onChange(async (value) => {
					this.host.settings.syncDirPath = normalizeSyncDirPath(value);
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Attempt automatic WatchLog reload")
			.setDesc(
				"Optional: after a merge that changes data, try WatchLog's disable/enable cycle automatically " +
					"instead of relying on its automatic live refresh (confirmed working by default on desktop and mobile).",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.host.settings.autoReloadWatchLog).onChange(async (value) => {
					this.host.settings.autoReloadWatchLog = value;
					await this.host.saveSettings();
				}),
			);
	}
}

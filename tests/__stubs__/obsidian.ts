// Minimal headless stub for the "obsidian" module so pure/unit tests can run
// without a real Obsidian runtime. Only what later phases need gets added
// here — this is a test double, not a reimplementation of the API.

export class Plugin {
	app: unknown;
	manifest: unknown;
	constructor(app?: unknown, manifest?: unknown) {
		this.app = app;
		this.manifest = manifest;
	}
	loadData(): Promise<unknown> {
		return Promise.resolve(undefined);
	}
	saveData(_data: unknown): Promise<void> {
		return Promise.resolve();
	}
	addCommand(_command: unknown): void {}
	addStatusBarItem(): { setText: (text: string) => void } {
		return { setText: () => {} };
	}
	addSettingTab(_tab: unknown): void {}
	registerInterval(id: number): number {
		return id;
	}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	constructor(app?: unknown, plugin?: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
	display(): void {}
	hide(): void {}
}

export class Setting {
	constructor(_containerEl?: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export interface DataAdapter {
	read(normalizedPath: string): Promise<string>;
	write(normalizedPath: string, data: string): Promise<void>;
	exists(normalizedPath: string): Promise<boolean>;
	stat(normalizedPath: string): Promise<{ mtime: number; size: number; type: string } | null>;
	list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
	mkdir(normalizedPath: string): Promise<void>;
	remove(normalizedPath: string): Promise<void>;
	rename(normalizedPath: string, newNormalizedPath: string): Promise<void>;
}

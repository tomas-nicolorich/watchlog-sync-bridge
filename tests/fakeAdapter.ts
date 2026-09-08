/**
 * Shared in-memory fake `DataAdapter` used by `watchlogIo.test.ts` and
 * `importer.test.ts` (tasks.md 7.5: "consolidate fake-adapter fixtures
 * shared with Phase 8"). Plain fixture module, not a test file itself.
 */
import type { WatchlogIoAdapter } from "../src/watchlogIo";

export type FakeCall = { op: "read" | "write" | "list"; path: string };

export class FakeAdapter implements WatchlogIoAdapter {
	files = new Map<string, string>();
	calls: FakeCall[] = [];

	/**
	 * Paths armed to simulate a mid-write crash on their next `write()` call
	 * (design.md "Atomic write survives a mid-write crash"): the write lands
	 * only its first half on disk — producing truncated, unparseable JSON,
	 * exactly like a process killed mid-`fs.write` — and then throws. Clears
	 * itself after firing once.
	 */
	private crashOnWrite = new Set<string>();

	constructor(initialFiles: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initialFiles)) {
			this.files.set(path, content);
		}
	}

	simulateCrashOnWrite(path: string): void {
		this.crashOnWrite.add(path);
	}

	async read(path: string): Promise<string> {
		this.calls.push({ op: "read", path });
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`file not found: ${path}`);
		}
		return content;
	}

	async write(path: string, data: string): Promise<void> {
		this.calls.push({ op: "write", path });
		if (this.crashOnWrite.has(path)) {
			this.crashOnWrite.delete(path);
			this.files.set(path, data.slice(0, Math.floor(data.length / 2)));
			throw new Error(`simulated crash while writing: ${path}`);
		}
		this.files.set(path, data);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		this.calls.push({ op: "list", path });
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files = [...this.files.keys()].filter(
			(candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"),
		);
		return { files, folders: [] };
	}
}

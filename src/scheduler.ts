/**
 * Poll timer and single-flight lock (design.md "Decision: Poll-only, 120 s
 * default"; design.md "Single-flight: the scheduler holds a lock so export,
 * import, and manual commands never overlap"; spec.md "Poll Scheduler").
 *
 * Pure timer/lock orchestration — no Obsidian dependency at this layer.
 * `main.ts` supplies the actual export/import task, wires `start()`/`stop()`
 * to plugin `onload`/`onunload`, and routes every manual command (`Export
 * now`, `Import and merge now`, ...) through the same `runExclusive()` lock
 * so a manual command can never run concurrently with a scheduled tick.
 */

/** spec.md "Default interval applies when unconfigured" — design.md "Poll-only, 120s default". */
export const DEFAULT_POLL_SECONDS = 120;
/** design.md "settings range 30 s - 15 min". */
export const MIN_POLL_SECONDS = 30;
export const MAX_POLL_SECONDS = 15 * 60;

/**
 * Clamps a user-supplied poll interval (e.g. from the settings tab) into the
 * supported `[MIN_POLL_SECONDS, MAX_POLL_SECONDS]` range. A non-finite input
 * (NaN, +/-Infinity — e.g. an empty or garbage settings field) falls back to
 * `DEFAULT_POLL_SECONDS` rather than being clamped toward either bound,
 * since neither bound is a more meaningful default than the other for
 * genuinely invalid input.
 */
export function clampPollSeconds(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_POLL_SECONDS;
	}
	const rounded = Math.round(value);
	if (rounded < MIN_POLL_SECONDS) {
		return MIN_POLL_SECONDS;
	}
	if (rounded > MAX_POLL_SECONDS) {
		return MAX_POLL_SECONDS;
	}
	return rounded;
}

export type SchedulerTask = () => Promise<void>;

/**
 * Drives a recurring poll timer and provides the single-flight async lock
 * that both the timer and manual commands share (design.md "Single-flight").
 *
 * `start()` routes every scheduled tick through `runExclusive()`, so a tick
 * that lands while a manual command (or a still-running previous tick) holds
 * the lock is silently skipped rather than queued — the next tick will try
 * again, which matches design.md's "skip the write entirely" preference for
 * the common no-op case over building a queue this plugin does not need.
 */
export class Scheduler {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private locked = false;

	/**
	 * Starts (or restarts) the recurring timer at `seconds` intervals. Each
	 * elapsed interval attempts to run `task` through `runExclusive()`; a
	 * tick's own errors are swallowed here (a scheduled tick must never crash
	 * the timer or Obsidian) — callers that need failure visibility should
	 * have `task` do its own logging, matching every other module's
	 * `LogFn`-based failure handling.
	 */
	start(seconds: number, task: SchedulerTask): void {
		this.stop();
		this.intervalId = setInterval(() => {
			void this.runExclusive(task).catch(() => {
				// A tick's failure must never crash the timer; the task itself
				// is responsible for logging (see other modules' LogFn param).
			});
		}, seconds * 1000);
	}

	/** Stops the recurring timer. Safe to call when not currently running. */
	stop(): void {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	/**
	 * Runs `task` only if no other run (a scheduled tick or another manual
	 * call) is currently in flight. Returns whether `task` actually ran, so a
	 * manual command can tell the user "already syncing" instead of silently
	 * doing nothing. The lock is always released — including when `task`
	 * throws, in which case the original error still propagates to the
	 * caller of `runExclusive`.
	 */
	async runExclusive(task: SchedulerTask): Promise<boolean> {
		if (this.locked) {
			return false;
		}
		this.locked = true;
		try {
			await task();
			return true;
		} finally {
			this.locked = false;
		}
	}
}

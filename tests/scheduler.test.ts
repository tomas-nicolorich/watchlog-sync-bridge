import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_POLL_SECONDS,
	MAX_POLL_SECONDS,
	MIN_POLL_SECONDS,
	Scheduler,
	clampPollSeconds,
} from "../src/scheduler";

describe("clampPollSeconds (spec: Default interval applies when unconfigured; design.md 'Poll-only, 120s default')", () => {
	it("returns the default when the value is not a finite number", () => {
		expect(clampPollSeconds(Number.NaN)).toBe(DEFAULT_POLL_SECONDS);
		expect(clampPollSeconds(Number.POSITIVE_INFINITY)).toBe(DEFAULT_POLL_SECONDS);
	});

	it("clamps a value below the minimum up to 30s", () => {
		expect(clampPollSeconds(5)).toBe(MIN_POLL_SECONDS);
	});

	it("clamps a value above the maximum down to 15 minutes", () => {
		expect(clampPollSeconds(10_000)).toBe(MAX_POLL_SECONDS);
	});

	it("passes an in-range value through, rounded to the nearest second", () => {
		expect(clampPollSeconds(200.4)).toBe(200);
	});
});

describe("Scheduler poll timer (spec: Poll works on mobile without native fs events — pure timer-driven)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs the task once per elapsed poll interval", async () => {
		const task = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler();

		scheduler.start(30, task);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(task).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(task).toHaveBeenCalledTimes(2);
	});

	it("stops firing once stop() is called", async () => {
		const task = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler();

		scheduler.start(30, task);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(task).toHaveBeenCalledTimes(1);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(task).toHaveBeenCalledTimes(1);
	});
});

describe("Scheduler single-flight lock (design.md 'Single-flight: the scheduler holds a lock so export, import, and manual commands never overlap')", () => {
	it("refuses a second runExclusive call while the first is still in flight", async () => {
		const scheduler = new Scheduler();
		let resolveFirst: () => void = () => {};
		const first = () =>
			new Promise<void>((resolve) => {
				resolveFirst = resolve;
			});

		const firstRunPromise = scheduler.runExclusive(first);
		const secondRan = await scheduler.runExclusive(async () => {});

		expect(secondRan).toBe(false);

		resolveFirst();
		expect(await firstRunPromise).toBe(true);
	});

	it("allows a later call once the lock has been released", async () => {
		const scheduler = new Scheduler();

		const firstRan = await scheduler.runExclusive(async () => {});
		const secondRan = await scheduler.runExclusive(async () => {});

		expect(firstRan).toBe(true);
		expect(secondRan).toBe(true);
	});

	it("releases the lock even when the task throws", async () => {
		const scheduler = new Scheduler();

		await expect(
			scheduler.runExclusive(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const ranAfterFailure = await scheduler.runExclusive(async () => {});
		expect(ranAfterFailure).toBe(true);
	});

	it("driven tick from the poll timer never overlaps with a concurrent manual runExclusive call", async () => {
		vi.useFakeTimers();
		try {
			const scheduler = new Scheduler();
			let concurrent = 0;
			let maxConcurrent = 0;
			const task = async () => {
				concurrent += 1;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await Promise.resolve();
				concurrent -= 1;
			};

			scheduler.start(30, task);
			await vi.advanceTimersByTimeAsync(30_000);
			await scheduler.runExclusive(task);

			expect(maxConcurrent).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

import { describe, expect, it } from "vitest";
import { reconcileTitleState, scalarHash } from "../src/titleState";
import type { TitleEntry, TitleMeta } from "../src/types";

const NOW = 1_700_000_000_000;

describe("reconcileTitleState", () => {
	it("seeds an unknown id at baseline lastModified 0, not the current time (spec: Newly observed titles seed lastModified at baseline 0)", () => {
		const titles: TitleEntry[] = [{ id: "a", rating: 7, dateAdded: "2024-01-01" }];
		const priorState: Record<string, TitleMeta> = {};

		const result = reconcileTitleState(titles, priorState, NOW);

		expect(result.a?.lastModified).toBe(0);
		expect(result.a?.scalarHash).toBe(scalarHash(titles[0] as TitleEntry));
	});

	it("bumps lastModified to now and stores the new hash when scalarHash differs from the stored snapshot (spec: Editing a title's rating updates its tracked lastModified)", () => {
		const before: TitleEntry = { id: "a", rating: 7, dateAdded: "2024-01-01" };
		const after: TitleEntry = { id: "a", rating: 9, dateAdded: "2024-01-01" };
		const priorState: Record<string, TitleMeta> = {
			a: { lastModified: 100, scalarHash: scalarHash(before) },
		};

		const result = reconcileTitleState([after], priorState, NOW);

		expect(result.a?.lastModified).toBe(NOW);
		expect(result.a?.scalarHash).toBe(scalarHash(after));
	});

	it("does not bump lastModified when scalarHash is unchanged (spec: Unchanged titles do not get their lastModified bumped)", () => {
		const entry: TitleEntry = { id: "a", rating: 7, dateAdded: "2024-01-01" };
		const priorState: Record<string, TitleMeta> = {
			a: { lastModified: 100, scalarHash: scalarHash(entry) },
		};

		const result = reconcileTitleState([entry], priorState, NOW);

		expect(result.a?.lastModified).toBe(100);
		expect(result.a?.scalarHash).toBe(scalarHash(entry));
	});

	it("keeps a state entry for an id that has disappeared from the current titles list (deletions never propagate)", () => {
		const priorState: Record<string, TitleMeta> = {
			gone: { lastModified: 42, scalarHash: "deadbeef" },
		};

		const result = reconcileTitleState([], priorState, NOW);

		expect(result.gone).toEqual({ lastModified: 42, scalarHash: "deadbeef" });
	});

	it("ignores id, dateAdded, and history when computing scalarHash (they are append-style facts, not edits)", () => {
		const a: TitleEntry = { id: "a", rating: 7, dateAdded: "2024-01-01", history: [{ id: "h1" }] };
		const b: TitleEntry = { id: "a", rating: 7, dateAdded: "2099-12-31", history: [{ id: "h2" }, { id: "h3" }] };

		expect(scalarHash(a)).toBe(scalarHash(b));
	});

	it("ignores dateModified and communityRatingLastFetched when computing scalarHash (spike b2, 2026-09-07: WatchLog rewrites these on its own background refreshes, not on user edits)", () => {
		const a: TitleEntry = { id: "a", rating: 7, dateModified: "2024-01-01T00:00:00Z", communityRatingLastFetched: "2024-01-01T00:00:00Z" };
		const b: TitleEntry = { id: "a", rating: 7, dateModified: "2099-12-31T00:00:00Z", communityRatingLastFetched: "2099-12-31T00:00:00Z" };

		expect(scalarHash(a)).toBe(scalarHash(b));
	});

	it("still detects a real rating edit even when dateModified also changes alongside it", () => {
		const before: TitleEntry = { id: "a", rating: 7, dateModified: "2024-01-01T00:00:00Z" };
		const after: TitleEntry = { id: "a", rating: 9, dateModified: "2024-01-02T00:00:00Z" };
		const priorState: Record<string, TitleMeta> = {
			a: { lastModified: 100, scalarHash: scalarHash(before) },
		};

		const result = reconcileTitleState([after], priorState, NOW);

		expect(result.a?.lastModified).toBe(NOW);
	});

	it("skips entries lacking a string id (defensive passthrough, per design.md TitleEntry contract)", () => {
		const titles = [{ rating: 5 } as unknown as TitleEntry];

		const result = reconcileTitleState(titles, {}, NOW);

		expect(Object.keys(result)).toEqual([]);
	});
});

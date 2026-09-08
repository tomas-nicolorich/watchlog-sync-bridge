import { describe, expect, it } from "vitest";
import { mergeTitles, type PeerExport } from "../src/merge";
import { reconcileTitleState } from "../src/titleState";
import type { TitleEntry, TitleMeta } from "../src/types";

describe("mergeTitles — Per-ID Union Merge", () => {
	it("unions entries by id across local and peers — concurrent adds on two devices both survive (spec: Concurrent adds on two devices both survive)", () => {
		const localTitles: TitleEntry[] = [{ id: "x", dateAdded: "2024-01-01" }];
		const peerEntry: TitleEntry = { id: "y", dateAdded: "2024-01-02" };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { y: peerEntry }, titleMeta: { y: { lastModified: 0, scalarHash: "h" } } },
		];

		const result = mergeTitles(localTitles, {}, peers, "device-a");

		expect(result.titles.map((t) => t.id).sort()).toEqual(["x", "y"]);
		expect(result.addedIds).toEqual(["y"]);
	});

	it("never drops an entry present in any source (|result| >= |local|)", () => {
		const local: TitleEntry[] = [{ id: "x", dateAdded: "2024-01-01" }];
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: {}, titleMeta: {} }];

		const result = mergeTitles(local, {}, peers, "device-a");

		expect(result.titles.length).toBeGreaterThanOrEqual(local.length);
		expect(result.titles.map((t) => t.id)).toContain("x");
	});
});

describe("mergeTitles — History Union and De-duplication", () => {
	it("unions history entries from both sides with a stable id (spec: History additions from two devices both survive)", () => {
		const local: TitleEntry = { id: "x", dateAdded: "2024-01-01", history: [{ id: "h1", note: "watched" }] };
		const peerEntry: TitleEntry = { id: "x", dateAdded: "2024-01-01", history: [{ id: "h2", note: "rewatched" }] };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 0, scalarHash: "h" } } },
		];

		const result = mergeTitles([local], { x: { lastModified: 0, scalarHash: "h" } }, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.history).toHaveLength(2);
		expect(merged?.history).toEqual(
			expect.arrayContaining([
				{ id: "h1", note: "watched" },
				{ id: "h2", note: "rewatched" },
			]),
		);
	});

	it("does not duplicate history when re-merging the same peer export (spec: Re-merging the same peer export does not duplicate history)", () => {
		const local: TitleEntry = { id: "x", dateAdded: "2024-01-01", history: [{ id: "h1" }] };
		const peerEntry: TitleEntry = { id: "x", dateAdded: "2024-01-01", history: [{ id: "h1" }] };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 0, scalarHash: "h" } } },
		];

		const first = mergeTitles([local], { x: { lastModified: 0, scalarHash: "h" } }, peers, "device-a");
		const second = mergeTitles(first.titles, first.meta, peers, "device-a");

		expect(second.titles.find((t) => t.id === "x")?.history).toEqual([{ id: "h1" }]);
	});

	it("falls back to a content-hash de-dup key when history entries lack a stable id (spec: Spike finds no stable history de-dup key)", () => {
		const local: TitleEntry = { id: "x", history: [{ note: "same event", ts: 1 }] };
		const peerEntry: TitleEntry = { id: "x", history: [{ note: "same event", ts: 1 }] };
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: {} }];

		const result = mergeTitles([local], {}, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.history).toHaveLength(1);
	});

	it("keeps two content-different history entries separate even without stable ids", () => {
		const local: TitleEntry = { id: "x", history: [{ note: "event A", ts: 1 }] };
		const peerEntry: TitleEntry = { id: "x", history: [{ note: "event B", ts: 2 }] };
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: {} }];

		const result = mergeTitles([local], {}, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.history).toHaveLength(2);
	});

	it("uses earliest-wins semantics for dateAdded when the same id is created independently on two devices (spec: dateAdded uses earliest-wins semantics)", () => {
		const local: TitleEntry = { id: "x", dateAdded: "2024-02-01" };
		const peerEntry: TitleEntry = { id: "x", dateAdded: "2024-01-01" };
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: {} }];

		const result = mergeTitles([local], {}, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.dateAdded).toBe("2024-01-01");
	});
});

describe("mergeTitles — Cross-Device Propagation of Scalar Field Edits", () => {
	it("peer's scalar values win when the peer's lastModified is newer (spec: Scalar field edited on device A propagates to device B)", () => {
		const local: TitleEntry = { id: "x", rating: 5, dateAdded: "2024-01-01" };
		const peerEntry: TitleEntry = { id: "x", rating: 9, dateAdded: "2024-01-01" };
		const localMeta: Record<string, TitleMeta> = { x: { lastModified: 100, scalarHash: "local-hash" } };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 200, scalarHash: "peer-hash" } } },
		];

		const result = mergeTitles([local], localMeta, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.rating).toBe(9);
		expect(result.meta.x?.lastModified).toBe(200);
	});

	it("local's scalar values win when local's lastModified is newer", () => {
		const local: TitleEntry = { id: "x", rating: 5, dateAdded: "2024-01-01" };
		const peerEntry: TitleEntry = { id: "x", rating: 9, dateAdded: "2024-01-01" };
		const localMeta: Record<string, TitleMeta> = { x: { lastModified: 300, scalarHash: "local-hash" } };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 200, scalarHash: "peer-hash" } } },
		];

		const result = mergeTitles([local], localMeta, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.rating).toBe(5);
		expect(result.meta.x?.lastModified).toBe(300);
	});

	it("converges both directions on device B's edit when T2 is later than T1 (spec: Concurrent scalar edits on both devices — later lastModified wins)", () => {
		const local: TitleEntry = { id: "x", notes: "edited on A at T1" };
		const peerEntry: TitleEntry = { id: "x", notes: "edited on B at T2" };
		const localMeta: Record<string, TitleMeta> = { x: { lastModified: 1000, scalarHash: "t1" } }; // T1
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 2000, scalarHash: "t2" } } }, // T2 > T1
		];

		const result = mergeTitles([local], localMeta, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.notes).toBe("edited on B at T2");
		expect(result.meta.x?.lastModified).toBe(2000);
	});

	it("breaks an exact lastModified tie by the lexicographically smaller deviceId, converging regardless of which device runs the merge (spec: Equal tracked lastModified values resolve by deterministic deviceId order)", () => {
		const entryOnA: TitleEntry = { id: "x", rating: 1, dateAdded: "2024-01-01" };
		const entryOnB: TitleEntry = { id: "x", rating: 2, dateAdded: "2024-01-01" };

		// Merge runs on device-b (local = B's entry, peer = A's entry).
		const resultOnB = mergeTitles(
			[entryOnB],
			{ x: { lastModified: 0, scalarHash: "b" } },
			[{ deviceId: "device-a", titles: { x: entryOnA }, titleMeta: { x: { lastModified: 0, scalarHash: "a" } } }],
			"device-b",
		);

		// Merge runs on device-a (local = A's entry, peer = B's entry).
		const resultOnA = mergeTitles(
			[entryOnA],
			{ x: { lastModified: 0, scalarHash: "a" } },
			[{ deviceId: "device-b", titles: { x: entryOnB }, titleMeta: { x: { lastModified: 0, scalarHash: "b" } } }],
			"device-a",
		);

		// "device-a" sorts smaller than "device-b", so A's entry (rating 1) wins on both sides.
		expect(resultOnB.titles.find((t) => t.id === "x")?.rating).toBe(1);
		expect(resultOnA.titles.find((t) => t.id === "x")?.rating).toBe(1);
	});

	it("persists the winner's lastModified verbatim, never the current time, to prevent cross-device ping-pong (spec: Merged lastModified is copied from the winner, not stamped with the current time)", () => {
		const local: TitleEntry = { id: "x", rating: 1, dateAdded: "2024-01-01" };
		const peerEntry: TitleEntry = { id: "x", rating: 2, dateAdded: "2024-01-01" };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 555, scalarHash: "h" } } },
		];

		const result = mergeTitles([local], { x: { lastModified: 100, scalarHash: "h2" } }, peers, "device-a");

		expect(result.meta.x?.lastModified).toBe(555);
	});

	it("history edits in place (not appends) are not required to be detected or propagated (spec: History edits (not appends) remain out of scope)", () => {
		const local: TitleEntry = { id: "x", history: [{ id: "h1", note: "original" }] };
		const peerEntry: TitleEntry = { id: "x", history: [{ id: "h1", note: "edited in place on peer" }] };
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: {} }];

		const result = mergeTitles([local], {}, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		// Same historyKey ("id:h1") means the local copy is kept as-is; the
		// in-place edit is not required to propagate (out of scope for v1).
		expect(merged?.history).toEqual([{ id: "h1", note: "original" }]);
	});
});

describe("mergeTitles — Deletion Non-Propagation", () => {
	it("does not remove a local entry that is absent from a peer's export (spec: Deleting an entry on device A does not remove it on device B)", () => {
		const local: TitleEntry[] = [{ id: "x", dateAdded: "2024-01-01" }];
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: {}, titleMeta: {} }];

		const result = mergeTitles(local, {}, peers, "device-a");

		expect(result.titles.map((t) => t.id)).toContain("x");
	});

	it("treats a scalar-field edit as an edit, not a delete-then-recreate — id, dateAdded, and history stay stable (spec: Editing a title is never mistaken for a delete-then-recreate)", () => {
		const local: TitleEntry = { id: "x", dateAdded: "2024-01-01", history: [{ id: "h1" }], rating: 3 };
		const peerEntry: TitleEntry = { id: "x", dateAdded: "2024-01-01", history: [{ id: "h1" }], rating: 8 };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 999, scalarHash: "h" } } },
		];

		const result = mergeTitles([local], { x: { lastModified: 0, scalarHash: "h2" } }, peers, "device-a");
		const merged = result.titles.find((t) => t.id === "x");

		expect(merged?.id).toBe("x");
		expect(merged?.dateAdded).toBe("2024-01-01");
		expect(merged?.history).toEqual([{ id: "h1" }]);
		expect(merged?.rating).toBe(8);
	});

	it("does not treat ids missing from a peer snapshot as tombstones (spec: Missing ids in a peer snapshot are not treated as tombstones)", () => {
		const local: TitleEntry[] = [
			{ id: "x", dateAdded: "2024-01-01" },
			{ id: "y", dateAdded: "2024-01-02" },
		];
		// The peer previously had both but now only reports "y".
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: { y: { id: "y", dateAdded: "2024-01-02" } }, titleMeta: {} }];

		const result = mergeTitles(local, {}, peers, "device-a");

		expect(result.titles.map((t) => t.id).sort()).toEqual(["x", "y"]);
	});
});

describe("mergeTitles — required invariants (design.md)", () => {
	it("is idempotent: merging the merge output against the same peers again produces no further change", () => {
		const local: TitleEntry = { id: "x", rating: 1, dateAdded: "2024-01-05" };
		const peerEntry: TitleEntry = { id: "x", rating: 9, dateAdded: "2024-01-01", history: [{ id: "h1" }] };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 500, scalarHash: "peer-hash" } } },
		];

		const first = mergeTitles([local], { x: { lastModified: 0, scalarHash: "local-hash" } }, peers, "device-a");
		const second = mergeTitles(first.titles, first.meta, peers, "device-a");

		expect(second.titles).toEqual(first.titles);
		expect(second.meta).toEqual(first.meta);
		expect(second.changedIds).toEqual([]);
		expect(second.addedIds).toEqual([]);
	});

	it("is commutative in peer processing order: two peers merged in either order converge on the same result", () => {
		const local: TitleEntry[] = [{ id: "x", rating: 1, dateAdded: "2024-01-01" }];
		const localMeta: Record<string, TitleMeta> = { x: { lastModified: 100, scalarHash: "l" } };
		const peerB: PeerExport = {
			deviceId: "device-b",
			titles: { x: { id: "x", rating: 2, dateAdded: "2024-01-01" } },
			titleMeta: { x: { lastModified: 200, scalarHash: "b" } },
		};
		const peerC: PeerExport = {
			deviceId: "device-c",
			titles: { y: { id: "y", dateAdded: "2024-02-01" } },
			titleMeta: { y: { lastModified: 0, scalarHash: "c" } },
		};

		const orderBC = mergeTitles(local, localMeta, [peerB, peerC], "device-a");
		const orderCB = mergeTitles(local, localMeta, [peerC, peerB], "device-a");

		expect(orderBC.titles).toEqual(orderCB.titles);
		expect(orderBC.meta).toEqual(orderCB.meta);
	});

	it("never produces fewer titles than the local input (|result| >= |local|)", () => {
		const local: TitleEntry[] = [{ id: "x", dateAdded: "2024-01-01" }];
		const peers: PeerExport[] = [{ deviceId: "device-b", titles: {}, titleMeta: {} }];

		const result = mergeTitles(local, {}, peers, "device-a");

		expect(result.titles.length).toBeGreaterThanOrEqual(local.length);
	});

	it("reaches a fixpoint: reconciling the merged output against itself bumps nothing (anti-ping-pong)", () => {
		const local: TitleEntry = { id: "x", rating: 1, dateAdded: "2024-01-01" };
		const peerEntry: TitleEntry = { id: "x", rating: 9, dateAdded: "2024-01-01" };
		const peers: PeerExport[] = [
			{ deviceId: "device-b", titles: { x: peerEntry }, titleMeta: { x: { lastModified: 500, scalarHash: "peer-hash" } } },
		];

		const merged = mergeTitles([local], { x: { lastModified: 100, scalarHash: "local-hash" } }, peers, "device-a");

		// Simulate the importing device's next poll cycle reconciling its own
		// merge output — this must NOT bump lastModified (design.md
		// "Ping-pong prevention (load-bearing)").
		const reconciled = reconcileTitleState(merged.titles, merged.meta, 999_999_999);

		expect(reconciled).toEqual(merged.meta);
	});
});

/**
 * Canonical JSON + FNV-1a 64-bit hashing.
 *
 * Pure, zero-Obsidian-dependency module (design.md module boundaries table).
 * Used for change detection (titleState.ts), scalar-field hashing, and
 * history entry de-dup fallback (merge.ts).
 */

/**
 * Produces a stable JSON string for any JSON-compatible value: object keys
 * are sorted recursively at every depth so two structurally-equal values
 * (regardless of key insertion order) always canonicalize to the same
 * string. Arrays are NOT reordered — element order is significant data.
 */
export function canonical(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (value !== null && typeof value === "object") {
		const sortedEntries = Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])] as const);
		return Object.fromEntries(sortedEntries);
	}
	return value;
}

// FNV-1a 64-bit constants.
// NOTE: built via BigInt(hexString) rather than `123n` literal syntax on
// purpose — esbuild's es2018 bundle target (design.md, esbuild.config.mjs)
// rejects BigInt *literal syntax* outright ("Big integer literals are not
// available in the configured target environment"), even though the BigInt
// runtime value itself is fully supported by Obsidian's Electron/Chromium.
// A `BigInt(...)` call is just a function call, not literal syntax, so it
// passes through es2018 output unchanged.
const FNV_OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");

/**
 * FNV-1a 64-bit hash of a UTF-8 string, returned as a lowercase hex digest.
 * Deterministic, fast, and collision-resistant enough for our purposes
 * (change detection and de-dup keys, not cryptographic security).
 */
export function fnv1a(input: string): string {
	let hash = FNV_OFFSET_BASIS;
	const bytes = new TextEncoder().encode(input);
	for (const byte of bytes) {
		hash ^= BigInt(byte);
		hash = (hash * FNV_PRIME) & MASK_64;
	}
	return hash.toString(16).padStart(16, "0");
}

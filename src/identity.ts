/**
 * Device identity: create/persist a stable per-device id and sanitize it for
 * safe use in a filename (design.md "Device identity from a self-generated
 * UUID in the plugin's own data.json"; spec.md "Device Identity").
 *
 * Pure — no Obsidian dependency (design.md module boundaries: `src/identity.ts`,
 * "No (data via main)"). `main.ts` owns reading/writing `BridgeData` and
 * supplies the UUID generator (`crypto.randomUUID`); this module only decides
 * which value to use and how to sanitize it.
 */

/** design.md: "deviceId is sanitized to [a-z0-9-]{1,40} before use in a path". */
const MAX_SANITIZED_LENGTH = 40;

/** Used only when sanitizing would otherwise produce an empty string (e.g.
 * an all-symbol input) — keeps the result a valid, non-empty path segment. */
const FALLBACK_DEVICE_ID = "device";

/**
 * Returns the existing stored device id unchanged (spec.md "Device id
 * persists across restarts": same device id and export filename MUST be
 * reused across an Obsidian restart/reload). Generates and returns a new id
 * via the injected `generateUuid` only when none is stored yet — first run,
 * or a defensively-treated empty stored value.
 */
export function getOrCreateDeviceId(storedDeviceId: string | undefined, generateUuid: () => string): string {
	if (typeof storedDeviceId === "string" && storedDeviceId.length > 0) {
		return storedDeviceId;
	}
	return generateUuid();
}

/**
 * Sanitizes a device id into a safe filename component matching
 * `[a-z0-9-]{1,40}` (design.md "Decision: Device identity..."): lowercases,
 * replaces every disallowed character with `-`, collapses runs of `-`, trims
 * leading/trailing `-`, and truncates to 40 characters. Falls back to a
 * fixed constant if sanitizing would otherwise produce an empty string.
 */
export function sanitizeDeviceIdForFilename(deviceId: string): string {
	const lowered = deviceId.toLowerCase();
	const replaced = lowered.replace(/[^a-z0-9-]/g, "-");
	const collapsed = replaced.replace(/-+/g, "-");
	const trimmed = collapsed.replace(/^-+|-+$/g, "");
	const truncated = trimmed.slice(0, MAX_SANITIZED_LENGTH);
	return truncated.length > 0 ? truncated : FALLBACK_DEVICE_ID;
}

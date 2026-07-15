import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync, renameSync } from "node:fs";

const DEFAULT_PROFILES_DIR = "~/.pi/faces";
const LEGACY_PROFILES_DIR = "~/.pi/agent-profiles";

let migrated = false;
let cachedRealProfilesRoot: string | undefined;

/**
 * One-time migration from the legacy `~/.pi/agent-profiles` dir to `~/.pi/faces`.
 * Only runs when `PI_PROFILES_DIR` is NOT set (using the default) AND the new dir
 * doesn't exist AND the legacy dir does — renames legacy → new so existing
 * profiles keep working. Idempotent (guarded by `migrated`).
 */
function migrateLegacyProfilesDir(): void {
	if (migrated) return;
	migrated = true;
	if (typeof process !== "undefined" && process.env && process.env.PI_PROFILES_DIR) return;
	const legacy = expandTilde(LEGACY_PROFILES_DIR);
	const next = expandTilde(DEFAULT_PROFILES_DIR);
	if (!existsSync(next) && existsSync(legacy)) {
		try {
			renameSync(legacy, next);
		} catch {
			// rename failed (cross-device / permissions) — leave legacy in place;
			// the user can move it manually.
		}
	}
}

/** Expand a leading `~/` to the user's home directory. */
export function expandTilde(p: string): string {
	if (p.startsWith("~/")) {
		return os.homedir() + p.slice(1);
	}
	return p;
}

/** Resolve the profiles directory, honoring the PI_PROFILES_DIR env override. */
export function profilesDir(): string {
	migrateLegacyProfilesDir();
	return expandTilde(
		(typeof process !== "undefined" && process.env && process.env.PI_PROFILES_DIR) ||
			DEFAULT_PROFILES_DIR
	);
}

/** Cached realpath of the profiles root, used for prompt-file containment checks. */
export function realProfilesRoot(): string {
	if (cachedRealProfilesRoot === undefined) {
		cachedRealProfilesRoot = realpathSync(profilesDir());
	}
	return cachedRealProfilesRoot;
}

/** Reset the cached real profiles root (useful in tests that override PI_PROFILES_DIR). */
export function resetRealProfilesRoot(): void {
	cachedRealProfilesRoot = undefined;
}

/** Full path to a profile JSON file. */
export function profilePath(name: string): string {
	return path.join(profilesDir(), name + ".json");
}

/**
 * Path to the package config file. Override with PI_PROFILES_CONFIG. Lives in a
 * subdir so listProfiles() (which scans top-level *.json) never mistakes it for
 * a profile.
 */
export function configPath(): string {
	const override =
		typeof process !== "undefined" && process.env && process.env.PI_PROFILES_CONFIG;
	if (override) return expandTilde(override);
	return path.join(profilesDir(), "config", "config.json");
}
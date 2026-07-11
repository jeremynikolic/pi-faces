import os from "node:os";
import path from "node:path";

const DEFAULT_PROFILES_DIR = "~/.pi/agent-profiles";

/** Expand a leading `~/` to the user's home directory. */
export function expandTilde(p: string): string {
	if (p.startsWith("~/")) {
		return os.homedir() + p.slice(1);
	}
	return p;
}

/** Resolve the profiles directory, honoring the PI_PROFILES_DIR env override. */
export function profilesDir(): string {
	return expandTilde(
		(typeof process !== "undefined" && process.env && process.env.PI_PROFILES_DIR) ||
			DEFAULT_PROFILES_DIR
	);
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
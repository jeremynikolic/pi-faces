import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { profilesDir } from "./paths.ts";
import { seedDefaultProfiles } from "./defaults.ts";
import { ProfileApplier } from "./apply.ts";
import { SessionNamePrefix } from "./session-prefix.ts";
import { registerProfilesCommand } from "./commands.ts";

// Re-export public helpers so tests and consumers can import them from the
// package entry. The factory below is the pi extension entry point.
export { readSystemPromptFile, readBoundedFile, isValidProfileName, parseProfileFile } from "./profile.ts";
export { parseConfigFile } from "./config.ts";
export { hasProfilePrefix, withProfilePrefix } from "./prefix.ts";
export { parseModelRef } from "./apply.ts";
export * from "./limits.ts";
export type { Profile, PackageConfig } from "./types.ts";

/**
 * Best-effort tighten storage modes for the default profiles directory.
 * Dir → 0700; top-level *.json, .defaults-seeded, and config/config.json → 0600.
 * Swallows errors so permission issues do not break extension startup.
 * Skipped entirely when PI_PROFILES_DIR is set (do not chmod a user-managed dir).
 */
function tightenStorageModes(dir: string): void {
	try {
		chmodSync(dir, 0o700);
	} catch {
		// best-effort
	}

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.endsWith(".json") || entry === ".defaults-seeded") {
			try {
				chmodSync(path.join(dir, entry), 0o600);
			} catch {
				// best-effort
			}
		}
	}

	try {
		chmodSync(path.join(dir, "config", "config.json"), 0o600);
	} catch {
		// best-effort
	}
}

/**
 * pi-faces extension entry point.
 *
 * Seeds default profiles on first run, registers the `--profile` flag, applies
 * the active profile before each agent start, prefixes the session name while a
 * profile is active, and registers the `/profiles` management command.
 */
export default function (pi: ExtensionAPI) {
	// Seed default profiles into the default dir on first run. Skipped when the
	// user overrides PI_PROFILES_DIR (they own that dir); never overwrites
	// existing files; a marker file makes this run once per directory.
	const hasProfilesDirOverride =
		typeof process !== "undefined" && !!process.env && Boolean(process.env.PI_PROFILES_DIR);
	if (!hasProfilesDirOverride) {
		const dir = profilesDir();
		seedDefaultProfiles(dir);
		tightenStorageModes(dir);
	}

	// Register the --profile CLI flag
	pi.registerFlag("profile", {
		type: "string",
		description: "Agent profile name (loads ~/.pi/agent-profiles/<name>.json)",
	});

	// Apply the profile: model/thinking/tools once at session start (so the
	// agent shows the profile's model/thinking at startup, not pi defaults);
	// system prompt every turn.
	const applier = new ProfileApplier(pi);
	pi.on("session_start", (event, ctx) => applier.handleSessionStart(event, ctx));
	pi.on("before_agent_start", (event, ctx) => applier.handleBeforeAgentStart(event, ctx));
	pi.on("resources_discover", (event, ctx) => applier.handleResourcesDiscover(event, ctx));

	// Prefix the session display name with [profile] while a profile is active.
	new SessionNamePrefix(pi).register();

	// Register the /profiles management command.
	registerProfilesCommand(pi);
}

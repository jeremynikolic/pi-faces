import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { profilesDir } from "./paths.ts";
import { seedDefaultProfiles } from "./defaults.ts";
import { ActiveProfileResolver, FACE_ENTRY_TYPE, renderFaceEntry, type FaceEntryData } from "./active-profile.ts";
import { ProfileApplier } from "./apply.ts";
import { SessionNamePrefix } from "./session-prefix.ts";
import { registerFaceCommand, registerProfilesCommand } from "./commands.ts";

// Re-export public helpers so tests and consumers can import them from the
// package entry. The factory below is the pi extension entry point.
export { resolvePromptValue, readBoundedFile, isValidProfileName, parseProfileFile, THINKING_LEVELS, SUPPORTED_PROFILE_KEYS } from "./profile.ts";
export { parseConfigFile } from "./config.ts";
export { hasProfilePrefix, withProfilePrefix, replaceProfilePrefix } from "./prefix.ts";
export { parseModelRef } from "./apply.ts";
export { FACE_ENTRY_TYPE, renderFaceEntry, type FaceEntryData } from "./active-profile.ts";
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
 * profile is active, and registers the `/profiles` and `/face` management
 * commands.
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
		description: "Agent profile name (loads ~/.pi/faces/<name>.json)",
	});

	// Selection resolver: persisted branch entries beat the --profile flag, and
	// the explicit off sentinel (`profile: null`) beats the flag on reload.
	const resolver = new ActiveProfileResolver(pi);

	// Apply the profile: model/thinking/tools once at session start (so the
	// agent shows the profile's model/thinking at startup, not pi defaults);
	// system prompt every turn.
	const applier = new ProfileApplier(pi, resolver);
	pi.on("session_start", (event, ctx) => resolver.handleSessionStart(event, ctx));
	pi.on("session_start", (event, ctx) => applier.handleSessionStart(event, ctx));
	pi.on("before_agent_start", (event, ctx) => applier.handleBeforeAgentStart(event, ctx));
	pi.on("resources_discover", (event, ctx) => applier.handleResourcesDiscover(event, ctx));

	// Compact renderer for persisted face entries.
	pi.registerEntryRenderer<FaceEntryData>(FACE_ENTRY_TYPE, (entry) => renderFaceEntry(entry));

	// Prefix the session display name with [profile] while a profile is active.
	const prefix = new SessionNamePrefix(pi, resolver);
	prefix.register();

	// Register the /profiles management command and the /face swap command.
	registerProfilesCommand(pi);
	registerFaceCommand(pi, resolver, applier, prefix);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { profilesDir } from "./paths.ts";
import { seedDefaultProfiles } from "./defaults.ts";
import { ProfileApplier } from "./apply.ts";
import { SessionNamePrefix } from "./session-prefix.ts";
import { registerProfilesCommand } from "./commands.ts";

// Re-export public helpers so tests and consumers can import them from the
// package entry. The factory below is the pi extension entry point.
export { resolveSystemPrompt, isValidProfileName, parseProfileFile } from "./profile.ts";
export { parseConfigFile } from "./config.ts";
export { hasProfilePrefix, withProfilePrefix } from "./prefix.ts";
export type { Profile, PackageConfig } from "./types.ts";

/**
 * pi-agent-profiles extension entry point.
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
		seedDefaultProfiles(profilesDir());
	}

	// Register the --profile CLI flag
	pi.registerFlag("profile", {
		type: "string",
		description: "Agent profile name (loads ~/.pi/agent-profiles/<name>.json)",
	});

	// Apply the profile before the agent starts (model/thinking/tools once per
	// session; system prompt every turn).
	const applier = new ProfileApplier(pi);
	pi.on("before_agent_start", (event, ctx) => applier.handleBeforeAgentStart(event, ctx));

	// Prefix the session display name with [profile] while a profile is active.
	new SessionNamePrefix(pi).register();

	// Register the /profiles management command.
	registerProfilesCommand(pi);
}
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfigFile } from "./config.ts";
import { isValidProfileName } from "./profile.ts";
import { withProfilePrefix } from "./prefix.ts";

/**
 * Prefixes the session display name with `[<profile-name>]` while a profile is
 * active, so sessions group in /resume and `pi -r`. Covers three name-setting
 * paths:
 *   - startup --name: applied to the session file before extensions load, so
 *     session_start reads it back via getSessionName()
 *   - /name slash command and RPC setSessionName(): fires session_info_changed
 *   - this extension's own setSessionName(): re-fires session_info_changed;
 *     withProfilePrefix() short-circuits to prevent a re-entrant loop
 *
 * The prefix is enabled by default; disable it via the package config file
 * (`{ "prefix_session_name": false }`).
 */
export class SessionNamePrefix {
	private configIssueWarned = false;

	constructor(private readonly pi: ExtensionAPI) {}

	/** Wire session_start and session_info_changed handlers. */
	register(): void {
		// session_start covers startup --name, /new, /resume, /fork, and reload.
		// On resume/fork the loaded name may already carry the prefix from a
		// prior run; withProfilePrefix skips it. On /new there is no name yet;
		// the later session_info_changed from /name applies the prefix.
		this.pi.on("session_start", async () => {
			this.applyPrefixTo(this.pi.getSessionName());
		});

		// session_info_changed covers /name, RPC setSessionName(), and our own
		// re-entrant setSessionName() (which withProfilePrefix short-circuits).
		this.pi.on("session_info_changed", async (event) => {
			this.applyPrefixTo(event.name);
		});
	}

	private applyPrefixTo(name: string | undefined): void {
		if (!this.prefixEnabled()) return;
		const profileName = this.activeProfileName();
		if (!profileName) return;
		const prefixed = withProfilePrefix(name, profileName);
		if (prefixed) this.pi.setSessionName(prefixed);
	}

	private prefixEnabled(): boolean {
		const result = readConfigFile();
		if (!result.ok) {
			if (!this.configIssueWarned) {
				console.warn("[pi-agent-profiles] " + result.error);
				this.configIssueWarned = true;
			}
			return true; // default on when config is unreadable
		}
		if (!this.configIssueWarned && result.warnings.length > 0) {
			for (const w of result.warnings) console.warn("[pi-agent-profiles] " + w);
			this.configIssueWarned = true;
		}
		const v = result.config.prefix_session_name;
		return v === undefined ? true : v;
	}

	private activeProfileName(): string | undefined {
		const flag = this.pi.getFlag("profile");
		if (!flag) return undefined;
		const name = typeof flag === "string" ? flag : String(flag);
		return isValidProfileName(name) ? name : undefined;
	}
}
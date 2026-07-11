import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { profilesDir } from "./paths.ts";
import { isValidProfileName, readProfile, resolveSystemPrompt } from "./profile.ts";

/**
 * Applies the active profile in `before_agent_start`. Session-level config
 * (model, thinking, tools) is applied once per session so mid-session user
 * changes (e.g. /model) are not reverted every turn; the system prompt is
 * applied every turn. By default the profile prompt is appended to pi's
 * built-in system prompt — `replace_system_prompt: true` swaps it entirely.
 */
export class ProfileApplier {
	private sessionConfigApplied = false;
	private profileIssueWarned = false;

	constructor(private readonly pi: ExtensionAPI) {}

	async handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext
	): Promise<BeforeAgentStartEventResult | undefined> {
		const flag = this.pi.getFlag("profile");
		if (!flag) return undefined;

		const profileName = typeof flag === "string" ? flag : String(flag);
		if (!isValidProfileName(profileName)) {
			if (!this.profileIssueWarned) {
				console.warn("[pi-agent-profiles] Invalid profile name: \"" + profileName + "\"");
				this.profileIssueWarned = true;
			}
			return undefined;
		}

		const dir = profilesDir();
		const result = readProfile(profileName);

		if (!result.ok) {
			if (!this.profileIssueWarned) {
				console.warn("[pi-agent-profiles] " + result.error);
				this.profileIssueWarned = true;
			}
			return undefined;
		}

		const profile = result.profile;

		// Warn once on unknown fields (typos) so users notice silent misconfig.
		if (!this.sessionConfigApplied && result.warnings.length > 0) {
			for (const w of result.warnings) {
				console.warn("[pi-agent-profiles] " + w);
			}
		}

		// Apply session-level config once.
		if (!this.sessionConfigApplied) {
			this.sessionConfigApplied = true;

			// Model + provider. setModel takes a Model resolved from the registry,
			// not a provider/modelId pair. Require both provider and model.
			const provider = profile.provider;
			const modelId = profile.model;
			if ((provider && !modelId) || (modelId && !provider)) {
				console.warn(
					"[pi-agent-profiles] profile \"" + profileName + "\": provider and model must both be set to change the model"
				);
			} else if (provider && modelId && ctx.modelRegistry) {
				const model = ctx.modelRegistry.find(provider, modelId);
				if (model) {
					try {
						const ok = await this.pi.setModel(model);
						if (!ok) {
							console.warn("[pi-agent-profiles] No API key for " + provider + "/" + modelId);
						}
					} catch (err) {
						console.warn("[pi-agent-profiles] Failed to set model: " + err);
					}
				} else {
					console.warn("[pi-agent-profiles] Model not found: " + provider + "/" + modelId);
				}
			}

			// Thinking level
			const thinking = profile.thinking;
			if (thinking) {
				try {
					this.pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				} catch (err) {
					console.warn("[pi-agent-profiles] Failed to set thinking level: " + err);
				}
			}

			// Tools. Filter to known tools (ghost entries silently no-op in pi
			// but mask misconfigurations), dedup, and warn on unknown names.
			const tools = profile.tools;
			if (tools && tools.length > 0) {
				try {
					const known = new Set(this.pi.getAllTools().map((t) => t.name));
					const knownTools = tools.filter((t) => known.has(t));
					const unknown = tools.filter((t) => !known.has(t));
					if (unknown.length > 0) {
						console.warn(
							"[pi-agent-profiles] Unknown tool(s) in profile, ignored: " + unknown.join(", ")
						);
					}
					// Guard against disabling every tool: if the profile listed only
					// unknown tools, leave the active tool set unchanged.
					if (knownTools.length === 0) {
						console.warn("[pi-agent-profiles] No known tools in profile; tool set unchanged");
					} else {
						this.pi.setActiveTools([...new Set(knownTools)]);
					}
				} catch (err) {
					console.warn("[pi-agent-profiles] Failed to set tools: " + err);
				}
			}
		}

		// System prompt — applied every turn. By default the profile prompt is
		// appended to pi's built-in system prompt so tool guidance and project
		// context survive. replace_system_prompt: true swaps it entirely.
		const systemPrompt = resolveSystemPrompt(profile.system_prompt, dir);
		if (systemPrompt) {
			if (profile.replace_system_prompt) {
				return { systemPrompt };
			}
			return { systemPrompt: event.systemPrompt + "\n\n" + systemPrompt };
		}
		return undefined;
	}
}
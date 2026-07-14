import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expandTilde, realProfilesRoot } from "./paths.ts";
import { isValidProfileName, readProfile, readSystemPromptFile } from "./profile.ts";
import { cliFlagProvided } from "./cli.ts";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Applies the active profile.
 *
 * Session-level config (model, thinking, tools) is applied once in
 * `session_start` so the agent shows the profile's model/thinking at
 * startup (not pi's defaults). The system prompt is cached during
 * `session_start` and applied every turn in `before_agent_start`. By
 * default the profile prompt is appended to pi's built-in system prompt;
 * `replace_system_prompt: true` swaps it entirely.
 *
 * Profile fields are defaults — explicit CLI flags (--model/--provider,
 * --thinking, --tools/-t) skip the corresponding profile field.
 *
 * A profile that fails validation (unknown tools, unreadable prompt file,
 * etc.) is rejected entirely: `profileRejected` is set and no profile
 * policy (model, thinking, tools, prompt, skills) is applied.
 */
export class ProfileApplier {
	private profileIssueWarned = false;
	private profileRejected = false;
	private cachedPrompt: string | undefined;
	private replaceSystemPrompt = false;

	constructor(private readonly pi: ExtensionAPI) {}

	/** Resolve the profile name from the --profile flag, or undefined. */
	private profileName(): string | undefined {
		const flag = this.pi.getFlag("profile");
		if (!flag) return undefined;
		const name = typeof flag === "string" ? flag : String(flag);
		if (!isValidProfileName(name)) {
			if (!this.profileIssueWarned) {
				console.warn("[pi-faces] Invalid profile name: \"" + name + "\"");
				this.profileIssueWarned = true;
			}
			return undefined;
		}
		return name;
	}

	private warnOnce(message: string): void {
		if (!this.profileIssueWarned) {
			console.warn("[pi-faces] " + message);
			this.profileIssueWarned = true;
		}
	}

	/** Apply model/thinking/tools once at session start. */
	async handleSessionStart(_event: unknown, ctx: ExtensionContext): Promise<void> {
		// Defense-in-depth reset: each session_start is a fresh validation
		// opportunity (pi re-fires this on /reload).
		this.profileRejected = false;
		this.cachedPrompt = undefined;
		this.replaceSystemPrompt = false;

		const profileName = this.profileName();
		if (!profileName) return;

		const result = readProfile(profileName);
		if (!result.ok) {
			this.warnOnce(result.error);
			this.profileRejected = true;
			return;
		}
		const profile = result.profile;

		// Warn once on unknown fields (typos).
		for (const w of result.warnings) {
			console.warn("[pi-faces] " + w);
		}

		// Eager prompt-file validation + cache. Reject the whole profile if
		// the declared prompt file is not readable under the profile root.
		if (profile.system_prompt_file) {
			const promptResult = readSystemPromptFile(profile.system_prompt_file, realProfilesRoot());
			if (!promptResult.ok) {
				this.warnOnce("profile \"" + profileName + "\": " + promptResult.error);
				this.profileRejected = true;
				return;
			}
			this.cachedPrompt = promptResult.content;
		} else if (profile.system_prompt) {
			this.cachedPrompt = profile.system_prompt.trim();
		}
		this.replaceSystemPrompt = profile.replace_system_prompt === true;

		// Tools. `tools` is a strict allowlist across every tool source.
		// Unknown names reject the profile. Absent `tools` leaves pi's
		// default untouched. Empty `tools: []` sets zero active tools.
		const tools = profile.tools;
		if (tools !== undefined && tools !== null && !cliFlagProvided("tools", "t")) {
			const all = this.pi.getAllTools();
			const known = new Set(all.map((t) => t.name));
			const unknown = tools.filter((t) => !known.has(t));
			if (unknown.length > 0) {
				this.warnOnce(
					"profile \"" + profileName + "\": unknown tool(s) rejected profile: " + unknown.join(", ")
				);
				this.profileRejected = true;
				return;
			}
			this.pi.setActiveTools([...new Set(tools)]);
		}

		// Model + provider. Skip if the user passed --model or --provider.
		const { provider, modelId, thinkingHint } = parseModelRef(profile.provider, profile.model);
		const modelExplicit = cliFlagProvided("model") || cliFlagProvided("provider");
		if (!modelExplicit) {
			if ((provider && !modelId) || (modelId && !provider)) {
				console.warn(
					"[pi-faces] profile \"" + profileName + "\": provider and model must both be set to change the model"
				);
			} else if (provider && modelId && ctx.modelRegistry) {
				const model = ctx.modelRegistry.find(provider, modelId);
				if (model) {
					try {
						const ok = await this.pi.setModel(model);
						if (!ok) {
							console.warn("[pi-faces] No API key for " + provider + "/" + modelId);
						}
					} catch (err) {
						console.warn("[pi-faces] Failed to set model: " + err);
					}
				} else {
					console.warn("[pi-faces] Model not found: " + provider + "/" + modelId);
				}
			}
		}

		// Thinking level. Skip if the user passed --thinking explicitly.
		const thinking = profile.thinking ?? thinkingHint;
		if (thinking && !cliFlagProvided("thinking")) {
			try {
				this.pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			} catch (err) {
				console.warn("[pi-faces] Failed to set thinking level: " + err);
			}
		}
	}

	/** Apply the cached system prompt every turn. */
	async handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		_ctx: ExtensionContext
	): Promise<BeforeAgentStartEventResult | undefined> {
		if (this.profileRejected) return undefined;
		if (this.cachedPrompt === undefined) return undefined;
		if (this.replaceSystemPrompt) {
			return { systemPrompt: this.cachedPrompt };
		}
		return { systemPrompt: event.systemPrompt + "\n\n" + this.cachedPrompt };
	}

	/** Contribute the profile's curated skill paths (cherry-pick via resources_discover). */
	handleResourcesDiscover(
		_event: { cwd: string; reason: string },
		_ctx: ExtensionContext
	): { skillPaths?: string[] } | undefined {
		if (this.profileRejected) return undefined;

		const profileName = this.profileName();
		if (!profileName) return undefined;

		try {
			const result = readProfile(profileName);
			if (!result.ok) return undefined;
			const skills = result.profile.skills;
			if (!skills || skills.length === 0) return undefined;
			const skillPaths: string[] = [];
			for (const entry of skills) {
				// Entries containing a path separator (or starting with ~) are treated as
				// paths (~/... expanded, relative resolved against cwd, absolute as-is).
				// Bare names are resolved to ~/.pi/skills/<name>.
				const p = entry.includes("/") || entry.startsWith("~")
					? path.resolve(expandTilde(entry))
					: path.join(os.homedir(), ".pi", "skills", entry);
				if (existsSync(p)) {
					skillPaths.push(p);
				} else {
					console.warn("[pi-faces] skill not found, skipping: " + entry + " (" + p + ")");
				}
			}
			if (skillPaths.length === 0) return undefined;
			return { skillPaths };
		} catch (err) {
			this.warnOnce("profile \"" + profileName + "\": failed to discover skills: " + err);
			return undefined;
		}
	}
}

/**
 * Resolve a provider/modelId pair from the profile fields. The `model`
 * field may be a bare id (use the separate `provider`) or a combined
 * "provider/id" (split it; the separate `provider` is ignored in that case).
 */
export function parseModelRef(
	provider: string | undefined,
	model: string | undefined
): { provider: string | undefined; modelId: string | undefined; thinkingHint: string | undefined } {
	let modelId = model;
	let thinkingHint: string | undefined;
	if (typeof model === "string" && model.includes("/")) {
		const slash = model.indexOf("/");
		provider = model.slice(0, slash);
		modelId = model.slice(slash + 1);
	}
	// pi's --model also supports an optional ":<thinking>" suffix. Strip it so
	// modelRegistry.find gets the bare id, and surface it as a thinking hint
	// (used only when the profile has no separate `thinking` field).
	if (typeof modelId === "string" && modelId.includes(":")) {
		const colon = modelId.indexOf(":");
		thinkingHint = modelId.slice(colon + 1);
		modelId = modelId.slice(0, colon);
	}
	return { provider, modelId, thinkingHint };
}

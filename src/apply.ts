import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { profilesDir } from "./paths.ts";
import { isValidProfileName, readProfile, resolveSystemPrompt } from "./profile.ts";
import { cliFlagProvided } from "./cli.ts";

/**
 * Applies the active profile.
 *
 * Session-level config (model, thinking, tools) is applied once in
 * `session_start` so the agent shows the profile's model/thinking at
 * startup (not pi's defaults). The system prompt is applied every turn
 * in `before_agent_start`. By default the profile prompt is appended to
 * pi's built-in system prompt; `replace_system_prompt: true` swaps it
 * entirely.
 *
 * Profile fields are defaults — explicit CLI flags (--model/--provider,
 * --thinking, --tools/-t) skip the corresponding profile field.
 */
export class ProfileApplier {
	private profileIssueWarned = false;

	constructor(private readonly pi: ExtensionAPI) {}

	/** Resolve the profile name from the --profile flag, or undefined. */
	private profileName(): string | undefined {
		const flag = this.pi.getFlag("profile");
		if (!flag) return undefined;
		const name = typeof flag === "string" ? flag : String(flag);
		if (!isValidProfileName(name)) {
			if (!this.profileIssueWarned) {
				console.warn("[pi-agent-profiles] Invalid profile name: \"" + name + "\"");
				this.profileIssueWarned = true;
			}
			return undefined;
		}
		return name;
	}

	/** Apply model/thinking/tools once at session start. */
	async handleSessionStart(_event: unknown, ctx: ExtensionContext): Promise<void> {
		const profileName = this.profileName();
		if (!profileName) return;

		const dir = profilesDir();
		const result = readProfile(profileName);
		if (!result.ok) {
			if (!this.profileIssueWarned) {
				console.warn("[pi-agent-profiles] " + result.error);
				this.profileIssueWarned = true;
			}
			return;
		}
		const profile = result.profile;

		// Warn once on unknown fields (typos).
		for (const w of result.warnings) {
			console.warn("[pi-agent-profiles] " + w);
		}

		// Model + provider. The `model` field accepts either a bare id
		// ("glm-5.2", paired with `provider`), a combined "provider/id"
		// ("ollama-cloud/glm-5.2"), or "provider/id:thinking" (matching pi's
		// --model convention; the :thinking is used only if the profile has no
		// separate `thinking` field). Skip if the user passed --model or
		// --provider explicitly.
		const { provider, modelId, thinkingHint } = parseModelRef(profile.provider, profile.model);
		const modelExplicit = cliFlagProvided("model") || cliFlagProvided("provider");
		if (modelExplicit) {
			// pi already applied the user's --model/--provider; leave it.
		} else if ((provider && !modelId) || (modelId && !provider)) {
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

		// Thinking level. A separate `thinking` field wins; otherwise use a
		// ":thinking" hint parsed from the model field. Skip if the user passed
		// --thinking explicitly.
		const thinking = profile.thinking ?? thinkingHint;
		if (thinking && !cliFlagProvided("thinking")) {
			try {
				this.pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			} catch (err) {
				console.warn("[pi-agent-profiles] Failed to set thinking level: " + err);
			}
		}

		// Tools. Filter to known tools, dedup, warn on unknown names. Skip if
		// the user passed --tools/-t explicitly. Empty/absent tools = all tools.
		const tools = profile.tools;
		if (tools && tools.length > 0 && !cliFlagProvided("tools", "t")) {
			try {
				const all = this.pi.getAllTools();
				const known = new Set(all.map((t) => t.name));
				const knownTools = tools.filter((t) => known.has(t));
				const unknown = tools.filter((t) => !known.has(t));
				if (unknown.length > 0) {
					console.warn(
						"[pi-agent-profiles] Unknown tool(s) in profile, ignored: " + unknown.join(", ")
					);
				}
				// A profile's `tools` list scopes BUILT-IN tools only. Preserve all
				// non-builtin tools (MCP servers, extensions, custom) so a profile's
				// built-in allowlist never filters out non-builtin capabilities (MCP, extensions, custom).
				const nonBuiltin = all
					.filter((t) => t.sourceInfo?.source !== "builtin")
					.map((t) => t.name);
				// Guard against disabling every tool: if the profile listed only
				// unknown tools, leave the active tool set unchanged.
				if (knownTools.length === 0) {
					console.warn("[pi-agent-profiles] No known tools in profile; tool set unchanged");
				} else {
					this.pi.setActiveTools([...new Set([...knownTools, ...nonBuiltin])]);
				}
			} catch (err) {
				console.warn("[pi-agent-profiles] Failed to set tools: " + err);
			}
		}
	}

	/** Apply the system prompt every turn. */
	async handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		_ctx: ExtensionContext
	): Promise<BeforeAgentStartEventResult | undefined> {
		const profileName = this.profileName();
		if (!profileName) return undefined;

		const dir = profilesDir();
		const result = readProfile(profileName);
		if (!result.ok) {
			// Already warned in session_start; stay quiet on later turns.
			return undefined;
		}
		const profile = result.profile;

		const systemPrompt = resolveSystemPrompt(profile.system_prompt, dir);
		if (!systemPrompt) return undefined;
		if (profile.replace_system_prompt) {
			return { systemPrompt };
		}
		return { systemPrompt: event.systemPrompt + "\n\n" + systemPrompt };
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
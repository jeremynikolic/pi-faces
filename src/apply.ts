import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expandTilde, realProfilesRoot } from "./paths.ts";
import { isValidProfileName, readProfile, resolvePromptValue, THINKING_LEVELS } from "./profile.ts";
import {
	cliAppendPromptConcern,
	cliModelConcern,
	cliSkillPaths,
	cliSystemPromptConcern,
	cliThinkingConcern,
	cliToolsConcern,
	splitTools,
} from "./cli.ts";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Applies the active profile.
 *
 * Session-level config (model, thinking, tools) is applied once in
 * `session_start` so the agent shows the profile's model/thinking at
 * startup (not pi's defaults). The system prompt is cached during
 * `session_start` and applied every turn in `before_agent_start`.
 *
 * Profile fields are defaults. Explicit CLI flags override the corresponding
 * profile concern, except that `--append-system-prompt` COMPOSES instead of
 * overriding: the profile's `append-system-prompt` always applies, stacked
 * before any CLI append layers (identity first, then CLI additions).
 * `--system-prompt` (replace) takes full prompt ownership and skips all
 * profile prompts; when only CLI appends are present, the profile's
 * `system-prompt` (replace) is skipped and the built-in base is kept.
 *
 * A profile that fails validation (unknown tools, unreadable prompt file,
 * etc.) is rejected entirely: `profileRejected` is set and no profile
 * policy (model, thinking, tools, prompt, skills) is applied.
 */
export class ProfileApplier {
	private profileIssueWarned = false;
	private profileRejected = false;
	private replacePrompt: string | undefined;
	private appendPrompt: string | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	private profileName(): string | undefined {
		const flag = this.pi.getFlag("profile");
		if (!flag) return undefined;
		const name = typeof flag === "string" ? flag : String(flag);
		if (!isValidProfileName(name)) {
			this.warnOnce("Invalid profile name: \"" + name + "\"");
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
		this.replacePrompt = undefined;
		this.appendPrompt = undefined;

		const profileName = this.profileName();
		if (!profileName) return;

		const result = readProfile(profileName);
		if (!result.ok) {
			this.warnOnce(result.error);
			this.profileRejected = true;
			return;
		}
		const profile = result.profile;

		const argv =
			typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv : [];

		const modelDropped = cliModelConcern(argv);
		const thinkingDropped = cliThinkingConcern(argv);
		const toolsDropped = cliToolsConcern(argv);
		// Prompt precedence: `--system-prompt` (replace) owns the prompt fully
		// and skips all profile prompts. CLI `--append-system-prompt` composes:
		// the profile append still applies (stacked first); the profile replace
		// is skipped so the built-in base survives for the appends to layer on.
		const promptAppendDropped = cliSystemPromptConcern(argv);
		const promptReplaceDropped = promptAppendDropped || cliAppendPromptConcern(argv);

		// Preflight: resolve active prompts + validate active tools BEFORE any
		// hostcall. Any active-concern failure rejects the whole profile with no
		// partial hostcalls/cached skills.
		if (!promptReplaceDropped) {
			const replaceValue = profile["system-prompt"];
			if (replaceValue !== undefined) {
				const r = resolvePromptValue(replaceValue, realProfilesRoot());
				if (!r.ok) {
					this.warnOnce("profile \"" + profileName + "\": " + r.error);
					this.profileRejected = true;
					return;
				}
				this.replacePrompt = r.content;
			}
		}
		if (!promptAppendDropped) {
			const appendValue = profile["append-system-prompt"];
			if (appendValue !== undefined) {
				const r = resolvePromptValue(appendValue, realProfilesRoot());
				if (!r.ok) {
					this.warnOnce("profile \"" + profileName + "\": " + r.error);
					this.profileRejected = true;
					return;
				}
				this.appendPrompt = r.content;
			}
		}

		let toolNames: string[] | undefined;
		if (!toolsDropped && profile.tools !== undefined) {
			toolNames = splitTools(profile.tools);
			const all = this.pi.getAllTools();
			const known = new Set(all.map((t) => t.name));
			const unknown = toolNames.filter((t) => !known.has(t));
			if (unknown.length > 0) {
				this.warnOnce(
					"profile \"" + profileName + "\": unknown tool(s) rejected profile: " + unknown.join(", ")
				);
				this.profileRejected = true;
				return;
			}
		}

		// Model + provider. Skip if the user passed --model or --provider.
		let thinkingHint: string | undefined;
		if (!modelDropped) {
			const parsed = parseModelRef(profile.provider, profile.model);
			thinkingHint = parsed.thinkingHint;
			if (parsed.provider && parsed.modelId && ctx.modelRegistry) {
				const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
				if (model) {
					try {
						const ok = await this.pi.setModel(model);
						if (!ok) {
							console.warn("[pi-faces] No API key for " + parsed.provider + "/" + parsed.modelId);
						}
					} catch (err) {
						console.warn("[pi-faces] Failed to set model: " + err);
					}
				} else {
					console.warn("[pi-faces] Model not found: " + parsed.provider + "/" + parsed.modelId);
				}
			}
		}

		// Thinking level. Skip if the user passed --thinking explicitly.
		if (!thinkingDropped) {
			const thinking = profile.thinking ?? thinkingHint;
			if (thinking) {
				try {
					this.pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				} catch (err) {
					console.warn("[pi-faces] Failed to set thinking level: " + err);
				}
			}
		}

		// Tools. Absent `tools` leaves pi's default untouched. Empty string means
		// zero active tools.
		if (!toolsDropped && toolNames !== undefined) {
			this.pi.setActiveTools(toolNames);
		}
	}

	/** Apply the cached system prompt every turn. */
	async handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		_ctx: ExtensionContext
	): Promise<BeforeAgentStartEventResult | undefined> {
		if (this.profileRejected) return undefined;

		const hasReplace = this.replacePrompt !== undefined;
		const hasAppend = this.appendPrompt !== undefined;
		if (!hasReplace && !hasAppend) return undefined;

		// CLI append layers, as composed by pi into the built prompt. When
		// present, the profile append is stacked BEFORE them (identity first,
		// CLI additions after) instead of at the prompt tail.
		const cliAppend = event.systemPromptOptions?.appendSystemPrompt;

		// Composition is exact and untrimmed.
		if (hasReplace && !hasAppend) {
			return { systemPrompt: cliAppend ? this.replacePrompt + "\n\n" + cliAppend : this.replacePrompt };
		}
		if (!hasReplace && hasAppend) {
			if (!cliAppend) {
				return { systemPrompt: event.systemPrompt + "\n\n" + this.appendPrompt };
			}
			const marker = "\n\n" + cliAppend;
			const idx = event.systemPrompt.indexOf(marker);
			if (idx === -1) {
				// Unrecognised composition: fall back to stacking after the CLI
				// layers rather than dropping the profile append.
				return { systemPrompt: event.systemPrompt + "\n\n" + this.appendPrompt };
			}
			return {
				systemPrompt: event.systemPrompt.slice(0, idx) + "\n\n" + this.appendPrompt + event.systemPrompt.slice(idx),
			};
		}
		return {
			systemPrompt: this.replacePrompt + "\n\n" + this.appendPrompt + (cliAppend ? "\n\n" + cliAppend : ""),
		};
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
			const entries = [
				...(result.profile.skill ?? []),
				...cliSkillPaths(
					typeof process !== "undefined" && Array.isArray(process.argv)
						? process.argv
						: []
				),
			];
			if (entries.length === 0) return undefined;
			const skillPaths: string[] = [];
			for (const entry of entries) {
				const p =
					entry.includes("/") || entry.startsWith("~")
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
 *
 * A trailing `:thinking` suffix is treated as a thinking hint only when the
 * suffix is a recognised thinking level; otherwise the colon is considered
 * part of the model id.
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
	if (typeof modelId === "string" && modelId.includes(":")) {
		const colon = modelId.lastIndexOf(":");
		const suffix = modelId.slice(colon + 1);
		if (THINKING_LEVELS.has(suffix)) {
			thinkingHint = suffix;
			modelId = modelId.slice(0, colon);
		}
	}
	return { provider, modelId, thinkingHint };
}

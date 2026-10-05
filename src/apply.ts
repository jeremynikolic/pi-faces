import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expandTilde, realProfilesRoot } from "./paths.ts";
import { isValidProfileName, readProfile, resolvePromptValue, THINKING_LEVELS } from "./profile.ts";
import type { ThinkingLevel } from "./types.ts";
import {
	cliAppendPromptConcern,
	cliModelConcern,
	cliSkillPaths,
	cliSystemPromptConcern,
	cliThinkingConcern,
	cliToolsConcern,
	splitTools,
} from "./cli.ts";
import { ActiveProfileResolver, type ResolvedActiveProfile } from "./active-profile.ts";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type WarningReporter = (message: string) => void;

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
 * Startup flag path retains the existing all-or-nothing validation semantics.
 * Mid-session /face swaps use best-effort application: each concern is
 * attempted independently, warnings are reported inline, and failures do not
 * block other concerns.
 */
export class ProfileApplier {
	private profileIssueWarned = false;
	private profileRejected = false;
	private replacePrompt: string | undefined;
	private appendPrompt: string | undefined;
	private pendingThinkingHint: ThinkingLevel | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly resolver: ActiveProfileResolver,
	) {}

	private warnOnce(message: string): void {
		if (!this.profileIssueWarned) {
			console.warn("[pi-faces] " + message);
			this.profileIssueWarned = true;
		}
	}

	/** Apply model/thinking/tools once at session start. */
	async handleSessionStart(event: unknown, ctx: ExtensionContext): Promise<void> {
		// Defense-in-depth reset: each session_start is a fresh validation
		// opportunity (pi re-fires this on /reload).
		this.profileRejected = false;
		this.replacePrompt = undefined;
		this.appendPrompt = undefined;

		const state = this.resolver.currentState();

		if (state.source === "flag") {
			const profileName = state.profileName;
			if (!profileName) return;
			await this.applyFlagProfile(profileName, event as { reason?: string }, ctx);
			return;
		}

		if (state.source === "override" && typeof state.profileName === "string") {
			await this.applyProfileBestEffort(state.profileName, ctx, (m) => console.warn("[pi-faces] " + m));
			return;
		}

		// Explicit off (or no profile): clear stale cached policy and restore
		// known default tools.
		if (state.source === "none" && state.profileName === null) {
			this.clearFaceProfile(ctx, (m) => console.warn("[pi-faces] " + m));
		}
	}

	/** Apply the cached system prompt every turn. */
	async handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		_ctx: ExtensionContext,
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
				// layers rather than drop the profile append.
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
		_ctx: ExtensionContext,
	): { skillPaths?: string[] } | undefined {
		if (this.profileRejected) return undefined;

		const state = this.resolver.currentState();
		if (state.profileName === undefined || state.profileName === null) return undefined;

		try {
			const result = readProfile(state.profileName);
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
			this.warnOnce("profile \"" + state.profileName + "\": failed to discover skills: " + err);
			return undefined;
		}
	}

	/**
	 * Best-effort application used by /face swaps. Each concern is independent;
	 * failures warn via the supplied reporter and do not block other concerns.
	 */
	async applyProfileBestEffort(
		profileName: string,
		ctx: ExtensionContext,
		warn: WarningReporter,
	): Promise<void> {
		this.profileRejected = false;
		this.replacePrompt = undefined;
		this.appendPrompt = undefined;

		const result = readProfile(profileName);
		if (!result.ok) {
			warn("profile \"" + profileName + "\": " + result.error);
			this.profileRejected = true;
			return;
		}
		const profile = result.profile;

		// Resolve prompts first so the cache is fresh before the next turn.
		this.cachePromptsBestEffort(profile, profileName, warn);

		await this.applyModelBestEffort(profile, ctx, warn);
		this.applyThinkingBestEffort(profile, warn);
		this.applyToolsBestEffort(profile, warn);
	}

	/** Clear face policy and restore known default tools. Used by /face off. */
	clearFaceProfile(ctx: ExtensionContext, warn: WarningReporter): void {
		this.profileRejected = false;
		this.replacePrompt = undefined;
		this.appendPrompt = undefined;

		const baseline = this.resolver.getDefaultTools();
		if (baseline === null) {
			warn("default tools unknown; keeping current tools");
			return;
		}
		try {
			this.pi.setActiveTools(baseline);
		} catch (err) {
			warn("failed to restore default tools: " + err);
		}
	}

	private cachePromptsBestEffort(profile: import("./types.ts").Profile, profileName: string, warn: WarningReporter): void {
		const replaceValue = profile["system-prompt"];
		if (replaceValue !== undefined) {
			const r = resolvePromptValue(replaceValue, realProfilesRoot());
			if (r.ok) {
				this.replacePrompt = r.content;
			} else {
				warn("profile \"" + profileName + "\": " + r.error);
			}
		}

		const appendValue = profile["append-system-prompt"];
		if (appendValue !== undefined) {
			const r = resolvePromptValue(appendValue, realProfilesRoot());
			if (r.ok) {
				this.appendPrompt = r.content;
			} else {
				warn("profile \"" + profileName + "\": " + r.error);
			}
		}
	}

	private async applyModelBestEffort(
		profile: import("./types.ts").Profile,
		ctx: ExtensionContext,
		warn: WarningReporter,
	): Promise<void> {
		const parsed = parseModelRef(profile.provider, profile.model);
		const thinkingHint = parsed.thinkingHint;
		if (parsed.provider && parsed.modelId && ctx.modelRegistry) {
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (model) {
				try {
					const ok = await this.pi.setModel(model);
					if (!ok) {
						warn("no API key for " + parsed.provider + "/" + parsed.modelId);
					}
				} catch (err) {
					warn("failed to set model: " + err);
				}
			} else {
				warn("model not found: " + parsed.provider + "/" + parsed.modelId);
			}
		}
		// Stash hint for applyThinking if the profile omits thinking.
		if (thinkingHint) {
			this.pendingThinkingHint = thinkingHint as ThinkingLevel;
		}
	}

	private applyThinkingBestEffort(profile: import("./types.ts").Profile, warn: WarningReporter): void {
		let thinking = profile.thinking;
		if (!thinking) {
			thinking = this.pendingThinkingHint;
			this.pendingThinkingHint = undefined;
		}
		if (!thinking) return;
		try {
			this.pi.setThinkingLevel(thinking);
		} catch (err) {
			warn("failed to set thinking level: " + err);
		}
	}

	private applyToolsBestEffort(profile: import("./types.ts").Profile, warn: WarningReporter): void {
		let toolNames: string[] | undefined;

		if (profile.tools !== undefined) {
			toolNames = splitTools(profile.tools);
			const all = this.pi.getAllTools();
			const known = new Set(all.map((t) => t.name));
			const unknown = toolNames.filter((t) => !known.has(t));
			if (unknown.length > 0) {
				warn("unknown tool(s): " + unknown.join(", "));
				toolNames = toolNames.filter((t) => known.has(t));
			}
		} else {
			// Omitted tools means restore the captured baseline default list.
			const baseline = this.resolver.getDefaultTools();
			if (baseline === null) {
				warn("default tools unknown; keeping current tools");
				return;
			}
			toolNames = baseline;
		}

		try {
			this.pi.setActiveTools(toolNames);
		} catch (err) {
			warn("failed to set tools: " + err);
		}
	}

	/** Startup flag path: CLI-gated, reject whole profile on any active-concern failure. */
	private async applyFlagProfile(
		profileName: string,
		_event: { reason?: string },
		ctx: ExtensionContext,
	): Promise<void> {
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

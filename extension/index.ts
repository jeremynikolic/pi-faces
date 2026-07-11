/**
 * pi-agent-profiles: Select a full agent profile via --profile <name>
 *
 * Registers a --profile CLI flag. When set, reads ~/.pi/agent-profiles/<name>.json
 * and applies: provider, model, thinking level, tools, and system prompt.
 *
 * Also registers a /profiles slash command for listing and managing profiles.
 *
 * The profile JSON supports all fields optionally. Omit a field and pi keeps
 * its default for that setting.
 *
 * Profile fields:
 *   - description:   short human/agent-readable purpose (shown by /profiles)
 *   - provider:      provider id (anthropic, openai, ...)
 *   - model:         model id (requires provider)
 *   - thinking:      off / minimal / low / medium / high / xhigh / max
 *   - tools:         tool allowlist as an array of strings
 *   - system_prompt: inline string OR a file path (relative to the profile
 *                    JSON's directory, or absolute / ~/). If the string is
 *                    not a readable file path it is treated as inline text.
 *
 * Install:
 *   pi install npm:pi-agent-profiles
 *
 * Usage:
 *   pi --profile planner -p "design the caching layer"
 *   /profiles list
 *   /profiles edit planner
 *
 * Profile files:
 *   ~/.pi/agent-profiles/planner.json
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	statSync,
	unlinkSync,
	renameSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PROFILES_DIR = "~/.pi/agent-profiles";

const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface Profile {
	description?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	system_prompt?: string;
}

export type ParseProfileResult =
	| { ok: true; profile: Profile }
	| { ok: false; error: string };

function expandTilde(p: string): string {
	if (p.startsWith("~/")) {
		return (typeof os !== "undefined" ? os.homedir() : "") + p.slice(1);
	}
	return p;
}

function profilesDir(): string {
	return expandTilde(
		(typeof process !== "undefined" && process.env && process.env.PI_PROFILES_DIR) ||
		DEFAULT_PROFILES_DIR
	);
}

function profilePath(name: string): string {
	return path.join(profilesDir(), name + ".json");
}

export function isValidProfileName(name: string | undefined): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		!name.includes("/") &&
		!name.includes("\\") &&
		name !== "." &&
		name !== ".."
	);
}

export function parseProfileFile(content: string, file: string): ParseProfileResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		return { ok: false, error: "Invalid JSON in " + file + ": " + err };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "Profile must be a JSON object in " + file };
	}

	const p = parsed as Record<string, unknown>;

	const stringField = (key: string): string | undefined => {
		if (key in p && p[key] !== undefined && typeof p[key] !== "string") {
			return key + " must be a string in " + file;
		}
		return undefined;
	};

	const descErr = stringField("description");
	if (descErr) return { ok: false, error: descErr };
	const provErr = stringField("provider");
	if (provErr) return { ok: false, error: provErr };
	const modelErr = stringField("model");
	if (modelErr) return { ok: false, error: modelErr };
	const spErr = stringField("system_prompt");
	if (spErr) return { ok: false, error: spErr };

	if ("thinking" in p && p.thinking !== undefined) {
		if (typeof p.thinking !== "string" || !THINKING_LEVELS.has(p.thinking)) {
			return {
				ok: false,
				error: "thinking must be one of " + [...THINKING_LEVELS].join(", ") + " in " + file,
			};
		}
	}

	if ("tools" in p && p.tools !== undefined) {
		if (!Array.isArray(p.tools) || p.tools.some((t) => typeof t !== "string")) {
			return { ok: false, error: "tools must be an array of strings in " + file };
		}
	}

	return { ok: true, profile: p as Profile };
}

function readProfile(name: string): Profile | undefined {
	const file = profilePath(name);

	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}

	const result = parseProfileFile(content, file);
	if (!result.ok) {
		console.warn("[pi-agent-profiles] " + result.error);
		return undefined;
	}
	return result.profile;
}

function readProfileRaw(name: string): { ok: true; content: string } | { ok: false; error: string } {
	const file = profilePath(name);
	try {
		return { ok: true, content: readFileSync(file, "utf-8") };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}

interface ProfileSummary {
	name: string;
	description: string | undefined;
}

function listProfiles(): ProfileSummary[] {
	const dir = profilesDir();
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const summaries: ProfileSummary[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const name = entry.slice(0, -".json".length);
		const profile = readProfile(name);
		summaries.push({ name, description: profile?.description });
	}
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}

export function resolveSystemPrompt(value: unknown, baseDir: string): string | undefined {
	if (typeof value !== "string" || !value) return undefined;

	// Try as a file path first. Relative paths resolve against the profile
	// JSON's directory (baseDir); absolute and ~/ paths resolve as-is.
	let resolved: string;
	if (value.startsWith("/") || value.startsWith("~")) {
		resolved = expandTilde(value);
	} else {
		resolved = baseDir + "/" + value;
	}
	try {
		return readFileSync(resolved, "utf-8").trim();
	} catch {
		// Not a file — treat as inline prompt text
		return value.trim();
	}
}

function defaultScaffold(description: string): string {
	return (
		JSON.stringify(
			{
				description: description || "TODO: describe this profile's purpose",
				provider: "anthropic",
				model: "claude-sonnet-4",
				thinking: "high",
				tools: ["read", "bash", "grep", "find", "ls"],
				system_prompt: "You are a...",
			},
			null,
			2
		) + "\n"
	);
}

function atomicWrite(file: string, content: string): void {
	const tmp = file + ".tmp-" + process.pid;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, file);
}

export default function (pi: ExtensionAPI) {
	// Register the --profile CLI flag
	pi.registerFlag("profile", {
		type: "string",
		description: "Agent profile name (loads ~/.pi/agent-profiles/<name>.json)",
	});

	// Apply the profile before the agent starts
	pi.on("before_agent_start", async (_event, ctx) => {
		const flag = pi.getFlag("profile");
		if (!flag) return;

		const profileName = typeof flag === "string" ? flag : String(flag);
		if (!isValidProfileName(profileName)) {
			console.warn(
				"[pi-agent-profiles] Invalid profile name: \"" + profileName + "\""
			);
			return;
		}

		const dir = profilesDir();
		const profile = readProfile(profileName);

		if (!profile) {
			console.warn(
				"[pi-agent-profiles] No profile found for \"" + profileName + "\" in " + dir
			);
			return;
		}

		// Apply model + provider. setModel takes a Model resolved from the
		// registry, not a provider/modelId pair.
		const provider = profile.provider;
		const modelId = profile.model;
		if (provider && modelId && ctx.modelRegistry) {
			const model = ctx.modelRegistry.find(provider, modelId);
			if (model) {
				try {
					const ok = await pi.setModel(model);
					if (!ok) {
						console.warn(
							"[pi-agent-profiles] No API key for " + provider + "/" + modelId
						);
					}
				} catch (err) {
					console.warn("[pi-agent-profiles] Failed to set model: " + err);
				}
			} else {
				console.warn(
					"[pi-agent-profiles] Model not found: " + provider + "/" + modelId
				);
			}
		}

		// Apply thinking level
		const thinking = profile.thinking;
		if (thinking) {
			try {
				pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			} catch (err) {
				console.warn("[pi-agent-profiles] Failed to set thinking level: " + err);
			}
		}

		// Apply tools. Warn about names not in the active tool set.
		const tools = profile.tools;
		if (tools) {
			try {
				const known = new Set(pi.getAllTools().map((t) => t.name));
				const unknown = tools.filter((t) => !known.has(t));
				if (unknown.length > 0) {
					console.warn(
						"[pi-agent-profiles] Unknown tool(s) in profile, they will be unavailable: " +
							unknown.join(", ")
					);
				}
				pi.setActiveTools(tools);
			} catch (err) {
				console.warn("[pi-agent-profiles] Failed to set tools: " + err);
			}
		}

		// Apply system prompt. Relative paths resolve against the profile
		// JSON's directory (dir), not a per-profile subdirectory.
		const systemPrompt = resolveSystemPrompt(profile.system_prompt, dir);

		if (systemPrompt) {
			return { systemPrompt };
		}
	});

	// Register the /profiles management command
	pi.registerCommand("profiles", {
		description:
			"Manage agent profiles: list, show, new, edit, delete, rename (usage: /profiles [list|show|new|edit|delete|rename] [name])",
		getArgumentCompletions(argPrefix) {
			const parts = argPrefix.split(/\s+/);
			if (parts.length < 2) return null;
			const sub = parts[0];

			// rename/mv: complete only the source (first name arg), never the
			// target — completing the target with existing names invites overwrite.
			if (sub === "rename" || sub === "mv") {
				if (parts.length !== 2) return null;
				const typed = parts[1];
				return listProfiles()
					.filter((p) => p.name.startsWith(typed))
					.map((p) => ({ value: p.name, label: p.name, description: p.description }));
			}

			const nameSubs = new Set(["show", "edit", "delete", "rm", "remove", "cat"]);
			if (!nameSubs.has(sub)) return null;
			if (parts.length !== 2) return null;
			const typed = parts[1];
			return listProfiles()
				.filter((p) => p.name.startsWith(typed))
				.map((p) => ({ value: p.name, label: p.name, description: p.description }));
		},
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] || "list";

			switch (sub) {
				case "list":
				case "ls": {
					return cmdList(ctx);
				}
				case "show":
				case "cat": {
					return cmdShow(parts[1], ctx);
				}
				case "new":
				case "create": {
					return cmdNew(parts[1], ctx);
				}
				case "edit": {
					return cmdEdit(parts[1], ctx);
				}
				case "delete":
				case "rm":
				case "remove": {
					return cmdDelete(parts[1], ctx);
				}
				case "rename":
				case "mv": {
					return cmdRename(parts[1], parts[2], ctx);
				}
				default: {
					ctx.ui.notify("[pi-agent-profiles] Unknown subcommand: " + sub, "warning");
					ctx.ui.notify(
						"Usage: /profiles [list|show <name>|new <name>|edit <name>|delete <name>|rename <old> <new>]",
						"info"
					);
				}
			}
		},
	});

	// --- command implementations ---

	async function cmdList(ctx: ExtensionCommandContext) {
		const dir = profilesDir();
		const profiles = listProfiles();
		if (profiles.length === 0) {
			pi.sendMessage({
				customType: "pi-agent-profiles",
				content: "No profiles found in " + dir,
				display: true,
			});
			return;
		}
		const lines = profiles.map((p) => {
			const desc = p.description ? p.description : "(no description)";
			return "• " + p.name + " — " + desc;
		});
		const body =
			"Profiles in " + dir + " (" + profiles.length + "):\n\n" + lines.join("\n");
		pi.sendMessage({
			customType: "pi-agent-profiles",
			content: body,
			display: true,
		});
	}

	async function cmdShow(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles show <name>", "warning");
			return;
		}
		const raw = readProfileRaw(name);
		if (!raw.ok) {
			ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
			return;
		}
		pi.sendMessage({
			customType: "pi-agent-profiles",
			content: "Profile " + name + ":\n\n```json\n" + raw.content.trim() + "\n```",
			display: true,
		});
	}

	async function cmdNew(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles new <name>", "warning");
			return;
		}
		const file = profilePath(name);
		if (existsSync(file)) {
			if (!ctx.hasUI) {
				ctx.ui.notify("[pi-agent-profiles] Profile already exists: " + name, "warning");
				return;
			}
			const overwrite = await ctx.ui.confirm(
				"Profile exists",
				name + ".json already exists. Overwrite?"
			);
			if (!overwrite) return;
		}

		let description = "";
		if (ctx.hasUI) {
			description = (await ctx.ui.input("Description (short purpose):", "")) || "";
		}

		try {
			mkdirSync(profilesDir(), { recursive: true });
			atomicWrite(file, defaultScaffold(description));
		} catch (err) {
			ctx.ui.notify("[pi-agent-profiles] Failed to create profile: " + err, "error");
			return;
		}
		ctx.ui.notify("[pi-agent-profiles] Created " + file, "info");

		if (ctx.hasUI) {
			const doEdit = await ctx.ui.confirm("Edit now?", "Open editor for " + name + "?");
			if (doEdit) await editInEditor(name, ctx);
		}
	}

	async function cmdEdit(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles edit <name>", "warning");
			return;
		}
		if (!existsSync(profilePath(name))) {
			ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
			return;
		}
		await editInEditor(name, ctx);
	}

	async function editInEditor(name: string, ctx: ExtensionCommandContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("[pi-agent-profiles] edit requires an interactive session", "warning");
			return;
		}
		const raw = readProfileRaw(name);
		if (!raw.ok) {
			ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
			return;
		}
		const edited = await ctx.ui.editor("Edit " + name, raw.content);
		if (edited === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		try {
			JSON.parse(edited);
		} catch (err) {
			const save = await ctx.ui.confirm(
				"Invalid JSON",
				"This is not valid JSON: " + err + "\n\nSave anyway?"
			);
			if (!save) return;
		}
		try {
			atomicWrite(profilePath(name), edited);
		} catch (err) {
			ctx.ui.notify("[pi-agent-profiles] Failed to save profile: " + err, "error");
			return;
		}
		ctx.ui.notify("[pi-agent-profiles] Saved " + name, "info");
	}

	async function cmdDelete(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles delete <name>", "warning");
			return;
		}
		const file = profilePath(name);
		if (!existsSync(file)) {
			ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"[pi-agent-profiles] delete requires confirmation; use an interactive session",
				"warning"
			);
			return;
		}
		const ok = await ctx.ui.confirm("Delete " + name + "?", "Removes " + file);
		if (!ok) return;
		try {
			unlinkSync(file);
		} catch (err) {
			ctx.ui.notify("[pi-agent-profiles] Failed to delete profile: " + err, "error");
			return;
		}

		const sib = path.join(profilesDir(), name);
		if (existsSync(sib) && statSync(sib).isDirectory()) {
			const removeDir = await ctx.ui.confirm(
				"Remove prompt directory?",
				"A directory named " + name + "/ exists (likely holds a system_prompt file). Remove it too?"
			);
			if (removeDir) {
				try {
					rmSync(sib, { recursive: true, force: true });
					ctx.ui.notify(
						"[pi-agent-profiles] Removed " + name + "/ and " + name + ".json",
						"info"
					);
					return;
				} catch (err) {
					ctx.ui.notify(
						"[pi-agent-profiles] Deleted " + name + ".json but failed to remove " + name + "/: " + err,
						"warning"
					);
					return;
				}
			}
		}
		ctx.ui.notify("[pi-agent-profiles] Deleted " + name, "info");
	}

	async function cmdRename(
		from: string | undefined,
		to: string | undefined,
		ctx: ExtensionCommandContext
	) {
		if (!isValidProfileName(from) || !isValidProfileName(to)) {
			ctx.ui.notify("Usage: /profiles rename <old> <new>", "warning");
			return;
		}
		const fromFile = profilePath(from);
		const toFile = profilePath(to);
		if (!existsSync(fromFile)) {
			ctx.ui.notify("[pi-agent-profiles] No profile: " + from, "warning");
			return;
		}
		const toExisted = existsSync(toFile);
		if (toExisted) {
			if (!ctx.hasUI) {
				ctx.ui.notify("[pi-agent-profiles] target exists: " + to, "warning");
				return;
			}
			const overwrite = await ctx.ui.confirm("Target exists", "Overwrite " + to + "?");
			if (!overwrite) return;
		}

		// Preflight the sibling prompt directory move so we can roll back the
		// profile rename if the directory move would fail.
		const fromDir = path.join(profilesDir(), from);
		const toDir = path.join(profilesDir(), to);
		const hasSib = existsSync(fromDir) && statSync(fromDir).isDirectory();
		const sibBlocked = hasSib && existsSync(toDir);

		if (sibBlocked && !toExisted) {
			ctx.ui.notify(
				"[pi-agent-profiles] target directory exists: " + to + "/ — rename aborted",
				"warning"
			);
			return;
		}

		try {
			renameSync(fromFile, toFile);
		} catch (err) {
			ctx.ui.notify("[pi-agent-profiles] Failed to rename profile: " + err, "error");
			return;
		}

		if (hasSib && !existsSync(toDir)) {
			try {
				renameSync(fromDir, toDir);
			} catch (err) {
				// Roll back the profile rename only if we did not just overwrite
				// an existing target (otherwise rollback would clobber the old file).
				if (!toExisted) {
					try {
						renameSync(toFile, fromFile);
					} catch {
						// best-effort rollback; report the split state below
					}
				}
				ctx.ui.notify(
					"[pi-agent-profiles] Renamed profile but could not move directory " +
						from +
						"/: " +
						err,
					"warning"
				);
				return;
			}
		}
		ctx.ui.notify("[pi-agent-profiles] Renamed " + from + " → " + to, "info");
	}
}
import {
	readdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import { expandTilde, profilePath, profilesDir } from "./paths.ts";
import type { ParseProfileResult, Profile, ReadProfileResult } from "./types.ts";

const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const KNOWN_FIELDS = new Set([
	"description",
	"provider",
	"model",
	"thinking",
	"tools",
	"skills",
	"system_prompt",
	"replace_system_prompt",
]);

/** True for a usable profile name: non-empty, no slashes/space, not `.`/`..`. */
export function isValidProfileName(name: string | undefined): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		!/[/\\\s]/.test(name) &&
		name !== "." &&
		name !== ".."
	);
}

/** Parse a profile JSON file. Pure — no filesystem access. Exported for testing. */
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
	const warnings: string[] = [];

	const stringField = (key: string): string | undefined => {
		if (key in p && p[key] !== undefined && p[key] !== null && typeof p[key] !== "string") {
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

	if ("replace_system_prompt" in p && p.replace_system_prompt !== undefined && p.replace_system_prompt !== null) {
		if (typeof p.replace_system_prompt !== "boolean") {
			return { ok: false, error: "replace_system_prompt must be a boolean in " + file };
		}
	}

	if ("thinking" in p && p.thinking !== undefined && p.thinking !== null) {
		if (typeof p.thinking !== "string" || !THINKING_LEVELS.has(p.thinking)) {
			return {
				ok: false,
				error: "thinking must be one of " + [...THINKING_LEVELS].join(", ") + " in " + file,
			};
		}
	}

	if ("tools" in p && p.tools !== undefined && p.tools !== null) {
		if (!Array.isArray(p.tools) || p.tools.some((t) => typeof t !== "string")) {
			return { ok: false, error: "tools must be an array of strings in " + file };
		}
	}

	for (const key of Object.keys(p)) {
		if (!KNOWN_FIELDS.has(key)) {
			warnings.push("unknown field \"" + key + "\" in " + file + " (ignored)");
		}
	}

	return { ok: true, profile: p as Profile, warnings };
}

/** Read and parse a profile by name. */
export function readProfile(name: string): ReadProfileResult {
	const file = profilePath(name);
	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return { ok: false, reason: "missing", error: "No profile found for \"" + name + "\" in " + profilesDir() };
	}
	const result = parseProfileFile(content, file);
	if (!result.ok) {
		return { ok: false, reason: "invalid", error: result.error };
	}
	return { ok: true, profile: result.profile, warnings: result.warnings };
}

/** Read raw profile JSON text. */
export function readProfileRaw(name: string): { ok: true; content: string } | { ok: false; error: string } {
	const file = profilePath(name);
	try {
		return { ok: true, content: readFileSync(file, "utf-8") };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}

export interface ProfileSummary {
	name: string;
	description: string | undefined;
}

/** List profiles (name + description) in the profiles directory, sorted by name. */
export function listProfiles(): ProfileSummary[] {
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
		// Read silently — list/autocomplete must not spam warnings on every
		// malformed file. Skip files that are missing or invalid.
		const result = readProfile(name);
		if (result.ok) {
			summaries.push({ name, description: result.profile.description });
		}
	}
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}

/**
 * Resolve a system_prompt value. If it is a readable file path (relative to
 * baseDir, or absolute / ~/), read and return its contents; otherwise treat it
 * as inline prompt text.
 */
export function resolveSystemPrompt(value: unknown, baseDir: string): string | undefined {
	if (typeof value !== "string" || !value) return undefined;

	// Try as a file path first. Relative paths resolve against the profile
	// JSON's directory (baseDir); absolute and ~/ paths resolve as-is.
	const resolved = value.startsWith("/") || value.startsWith("~")
		? expandTilde(value)
		: path.join(baseDir, value);
	try {
		return readFileSync(resolved, "utf-8").trim();
	} catch {
		// Not a file — treat as inline prompt text
		return value.trim();
	}
}

/** Default scaffold written by `/profiles new`. */
export function defaultScaffold(description: string): string {
	return (
		JSON.stringify(
			{
				description: description || "TODO: describe this profile's purpose",
				provider: "ollama-cloud",
				model: "glm-5.2",
				thinking: "high",
				tools: ["read", "bash", "grep", "find", "ls"],
				system_prompt: "You are a...",
			},
			null,
			2
		) + "\n"
	);
}

let atomicCounter = 0;

/** Write `content` to `file` via a temp file + rename for crash safety. */
export function atomicWrite(file: string, content: string): void {
	atomicCounter++;
	const tmp = file + ".tmp-" + process.pid + "-" + atomicCounter;
	try {
		writeFileSync(tmp, content, "utf-8");
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
}
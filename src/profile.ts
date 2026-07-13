import {
	chmodSync,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	constants,
} from "node:fs";
import path from "node:path";
import { expandTilde, profilePath, profilesDir, realProfilesRoot } from "./paths.ts";
import type { ParseProfileResult, Profile, ReadProfileResult } from "./types.ts";
import {
	MAX_CONFIG_BYTES,
	MAX_DESCRIPTION_LENGTH,
	MAX_FIELD_STRING_LENGTH,
	MAX_INLINE_PROMPT_LENGTH,
	MAX_PROFILE_JSON_BYTES,
	MAX_PROMPT_FILE_BYTES,
	MAX_PROMPT_FILE_PATH_LENGTH,
	MAX_SKILL_ENTRY_LENGTH,
	MAX_SKILLS_ENTRIES,
	MAX_TOOL_NAME_LENGTH,
	MAX_TOOLS_ENTRIES,
} from "./limits.ts";

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;

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
	"system_prompt_file",
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

	const validateString = (
		key: string,
		max: number,
		allowEmpty: boolean
	): string | undefined => {
		if (key in p && p[key] !== undefined && p[key] !== null) {
			const v = p[key];
			if (typeof v !== "string") {
				return key + " must be a string in " + file;
			}
			if (!allowEmpty && v.length === 0) {
				return key + " must not be empty in " + file;
			}
			if (v.length > max) {
				return key + " exceeds maximum length (" + max + ") in " + file;
			}
		}
		return undefined;
	};

	// Mutual exclusivity: evaluated before other field validation.
	const hasInline =
		"system_prompt" in p && p.system_prompt !== undefined && p.system_prompt !== null;
	const hasFile =
		"system_prompt_file" in p &&
		p.system_prompt_file !== undefined &&
		p.system_prompt_file !== null;
	if (hasInline && hasFile) {
		return {
			ok: false,
			error:
				"Only one of system_prompt or system_prompt_file may be set in " + file,
		};
	}

	const descErr = validateString("description", MAX_DESCRIPTION_LENGTH, true);
	if (descErr) return { ok: false, error: descErr };
	const provErr = validateString("provider", MAX_FIELD_STRING_LENGTH, true);
	if (provErr) return { ok: false, error: provErr };
	const modelErr = validateString("model", MAX_FIELD_STRING_LENGTH, true);
	if (modelErr) return { ok: false, error: modelErr };
	const spErr = validateString("system_prompt", MAX_INLINE_PROMPT_LENGTH, true);
	if (spErr) return { ok: false, error: spErr };
	const spFileErr = validateString(
		"system_prompt_file",
		MAX_PROMPT_FILE_PATH_LENGTH,
		false
	);
	if (spFileErr) return { ok: false, error: spFileErr };

	if (
		"replace_system_prompt" in p &&
		p.replace_system_prompt !== undefined &&
		p.replace_system_prompt !== null
	) {
		if (typeof p.replace_system_prompt !== "boolean") {
			return {
				ok: false,
				error: "replace_system_prompt must be a boolean in " + file,
			};
		}
	}

	if ("thinking" in p && p.thinking !== undefined && p.thinking !== null) {
		if (typeof p.thinking !== "string" || !THINKING_LEVELS.has(p.thinking)) {
			return {
				ok: false,
				error:
					"thinking must be one of " +
					Array.from(THINKING_LEVELS).join(", ") +
					" in " +
					file,
			};
		}
	}

	if ("tools" in p && p.tools !== undefined && p.tools !== null) {
		if (!Array.isArray(p.tools)) {
			return { ok: false, error: "tools must be an array of strings in " + file };
		}
		if (p.tools.length > MAX_TOOLS_ENTRIES) {
			return {
				ok: false,
				error:
					"tools exceeds maximum entries (" +
					MAX_TOOLS_ENTRIES +
					") in " +
					file,
			};
		}
		if (
			p.tools.some(
				(t) => typeof t !== "string" || t.length === 0 || t.length > MAX_TOOL_NAME_LENGTH
			)
		) {
			return {
				ok: false,
				error:
					"tools must be non-empty strings with length <= " +
					MAX_TOOL_NAME_LENGTH +
					" in " +
					file,
			};
		}
	}

	if ("skills" in p && p.skills !== undefined && p.skills !== null) {
		if (!Array.isArray(p.skills)) {
			return { ok: false, error: "skills must be an array of strings in " + file };
		}
		if (p.skills.length > MAX_SKILLS_ENTRIES) {
			return {
				ok: false,
				error:
					"skills exceeds maximum entries (" +
					MAX_SKILLS_ENTRIES +
					") in " +
					file,
			};
		}
		if (
			p.skills.some(
				(s) => typeof s !== "string" || s.length === 0 || s.length > MAX_SKILL_ENTRY_LENGTH
			)
		) {
			return {
				ok: false,
				error:
					"skills must be non-empty strings with length <= " +
					MAX_SKILL_ENTRY_LENGTH +
					" in " +
					file,
			};
		}
		p.skills = Array.from(new Set(p.skills));
	}

	for (const key of Object.keys(p)) {
		if (!KNOWN_FIELDS.has(key)) {
			warnings.push('unknown field "' + key + '" in ' + file + " (ignored)");
		}
	}

	return { ok: true, profile: p as Profile, warnings };
}

/** Read a regular file with a byte ceiling. Used for profile/config JSON. */
export function readBoundedFile(
	file: string,
	maxBytes: number,
	label: string
):
	| { ok: true; content: string }
	| { ok: false; error: string; code?: string } {
	let stats;
	try {
		stats = lstatSync(file);
	} catch (err) {
		const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
		return {
			ok: false,
			error: `Failed to read ${label} file ${file}${code ? " (" + code + ")" : ""}`,
			code,
		};
	}
	if (!stats.isFile()) {
		return {
			ok: false,
			error: `${label} file is not a regular file: ${file}`,
		};
	}
	if (stats.size > maxBytes) {
		return {
			ok: false,
			error: `${label} file too large (${stats.size} > ${maxBytes} bytes): ${file}`,
		};
	}
	try {
		return { ok: true, content: readFileSync(file, "utf-8") };
	} catch (err) {
		const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
		return {
			ok: false,
			error: `Failed to read ${label} file ${file}${code ? " (" + code + ")" : ""}`,
			code,
		};
	}
}

/** Read and parse a profile by name. */
export function readProfile(name: string): ReadProfileResult {
	const file = profilePath(name);
	const bounded = readBoundedFile(file, MAX_PROFILE_JSON_BYTES, "profile");
	if (bounded.ok === false) {
		const reason = bounded.code === "ENOENT" ? "missing" : "invalid";
		return { ok: false, reason, error: bounded.error };
	}
	const result = parseProfileFile(bounded.content, file);
	if (result.ok === false) {
		return { ok: false, reason: "invalid", error: result.error };
	}
	return { ok: true, profile: result.profile, warnings: result.warnings };
}

/** Read raw profile JSON text. */
export function readProfileRaw(
	name: string
): { ok: true; content: string } | { ok: false; error: string } {
	const file = profilePath(name);
	const bounded = readBoundedFile(file, MAX_PROFILE_JSON_BYTES, "profile");
	if (bounded.ok === false) {
		return { ok: false, error: bounded.error };
	}
	return { ok: true, content: bounded.content };
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
 * Read a prompt file confined to the profile root, with TOCTOU-hardened fd
 * open + fstat + read-from-fd. Returns the trimmed content, or an error naming
 * the rejected path (content is never echoed).
 */
export function readSystemPromptFile(
	value: unknown,
	baseRoot: string
): { ok: true; content: string } | { ok: false; error: string } {
	if (typeof value !== "string" || value.length === 0) {
		return { ok: false, error: "system_prompt_file must be a non-empty string" };
	}

	// Syntactic escapes: absolute, tilde, and parent-directory segments.
	if (value.startsWith("/") || value.startsWith("~")) {
		return { ok: false, error: "system_prompt_file path must be relative: " + value };
	}
	const normalized = path.normalize(value);
	if (normalized.split(path.sep).includes("..")) {
		return { ok: false, error: "system_prompt_file path must not contain .. segments: " + value };
	}

	const root = realProfilesRoot();
	let real: string;
	try {
		real = realpathSync(path.resolve(baseRoot, value));
	} catch (err) {
		return {
			ok: false,
			error: `system_prompt_file not found: ${value}${err ? " (" + err + ")" : ""}`,
		};
	}

	if (real !== root && !real.startsWith(root + path.sep)) {
		return {
			ok: false,
			error: `system_prompt_file escapes profile root: ${value} -> ${real}`,
		};
	}

	const openFlags =
		O_RDONLY |
		O_NONBLOCK |
		(typeof O_NOFOLLOW === "number" ? O_NOFOLLOW : 0);

	let fd: number;
	try {
		fd = openSync(real, openFlags);
	} catch (err) {
		return {
			ok: false,
			error: `Failed to open system_prompt_file ${value}${err ? " (" + err + ")" : ""}`,
		};
	}

	let stat;
	try {
		stat = fstatSync(fd);
	} catch (err) {
		closeSync(fd);
		return {
			ok: false,
			error: `Failed to stat system_prompt_file ${value}${err ? " (" + err + ")" : ""}`,
		};
	}

	if (!stat.isFile()) {
		closeSync(fd);
		return { ok: false, error: "system_prompt_file is not a regular file: " + value };
	}
	if (stat.size > MAX_PROMPT_FILE_BYTES) {
		closeSync(fd);
		return {
			ok: false,
			error: `system_prompt_file too large (${stat.size} > ${MAX_PROMPT_FILE_BYTES} bytes): ${value}`,
		};
	}

	let content: string;
	try {
		content = readFileSync(fd, "utf-8");
	} catch (err) {
		return {
			ok: false,
			error: `Failed to read system_prompt_file ${value}${err ? " (" + err + ")" : ""}`,
		};
	} finally {
		closeSync(fd);
	}

	return { ok: true, content: content.trim() };
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
		writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, file);
		chmodSync(file, 0o600);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
}

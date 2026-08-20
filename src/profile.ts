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
	MAX_SKILL_ENTRIES,
	MAX_SKILL_ENTRY_LENGTH,
	MAX_TOOLS_STRING_LENGTH,
} from "./limits.ts";

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;

export const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export const SUPPORTED_PROFILE_KEYS = new Set([
	"description",
	"model",
	"provider",
	"thinking",
	"tools",
	"skill",
	"system-prompt",
	"append-system-prompt",
]);

function supportedSetText(): string {
	return Array.from(SUPPORTED_PROFILE_KEYS).join(", ");
}

/** True for a usable profile name: non-empty, no slashes/space, not `.`/`..`. */
export function isValidProfileName(name: string | undefined): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		!/[\/\\\s]/.test(name) &&
		name !== "." &&
		name !== ".."
	);
}

function isValidThinkingLevel(v: string): v is import("./types.ts").ThinkingLevel {
	return THINKING_LEVELS.has(v);
}

function validateString(
	p: Record<string, unknown>,
	key: string,
	file: string,
	max: number,
	allowEmpty: boolean
): string | undefined {
	if (!(key in p)) return undefined;
	const v = p[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		return `${key} must be a string in ${file}`;
	}
	if (!allowEmpty && v.length === 0) {
		return `${key} must not be empty in ${file}`;
	}
	if (v.length > max) {
		return `${key} exceeds maximum length (${max}) in ${file}`;
	}
	return undefined;
}

function hasValue(p: Record<string, unknown>, key: string): boolean {
	return key in p && p[key] !== undefined && p[key] !== null;
}

function validateModelProviderCrossField(
	p: Record<string, unknown>,
	file: string
): string | undefined {
	const hasModel = hasValue(p, "model");
	const hasProvider = hasValue(p, "provider");
	if (!hasModel && !hasProvider) return undefined;

	if (hasProvider && !hasModel) {
		return `provider requires a model in ${file}`;
	}
	if (hasModel && !hasProvider) {
		const model = p.model as string;
		if (!model.includes("/")) {
			return `model without provider must use packed provider/id form in ${file}`;
		}
	}
	if (hasModel) {
		const model = p.model as string;
		const slash = model.indexOf("/");
		if (slash !== -1) {
			const packedProvider = model.slice(0, slash);
			const afterSlash = model.slice(slash + 1);
			if (packedProvider.length === 0 || afterSlash.length === 0) {
				return `packed model must have non-empty provider and id in ${file}`;
			}
		}
	}
	return undefined;
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

	for (const key of Object.keys(p)) {
		if (!SUPPORTED_PROFILE_KEYS.has(key)) {
			return {
				ok: false,
				error: `unsupported field "${key}" in ${file}; supported: ${supportedSetText()}`,
			};
		}
		// null values are not accepted as "absent" in the strict schema.
		if (p[key] === null) {
			return { ok: false, error: `${key} must not be null in ${file}` };
		}
	}

	const crossErr = validateModelProviderCrossField(p, file);
	if (crossErr) return { ok: false, error: crossErr };

	const descErr = validateString(p, "description", file, MAX_DESCRIPTION_LENGTH, true);
	if (descErr) return { ok: false, error: descErr };
	const provErr = validateString(p, "provider", file, MAX_FIELD_STRING_LENGTH, true);
	if (provErr) return { ok: false, error: provErr };
	const modelErr = validateString(p, "model", file, MAX_FIELD_STRING_LENGTH, true);
	if (modelErr) return { ok: false, error: modelErr };
	const spErr = validateString(p, "system-prompt", file, MAX_INLINE_PROMPT_LENGTH, true);
	if (spErr) return { ok: false, error: spErr };
	const apErr = validateString(
		p,
		"append-system-prompt",
		file,
		MAX_INLINE_PROMPT_LENGTH,
		true
	);
	if (apErr) return { ok: false, error: apErr };

	if (hasValue(p, "thinking")) {
		const v = p.thinking;
		if (typeof v !== "string" || !isValidThinkingLevel(v)) {
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

	if (hasValue(p, "tools")) {
		const v = p.tools;
		if (typeof v !== "string") {
			return { ok: false, error: "tools must be a comma-separated string in " + file };
		}
		if (v.length > MAX_TOOLS_STRING_LENGTH) {
			return {
				ok: false,
				error: "tools exceeds maximum length (" + MAX_TOOLS_STRING_LENGTH + ") in " + file,
			};
		}
	}

	if (hasValue(p, "skill")) {
		const v = p.skill;
		if (!Array.isArray(v)) {
			return { ok: false, error: "skill must be an array of strings in " + file };
		}
		if (v.length > MAX_SKILL_ENTRIES) {
			return {
				ok: false,
				error: "skill exceeds maximum entries (" + MAX_SKILL_ENTRIES + ") in " + file,
			};
		}
		if (
			v.some(
				(s) => typeof s !== "string" || s.length === 0 || s.length > MAX_SKILL_ENTRY_LENGTH
			)
		) {
			return {
				ok: false,
				error:
					"skill must be non-empty strings with length <= " +
					MAX_SKILL_ENTRY_LENGTH +
					" in " +
					file,
			};
		}
		p.skill = Array.from(new Set(v));
	}

	return { ok: true, profile: p as Profile, warnings: [] };
}

/** Read a regular file with a byte ceiling.
 *
 * Centralizes lstat regular-file/symlink rejection, fd open/fstat/ceiling/read
 * for profile, config, and prompt targets. Preserves error redaction.
 */
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
		const code =
			err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
		return {
			ok: false,
			error: `Failed to read ${label} file ${file}${code ? " (" + code + ")" : ""}`,
			code,
		};
	}
	if (stats.isSymbolicLink()) {
		return {
			ok: false,
			error: `${label} file is a symlink: ${file}`,
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

	const openFlags =
		O_RDONLY | O_NONBLOCK | (typeof O_NOFOLLOW === "number" ? O_NOFOLLOW : 0);

	let fd: number;
	try {
		fd = openSync(file, openFlags);
	} catch (err) {
		const code =
			err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
		return {
			ok: false,
			error: `Failed to open ${label} file ${file}${code ? " (" + code + ")" : ""}`,
			code,
		};
	}

	let stat;
	try {
		stat = fstatSync(fd);
	} catch (err) {
		closeSync(fd);
		const code =
			err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
		return {
			ok: false,
			error: `Failed to stat ${label} file ${file}${code ? " (" + code + ")" : ""}`,
			code,
		};
	}
	if (!stat.isFile()) {
		closeSync(fd);
		return { ok: false, error: `${label} file is not a regular file: ${file}` };
	}
	if (stat.size > maxBytes) {
		closeSync(fd);
		return {
			ok: false,
			error: `${label} file too large (${stat.size} > ${maxBytes} bytes): ${file}`,
		};
	}

	let content: string;
	try {
		content = readFileSync(fd, "utf-8");
	} catch (err) {
		closeSync(fd);
		const code =
			err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
		return {
			ok: false,
			error: `Failed to read ${label} file ${file}${code ? " (" + code + ")" : ""}`,
			code,
		};
	} finally {
		closeSync(fd);
	}

	return { ok: true, content };
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
		const result = readProfile(name);
		if (result.ok) {
			summaries.push({ name, description: result.profile.description });
		}
	}
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}

/**
 * Resolve a prompt value.
 *
 * Only `@./…` is accepted as a file reference (loaded from the profile root).
 * `@~/…` and `@/…` are classified as file forms and rejected.
 * Every other string (including `@foo`, `@`, and literal whitespace) is returned
 * verbatim with no filesystem access.
 */
export function resolvePromptValue(
	value: unknown,
	baseRoot: string
): { ok: true; content: string } | { ok: false; error: string } {
	if (typeof value !== "string") {
		return { ok: false, error: "prompt value must be a string" };
	}

	if (value.startsWith("@~/") || value.startsWith("@/")) {
		return { ok: false, error: "prompt file path must be relative: " + value };
	}
	if (!value.startsWith("@./")) {
		return { ok: true, content: value };
	}

	const rawPath = value.slice(1); // strip leading '@'
	const normalized = path.normalize(rawPath);
	const segments = normalized.split(path.sep).filter(Boolean);
	if (segments.includes("..")) {
		return { ok: false, error: "prompt file path must not contain .. segments: " + value };
	}

	const root = realProfilesRoot();
	const baseReal = realpathSync(baseRoot);
	const resolved = path.resolve(baseReal, rawPath);
	if (!resolved.startsWith(root + path.sep) && resolved !== root) {
		return { ok: false, error: "prompt file escapes profile root: " + value };
	}

	if (rawPath.length > MAX_PROMPT_FILE_PATH_LENGTH) {
		return {
			ok: false,
			error: "prompt file path exceeds maximum length (" + MAX_PROMPT_FILE_PATH_LENGTH + "): " + value,
		};
	}

	const bounded = readBoundedFile(resolved, MAX_PROMPT_FILE_BYTES, "prompt");
	if (!bounded.ok) {
		return { ok: false, error: bounded.error };
	}
	return { ok: true, content: bounded.content };
}

/** Default scaffold written by `/profiles new`. */
export function defaultScaffold(description: string): string {
	return (
		JSON.stringify(
			{
				description: description || "TODO: describe this profile's purpose",
				model: "ollama-cloud/glm-5.2:high",
				tools: "read, bash, grep, find, ls",
				skill: [],
				"append-system-prompt": "You are a...",
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

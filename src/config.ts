import { readBoundedFile } from "./profile.ts";
import { configPath } from "./paths.ts";
import type { PackageConfig, ParseConfigResult, ReadConfigResult } from "./types.ts";
import { MAX_CONFIG_BYTES } from "./limits.ts";

// Session-name prefix feature config.
//
// Controlled by a JSON config file at <profiles-dir>/config/config.json
// (override the path with PI_PROFILES_CONFIG). The file is optional; when
// missing, defaults apply (prefix on). Set { "prefix_session_name": false }
// to disable.
const KNOWN_CONFIG_FIELDS = new Set(["prefix_session_name"]);

/** Parse the package config JSON. Pure — no filesystem access. Exported for testing. */
export function parseConfigFile(content: string, file: string): ParseConfigResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		return { ok: false, error: "Invalid JSON in " + file + ": " + err };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "Config must be a JSON object in " + file };
	}

	const c = parsed as Record<string, unknown>;
	const warnings: string[] = [];
	const config: PackageConfig = {};

	if (
		"prefix_session_name" in c &&
		c.prefix_session_name !== undefined &&
		c.prefix_session_name !== null
	) {
		if (typeof c.prefix_session_name !== "boolean") {
			return { ok: false, error: "prefix_session_name must be a boolean in " + file };
		}
		config.prefix_session_name = c.prefix_session_name;
	}

	for (const key of Object.keys(c)) {
		if (!KNOWN_CONFIG_FIELDS.has(key)) {
			warnings.push('unknown field "' + key + '" in ' + file + " (ignored)");
		}
	}

	return { ok: true, config, warnings };
}

/** Read and parse the package config file. Missing file → defaults (no error). */
export function readConfigFile(): ReadConfigResult {
	const file = configPath();
	const bounded = readBoundedFile(file, MAX_CONFIG_BYTES, "config");
	if (!bounded.ok) {
		return { ok: false, error: bounded.error };
	}
	return parseConfigFile(bounded.content, file);
}
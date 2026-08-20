// Shared types for pi-faces.

/** Allowed thinking levels. */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/** A profile JSON file. All fields optional — omit a field and pi keeps its default. */
export interface Profile {
	description?: string;
	model?: string;
	provider?: string;
	thinking?: ThinkingLevel;
	/** Comma-separated tool names. */
	tools?: string;
	/** Repeatable skill paths/names. */
	skill?: string[];
	/** Replace the built-in system prompt with this value. */
	"system-prompt"?: string;
	/** Append this value to the built-in system prompt. */
	"append-system-prompt"?: string;
}

export type ParseProfileResult =
	| { ok: true; profile: Profile; warnings: string[] }
	| { ok: false; error: string };

export interface PackageConfig {
	/** Prefix the session display name with "[profile]" while a profile is active. Default: true. */
	prefix_session_name?: boolean;
}

export type ParseConfigResult =
	| { ok: true; config: PackageConfig; warnings: string[] }
	| { ok: false; error: string };

export type ReadConfigResult =
	| { ok: true; config: PackageConfig; warnings: string[] }
	| { ok: false; error: string; code?: string };

export type ReadProfileResult =
	| { ok: true; profile: Profile; warnings: string[] }
	| { ok: false; reason: "missing" | "invalid"; error: string };

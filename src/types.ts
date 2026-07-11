// Shared types for pi-agent-profiles.

/** A profile JSON file. All fields optional — omit a field and pi keeps its default. */
export interface Profile {
	description?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	system_prompt?: string;
	replace_system_prompt?: boolean;
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
	| { ok: false; error: string };

export type ReadProfileResult =
	| { ok: true; profile: Profile; warnings: string[] }
	| { ok: false; reason: "missing" | "invalid"; error: string };
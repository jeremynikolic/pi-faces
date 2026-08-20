/**
 * Parser-faithful CLI inspection.
 *
 * pi's extension API only exposes flag values for flags an extension
 * registers (pi.getFlag). Built-in flags like --model, --provider,
 * --thinking, --tools, --system-prompt, --append-system-prompt, --skill,
 * and --no-skills are not visible there, so we inspect process.argv.
 *
 * We mirror pi 0.80.6's tokenisation: built-in flags are recognised ONLY as
 * separate flag/value tokens. `--flag=value` does NOT count, and a value flag
 * without a following non-flag value is dangling and does not override.
 */

function getArgv(): string[] {
	return typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv : [];
}

function isFlagToken(token: string): boolean {
	return token.startsWith("-") && token.length > 1;
}

/**
 * Return the value for a standalone `--<long> <value>` or `-<short> <value>`
 * token. Returns undefined if the flag is absent, dangling, or uses
 * `--flag=value` / `-f=value` spelling.
 */
export function cliFlagValue(argv: string[], long: string, short?: string): string | undefined {
	const longToken = "--" + long;
	const shortToken = short ? "-" + short : undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === longToken || (shortToken && a === shortToken)) {
			const next = argv[i + 1];
			if (next !== undefined && !isFlagToken(next)) return next;
			return undefined;
		}
	}
	return undefined;
}

/**
 * Return true if the exact standalone flag token is present.
 * `--flag=value` and `-f=value` are ignored.
 */
export function cliFlagBoolean(argv: string[], long: string, short?: string): boolean {
	const longToken = "--" + long;
	const shortToken = short ? "-" + short : undefined;
	for (const a of argv) {
		if (a === longToken) return true;
		if (shortToken && a === shortToken) return true;
	}
	return false;
}

/** True when an explicit --model or --provider value token is present. */
export function cliModelConcern(argv: string[] = getArgv()): boolean {
	return cliFlagValue(argv, "model") !== undefined || cliFlagValue(argv, "provider") !== undefined;
}

/** Raw CLI model/provider values, when present. */
export function getCliModel(
	argv: string[] = getArgv()
): { model: string | undefined; provider: string | undefined } {
	return {
		model: cliFlagValue(argv, "model"),
		provider: cliFlagValue(argv, "provider"),
	};
}

/** True when an explicit --thinking value token is present. */
export function cliThinkingConcern(argv: string[] = getArgv()): boolean {
	return cliFlagValue(argv, "thinking") !== undefined;
}

export function getCliThinking(argv: string[] = getArgv()): string | undefined {
	return cliFlagValue(argv, "thinking");
}

/** True when any tools flag is explicitly present. */
export function cliToolsConcern(argv: string[] = getArgv()): boolean {
	return (
		cliFlagValue(argv, "tools", "t") !== undefined ||
		cliFlagValue(argv, "exclude-tools", "xt") !== undefined ||
		cliFlagBoolean(argv, "no-tools", "nt")
	);
}

/**
 * Parse the effective tools from CLI tokens.
 *
 * - `--tools <v>` / `-t <v>` → split commas, trim, drop empty, dedup.
 * - `--no-tools` / `-nt` → [].
 * - `--exclude-tools <v>` → subtract <v> from all known tools? Not needed by
 *   the profile applier; this function just returns the literal exclusion list.
 */
export function getCliTools(argv: string[] = getArgv()): {
	include: string[] | undefined;
	exclude: string[] | undefined;
	noTools: boolean;
} {
	const includeValue = cliFlagValue(argv, "tools", "t");
	const excludeValue = cliFlagValue(argv, "exclude-tools", "xt");
	const noTools = cliFlagBoolean(argv, "no-tools", "nt");
	return {
		include: includeValue === undefined ? undefined : splitTools(includeValue),
		exclude: excludeValue === undefined ? undefined : splitTools(excludeValue),
		noTools,
	};
}

export function splitTools(value: string): string[] {
	return Array.from(
		new Set(
			value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
		)
	);
}

/** True when an explicit --system-prompt or --append-system-prompt value token is present. */
export function cliPromptConcern(argv: string[] = getArgv()): boolean {
	return (
		cliFlagValue(argv, "system-prompt") !== undefined ||
		cliFlagValue(argv, "append-system-prompt") !== undefined
	);
}

export function getCliPrompt(
	key: "system-prompt" | "append-system-prompt",
	argv: string[] = getArgv()
): string | undefined {
	return cliFlagValue(argv, key);
}

/** Paths passed via standalone `--skill <path>` tokens, in order. */
export function cliSkillPaths(argv: string[] = getArgv()): string[] {
	const paths: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--skill") {
			const next = argv[i + 1];
			if (next !== undefined && !isFlagToken(next)) paths.push(next);
		}
	}
	return paths;
}

export function cliNoSkills(argv: string[] = getArgv()): boolean {
	return cliFlagBoolean(argv, "no-skills");
}

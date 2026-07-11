/**
 * Detect whether a CLI flag was explicitly passed on the command line.
 *
 * pi's extension API only exposes flag values for flags an extension
 * registers (pi.getFlag). Built-in flags like --model, --provider,
 * --thinking, and --tools are not visible there, and ctx.model cannot
 * distinguish "explicitly set" from "default". Inspecting process.argv is
 * the reliable way to tell whether the user passed one of these flags, so
 * a profile can act as a default that explicit CLI options override.
 */

/**
 * Returns true if the given flag appears on the CLI as a standalone token
 * (`--name [value]`) or in `--name=value` form. An optional short alias
 * (e.g. "t" for --tools) is checked as `-t` / `-t=value`.
 */
export function cliFlagProvided(name: string, short?: string): boolean {
	const argv = typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv : [];
	const longToken = "--" + name;
	const longEq = "--" + name + "=";
	for (const a of argv) {
		if (a === longToken || a.startsWith(longEq)) return true;
	}
	if (short) {
		const shortToken = "-" + short;
		const shortEq = "-" + short + "=";
		for (const a of argv) {
			if (a === shortToken || a.startsWith(shortEq)) return true;
		}
	}
	return false;
}
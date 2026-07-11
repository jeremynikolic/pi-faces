/** True if `name` already starts with the `[profileName]` prefix tag. */
export function hasProfilePrefix(name: string, profileName: string): boolean {
	const tag = "[" + profileName + "]";
	return name === tag || name.startsWith(tag + " ");
}

/**
 * Prefix `name` with `[profileName] `. Returns undefined when there is nothing
 * to do: no name, or the name already carries the prefix (avoids re-entrant
 * double-prefixing when our own setSessionName re-fires session_info_changed).
 */
export function withProfilePrefix(
	name: string | undefined,
	profileName: string
): string | undefined {
	if (!name) return undefined;
	if (hasProfilePrefix(name, profileName)) return undefined;
	return "[" + profileName + "] " + name;
}
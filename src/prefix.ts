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

/**
 * Replace or remove an exact existing `[oldProfileName]` tag. If the name does
 * not carry the old tag and a new profile is given, fall back to ordinary
 * prefixing. Returns undefined when there is no change to make.
 */
export function replaceProfilePrefix(
	name: string,
	oldProfileName: string | undefined,
	newProfileName: string | undefined
): string | undefined {
	if (!name) return undefined;
	const oldTag = oldProfileName ? "[" + oldProfileName + "]" : undefined;
	const newTag = newProfileName ? "[" + newProfileName + "]" : undefined;

	if (oldTag) {
		if (name === oldTag) {
			return newTag;
		}
		if (name.startsWith(oldTag + " ")) {
			const rest = name.slice(oldTag.length + 1);
			if (newTag) {
				return newTag + " " + rest;
			}
			return rest || undefined;
		}
	}

	if (newProfileName) {
		return withProfilePrefix(name, newProfileName);
	}

	return undefined;
}

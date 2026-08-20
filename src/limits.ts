// Byte and count limits for profile/config/prompt files.
// Centralized constants used by parsers and filesystem readers.

/** Maximum size of a profile JSON file (256 KiB). */
export const MAX_PROFILE_JSON_BYTES = 262144;

/** Maximum size of the package config JSON file (64 KiB). */
export const MAX_CONFIG_BYTES = 65536;

/** Maximum size of a prompt file loaded via `@./…` (256 KiB). */
export const MAX_PROMPT_FILE_BYTES = 262144;

/** Maximum length of the `description` field. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Maximum length of an inline `system-prompt` or `append-system-prompt` value. */
export const MAX_INLINE_PROMPT_LENGTH = 4096;

/** Maximum length of a prompt file path string (after stripping the sigil). */
export const MAX_PROMPT_FILE_PATH_LENGTH = 1024;

/** Maximum length of the `provider` and `model` fields. */
export const MAX_FIELD_STRING_LENGTH = 4096;

/** Maximum length of the comma-separated `tools` string. */
export const MAX_TOOLS_STRING_LENGTH = 8192;

/** Maximum number of entries in the `skill` array. */
export const MAX_SKILL_ENTRIES = 128;

/** Maximum length of a single `skill` entry. */
export const MAX_SKILL_ENTRY_LENGTH = 4096;

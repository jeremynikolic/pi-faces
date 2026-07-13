// Byte and count limits for profile/config/prompt files.
// Centralized constants used by parsers and filesystem readers.

/** Maximum size of a profile JSON file (256 KiB). */
export const MAX_PROFILE_JSON_BYTES = 262144;

/** Maximum size of the package config JSON file (64 KiB). */
export const MAX_CONFIG_BYTES = 65536;

/** Maximum size of a prompt file loaded via `system_prompt_file` (256 KiB). */
export const MAX_PROMPT_FILE_BYTES = 262144;

/** Maximum length of the `description` field. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Maximum length of the inline `system_prompt` field. */
export const MAX_INLINE_PROMPT_LENGTH = 4096;

/** Maximum length of a `system_prompt_file` path string. */
export const MAX_PROMPT_FILE_PATH_LENGTH = 1024;

/** Maximum length of the `provider` and `model` fields. */
export const MAX_FIELD_STRING_LENGTH = 4096;

/** Maximum number of entries in the `tools` array. */
export const MAX_TOOLS_ENTRIES = 256;

/** Maximum length of a single tool name. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Maximum number of entries in the `skills` array. */
export const MAX_SKILLS_ENTRIES = 128;

/** Maximum length of a single `skills` entry. */
export const MAX_SKILL_ENTRY_LENGTH = 4096;

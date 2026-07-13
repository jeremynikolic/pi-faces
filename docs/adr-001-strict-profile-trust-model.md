# ADR 001 — Strict Profile Trust Model

## Context

`pi-agent-profiles` bundles description, model, provider, thinking level, tools, skills, and system prompt into a named JSON file selected via `--profile`. Before this decision the trust boundary was undefined: profile JSON was presented as convenient configuration, but a selected profile can replace the system prompt, scope tools, and inject arbitrary skill paths. The security audit found:

1. `system_prompt` could be an absolute or tilde path and load any readable local file into the model context.
2. `tools` looked like an allowlist but silently preserved every MCP, extension, and custom tool and ignored unknown names.
3. `skills` had no runtime schema validation and could crash discovery.
4. Profile/config/prompt reads were unbounded and accepted non-regular files.
5. Development dependency Vitest had known vulnerabilities.
6. Profile storage defaulted to world-readable modes.
7. The peer dependency range was unrestricted (`*`).

We needed a single coherent policy rather than a mix of convenience and security behavior.

## Decision

Profiles are **trusted executable configuration / least-privilege policy** for a single local user. The model is **strict, fail-closed, with no compatibility shim**:

- `system_prompt` is inline text only. A new `system_prompt_file` field is the only way to load a prompt from disk, and it must be a relative path confined to the profile root, resolved with `realpath` containment, opened with `O_NOFOLLOW`, verified as a regular file, and bounded in size.
- `tools` is a strict allowlist across every source (built-in, MCP, extension, custom). Unknown tool names reject profile application; empty `[]` means zero tools; omitting the field means no restriction.
- `skills` is validated at parse time as an array of non-empty strings with count/length limits and deduplicated.
- All file reads are bounded, regular-file only, with explicit size ceilings.
- Storage is private by default: directories `0700`, files `0600`, tightened on replace.
- Peer dependency declares a tested-compatible range instead of `*`.
- Vitest is upgraded to a fixed supported version.

Breaking changes are accepted and documented in the README.

## Consequences

Existing profiles that relied on the old loose semantics must migrate:

1. `system_prompt` used as a file path must move to `system_prompt_file`; the prompt file must live under the profile root. External/absolute/tilde paths are no longer supported.
2. Unknown tool names now reject the whole profile instead of being filtered and warned.
3. MCP, extension, and custom tools are no longer preserved implicitly; they must be named explicitly in `tools`.
4. `tools: []` now disables all tools. To mean "no restriction", omit the field.
5. `skills` entries must be non-empty strings; malformed arrays are rejected.
6. Oversized profile JSON (>256 KiB), prompt file (>256 KiB), or config (>64 KiB) are rejected.
7. Default profiles (`planner`, `coder`, `reviewer`) now drop implicit MCP/extension tools; users who want them must copy the default and add tool names explicitly.
8. Profile and config files are tightened to `0600`/directories to `0700` automatically.
9. Symlinked profile or config JSON files are rejected; users with dotfiles-style symlinks must replace them with real files or point `PI_PROFILES_DIR` at the real directory.

## Residual risks

The following risks are accepted, documented, or out of scope:

- **`PI_PROFILES_DIR` / `PI_PROFILES_CONFIG` ownership trust assumption.** The implementation does not check file ownership. The trust model assumes a single local user with exclusive write access to these directories. A shared or writable target directory could still inject policy. (SF3a)

- **`tightenStorageModes` chmod scope.** On the default profile directory the startup walk chmods top-level `*.json`, `config/config.json`, and the seed marker to `0600`. If the default directory held non-profile JSON files they would also be tightened. This is mitigated by skipping the walk entirely when `PI_PROFILES_DIR` is set; residual scope only affects the default directory, which is intended for profile storage. (SF3b / V6)

- **Hardlink / mount-bind / case-insensitive filesystem edge cases.** A hardlink to an external file is not a bypass: creating the hardlink requires read permission on the target inode, and the reader is still gated by that inode's permissions. Mount-bind escape requires `CAP_SYS_ADMIN` and is outside the unprivileged-attacker threat model. On case-insensitive filesystems (e.g. APFS on macOS) `realpath` canonicalizes case, so containment checks over-reject on case mismatch rather than allow escapes. (F-N1)

- **Intermediate directory swap window in `readSystemPromptFile`.** `realpath` containment is checked before the fd-based open. There remains a small window where a parent directory could be swapped, but the final component is then opened with `O_NOFOLLOW` and verified as a regular file via `fstat`, so a final-component symlink/FIFO/device swap is rejected. This residual window is accepted under the single-local-user trust model. (F-S1 residual)

- **`readBoundedFile` TOCTOU for profile/config JSON.** The helper uses `lstatSync` followed by `readFileSync`. This retains a stat-to-read race. It is accepted under the single-local-user model: an attacker who can swap the file already owns the profile directory, and `JSON.parse` gates malformed content; a FIFO swap would only cause a local DoS that the model runtime denies. (R2-2)

- **Skills path confinement is out of scope.** The remediation validates `skills` shape and prevents crashes, but it does not sandbox absolute, tilde, or cwd-relative skill paths. A profile can still reference skill files outside `~/.pi/skills`. Treat this as a separate hardening scope if needed. (F3 / V5)

- **Model provider sees prompt content.** Even with containment, the prompt text is sent to the configured model provider. Profile prompts should not contain secrets.

# pi-faces

<p align="center">
  <img src="art/banner.png" alt="pi-faces" width="1280">
</p>

**Faces** your agent can wear — each *face* is a named JSON profile bundling a short description, model, thinking level, tools, skills, and system prompt, selected via `--profile <name>`. Managed with the `/profiles` slash command. (Storage dir `~/.pi/faces/`. On first run after upgrading from the earlier `pi-agent-profiles` release, the extension auto-migrates `~/.pi/agent-profiles/` → `~/.pi/faces/` so existing profiles keep working — unless `PI_PROFILES_DIR` is set, in which case your override is used as-is.)

## Features

- **`--profile <name>` CLI flag**: Select a profile from the command line; flags pass through to `pi` as normal.
- **`/profiles` slash command**: List, show, create, edit, delete, and rename profiles in-session.
- **Bundled config**: Description, model, provider, thinking, tools, skills, and system prompt in one JSON file.
- **Per-session application**: Model, thinking, and tools applied once per session; system prompt applied every turn.
- **Prompt modes**: Append to or replace pi's built-in system prompt (`append-system-prompt` and `system-prompt`).
- **Session name prefix**: Active profile tags the session name so sessions group in `/resume` and `pi -r`.
- **Seeded defaults**: `planner`, `coder`, and `reviewer` are written into `~/.pi/faces/` automatically on first run.
- **Strict schema**: Unknown or legacy keys reject the profile, so typos are caught immediately.

## Install

```bash
pi install npm:pi-faces
```

Or from source:

```bash
pi install ./pi-faces
```

## Usage

```bash
pi --profile planner -p "design the caching layer"
pi --profile coder -p "implement the auth module"
pi --profile reviewer -p "review this diff"
```

Additional flags pass through to `pi` as normal.

Inside a pi session, use `/profiles` to manage profiles (see below).

## Profile Directory

Profiles live in `~/.pi/faces/<name>.json`:

```bash
mkdir -p ~/.pi/faces
ls ~/.pi/faces/*.json
```

Override the directory with the `PI_PROFILES_DIR` environment variable (default: `~/.pi/faces`).

## Profile Format

Each profile is a JSON file. All fields are optional — omit a field and `pi` keeps its default. `description` is metadata shown by `/profiles list`; it is not applied to the agent.

```json
{
  "description": "Plans work before implementation: scopes tasks, identifies risks, and writes a plan.",
  "model": "ollama-cloud/glm-5.2:high",
  "thinking": "high",
  "tools": "read, bash, grep",
  "skill": ["grilling", "domain-modeling"],
  "append-system-prompt": "You are a planning agent..."
}
```

| Field | Effect | Optional |
|---|---|---|
| `description` | Short purpose string, shown by `/profiles list`. Not applied to the agent. | Yes |
| `model` | Model reference — packed `provider/id` (`ollama-cloud/glm-5.2`), packed with thinking hint (`ollama-cloud/glm-5.2:high`), or bare `id` paired with `provider`. | Yes (requires provider unless packed) |
| `provider` | Provider ID paired with a bare `model` (e.g. `ollama-cloud`). Ignored when `model` is packed. | Yes (required for bare `model`) |
| `thinking` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | Yes |
| `tools` | Comma-separated tool names (built-in, MCP, extension, custom). Unknown names reject the profile. Empty string (`""`) means zero tools; omit the field for no restriction. | Yes |
| `skill` | Repeatable skill paths/names — each resolved to `~/.pi/skills/<name>` or an absolute/relative path. Missing paths are skipped with a warning. | Yes |
| `system-prompt` | Replace pi's built-in system prompt with this literal text or `@./<file>` reference. | Yes |
| `append-system-prompt` | Append this literal text or `@./<file>` reference to pi's built-in system prompt. Can be combined with `system-prompt`. | Yes |

`system-prompt` and `append-system-prompt` are **literal text unless they start with `@./`**. Any other value, including `@foo` or `@`, is returned verbatim and never interpreted as a path.

Only `@./<relative-path>` loads from a file under the profile root:

- The path must be relative and start with `./` after stripping the sigil.
- It must stay inside the profile root; `..`, absolute (`@/…`), and tilde (`@~/…`) forms are rejected.
- The target must be a regular file. Final-leaf symlinks are rejected, and the file is opened with `O_NOFOLLOW` to prevent TOCTOU swaps.
- Maximum file size is 256 KiB.
- Content is returned **without trimming**: leading/trailing whitespace and the final newline remain part of the value.

### Prompt composition

The exact result returned to pi is:

- `system-prompt` only → the `system-prompt` value exactly.
- `append-system-prompt` only → `event.systemPrompt + "\n\n" + append-system-prompt`.
- both → `system-prompt + "\n\n" + append-system-prompt`.

When the CLI also passes `--append-system-prompt` layers, the profile append composes **before** them — the final order is: built-in prompt → profile `append-system-prompt` → CLI append layers (in flag order) → project context/skills. This is the intended layering for multi-agent spawn patterns (e.g. `pi --profile critic --append-system-prompt ~/.pi/team/critic.md --append-system-prompt '## Your task...'`): the profile carries the persona identity, CLI appends add team/run context — every layer applies.

### Trust model

A selected profile is trusted executable configuration / least-privilege policy. It can replace the system prompt, scope the available tools, and inject skill paths, so treat profile JSON like code you would run.

Strict semantics:

- `tools` is a strict allowlist across every source. If any name is unknown, the whole profile is rejected and nothing from it is applied. Empty `""` means zero tools; omitting the field means no restriction (pi default).
- `system-prompt` / `append-system-prompt` values are literal text unless they start with `@./`. To load from disk, use `@./<file>` under the profile root; absolute, tilde, `..`, and symlink-escape paths are rejected.
- `skill` must be an array of non-empty strings. Missing resolved paths warn and skip, but do not reject the profile.
- Profile and config files are read with size limits and only as regular files; oversized, symlinked, or non-regular files are rejected.
- Storage is created/tightened as private: profile directories `0700`, files `0600`.
- Unknown profile keys reject the profile immediately and the error lists the supported set (`description`, `model`, `provider`, `thinking`, `tools`, `skill`, `system-prompt`, `append-system-prompt`).

Migration notes for existing profiles:

- This release is a **hard schema break**. Legacy keys (`skills`, `system_prompt`, `system_prompt_file`, `replace_system_prompt`) are rejected and there is no built-in converter.
- Manual mapping: `system_prompt` → `append-system-prompt`; `system_prompt_file` → `append-system-prompt: "@./<path>"`; `skills` → `skill`; `tools: [...]` → comma-separated `tools`; remove `replace_system_prompt`.
- `tools: []` now means zero tools; omit the field if you meant "no restriction".
- Symlinked profile or config JSON files are rejected; replace them with real files or point `PI_PROFILES_DIR` at the real directory.

### Skills cherry-pick

The `skill` field lists skill **names** or **paths**. At session start, the extension's `resources_discover` handler resolves each entry and contributes it as a skill path. Bare names resolve to `~/.pi/skills/<name>`; entries containing a path separator (or starting with `~`) are treated as paths (`~/` expanded, relative resolved against cwd, absolute as-is). Skills missing from the resolved path are skipped with a warning (no crash).

- **Additive (default):** if the spawn command does **not** pass `--no-skills`, pi's global skill discovery loads all skills in `~/.pi/skills` **plus** the profile's curated ones. The `skill` field guarantees the curated set is loaded; it does not exclude others.
- **Hard cherry-pick:** pass `--no-skills` on the spawn command (e.g. `pi --profile coder --no-skills`) to disable global discovery. Then **only** the profile's `skill` list loads — nothing else. This is the per-profile skill cherry-pick. Profile `skill` entries are still returned even when `--no-skills` is present.

Skills with `disable-model-invocation: true` in their frontmatter are **user-only** slash commands — they load but the agent cannot invoke them autonomously, so they're dead weight in an autonomous profile's `skill` list. Omit them.

### 💡 Tips & tricks — a clean, scoped agent profile

For a tightly-scoped autonomous agent (a team worker, a one-off spawn) that should see **only** its curated skills — not every skill on disk — combine the two:

1. **Curate the `skill` array** in the profile — list only the skills that role should invoke.
2. **Pass `--no-skills` on the spawn** (`pi --profile <name> --no-skills`) — disables pi's global skill discovery.

**Result:** the agent loads *only* the skills you listed — nothing else. Smaller context, no skill noise, no accidental invocations of unrelated skills. This is the per-profile hard cherry-pick.

Without `--no-skills`, the `skill` array is **additive** (every skill in `~/.pi/skills` loads too). That's the right default for *interactive* sessions where you want the full slash-command palette available — but the wrong choice for a *bounded autonomous worker* where unrelated skills are distractions + context bloat.

**Omit `disable-model-invocation: true` (user-only) skills** from a scoped profile's `skill` list — an autonomous agent can't invoke them, so they're dead weight even in a cherry-pick.

## Managing Profiles

Use the `/profiles` command inside a pi session:

| Action | Command |
|---|---|
| List profiles (name + description) | `/profiles` or `/profiles list` |
| Show a profile's full JSON | `/profiles show <name>` |
| Create a profile (scaffold + edit) | `/profiles new <name>` |
| Edit a profile in the editor | `/profiles edit <name>` |
| Delete a profile (with confirm) | `/profiles delete <name>` |
| Rename a profile (and its prompt dir) | `/profiles rename <old> <new>` |

Behavior notes:

- `/profiles list` and `/profiles show` print into the conversation so an agent can read the available profiles.
- `new` writes a new-format scaffold with a packed model, comma-separated `tools`, an array `skill`, and `append-system-prompt`. It runs non-interactively when the destination does not exist.
- `edit` and `delete` use interactive dialogs and require an interactive session.
- `rename` requires an interactive session only when the target already exists (to confirm overwrite).
- The extension does not translate legacy keys during show/edit/save.
- Profiles are also plain JSON files, so shell commands (`ls`, `rm`, `mv`) work too.

## Default Profiles

Three ready-made profiles — `planner`, `coder`, and `reviewer` — are seeded into `~/.pi/faces/` automatically on first run (after `pi install`). Seeding is idempotent: it runs only once per directory (tracked by a `.defaults-seeded` marker) and never overwrites an existing file, so your edits and deletions stick. The marker is not renamed or bumped. If you override `PI_PROFILES_DIR`, seeding is skipped — you own that directory.

| Profile | Model | Purpose |
|---|---|---|
| `planner` | `ollama-cloud/glm-5.2:high` | Scope a goal, identify risks, write an actionable plan |
| `coder` | `ollama-cloud/kimi-k2.7-code` | Take one bounded task, implement, run tests, report |
| `reviewer` | `ollama-cloud/glm-5.2:high` | Check implementation vs plan, coverage, edge cases, simplicity |

## How It Works

The extension registers a `--profile` CLI flag, a `/profiles` slash command, and applies the matching JSON in `before_agent_start`.

**Model, thinking, and tools are applied once per session** (so mid-session `/model` changes stick); the system prompt is applied every turn.

Settings go through pi's hostcalls (`getFlag`, `modelRegistry.find` + `setModel`, `setThinkingLevel`, `setActiveTools`) and a `{ systemPrompt }` return. Unknown tool names reject profile application; unknown profile keys reject the profile.

**Profiles act as defaults — explicit CLI flags win.** If you also pass `--model`/`--provider`, `--thinking`, `--tools`/`-t`, or `--system-prompt` as separate flag/value tokens, the corresponding profile concern is skipped for that run. `--append-system-prompt` is the exception: it **composes** with the profile's append prompt instead of overriding it (see the table below). `--flag=value` spellings and dangling value flags are **not** recognised as overrides. One-off examples:

```bash
pi --profile planner --model ollama-cloud/kimi-k2.7-code
pi --profile coder --tools read,write
pi --profile reviewer --thinking low
```

The concerns are grouped independently:

| Explicit CLI flag(s) | Effect on profile |
|---|---|
| `--model <v>` or `--provider <v>` | Skip profile `model` and any `:thinking` hint in it; profile `thinking` still applies unless `--thinking <v>` is also present. |
| `--thinking <v>` | Skip profile `thinking` and model hint; profile `model` still applies unless `--model`/`--provider` is also present. |
| `--tools <v>`, `-t <v>`, `--no-tools`, `-nt`, `--exclude-tools <v>`, `-xt <v>` | Skip profile `tools`; unrelated concerns still apply. |
| `--system-prompt <v>` | Full prompt ownership: skip all profile prompts; unrelated concerns still apply. |
| `--append-system-prompt <v>` | **Compose, not override.** Profile `append-system-prompt` still applies, stacked **before** the CLI append layers (identity first, CLI additions after); profile `system-prompt` (replace) is skipped so the built-in base survives; unrelated concerns still apply. |
| `--skill <path>` | Additive with profile `skill`; profile `skill` is still returned with `--no-skills`. |

Whole-CLI options such as `--session`, `--resume`, `--name`, `--extension`, `--theme`, and `--cwd` are outside profile reach.

## Session Name Prefix

When a profile is active, the extension automatically prefixes the session display name with `[<profile-name>]` so sessions group together in `/resume` and `pi -r`.

```text
pi --profile planner --name "Refactor auth module"
# → session shows as "[planner] Refactor auth module" in the selector
```

This applies to names set via `--name`, `/name`, or RPC `setSessionName()`. The prefix is **enabled by default** and controlled by a JSON config file:

```bash
mkdir -p ~/.pi/faces/config
echo '{"prefix_session_name": false}' > ~/.pi/faces/config/config.json
```

| Config field | Type | Default | Effect |
|---|---|---|
| `prefix_session_name` | boolean | `true` | Prefix the session display name with `[profile]` while a profile is active |

- The config file is optional — when missing, defaults apply (prefix on).
- `prefix_session_name` is only valid in `~/.pi/faces/config/config.json`; it is **not** a profile field.
- Override the config path with the `PI_PROFILES_CONFIG` environment variable (useful for per-launch overrides without editing the file).
- Unknown config fields are warned; `null` is treated as absent.
- The prefix is only added when a profile is active (`--profile` is set) and the name does not already carry the tag, so resuming a previously-prefixed session is not double-prefixed.

## License

MIT

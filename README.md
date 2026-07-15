# pi-faces

<p align="center">
  <img src="art/banner.png" alt="pi-faces" width="1280">
</p>

**Faces** your agent can wear — each *face* is a named JSON profile bundling a short description, model, provider, thinking level, tools, and system prompt, selected via `--profile <name>`. Managed with the `/profiles` slash command. (Storage dir `~/.pi/faces/`. On first run after upgrading from the earlier `pi-agent-profiles` release, the extension auto-migrates `~/.pi/agent-profiles/` → `~/.pi/faces/` so existing profiles keep working — unless `PI_PROFILES_DIR` is set, in which case your override is used as-is.)

## Features

- **`--profile <name>` CLI flag**: Select a profile from the command line; flags pass through to `pi` as normal.
- **`/profiles` slash command**: List, show, create, edit, delete, and rename profiles in-session.
- **Bundled config**: Description, model, provider, thinking, tools, and system prompt in one JSON file.
- **Per-session application**: Model, thinking, and tools applied once per session; system prompt applied every turn.
- **Prompt modes**: Append to or replace pi's built-in system prompt (`replace_system_prompt`).
- **Session name prefix**: Active profile tags the session name so sessions group in `/resume` and `pi -r`.
- **Seeded defaults**: `planner`, `coder`, and `reviewer` are written into `~/.pi/faces/` automatically on first run.
- **Graceful defaults**: Omit any field and `pi` keeps its default; unknown tool names reject profile application; unknown fields are warned.

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
  "provider": "ollama-cloud",
  "model": "glm-5.2",
  "thinking": "high",
  "tools": ["read", "bash", "grep"],
  "skills": ["grilling", "domain-modeling"],
  "system_prompt": "You are a planning agent...",
  "replace_system_prompt": false
}
```

| Field | Effect | Optional |
|---|---|---|
| `description` | Short purpose string, shown by `/profiles list`. Not applied to the agent. | Yes |
| `provider` | Provider ID (e.g. ollama-cloud, openai) | Yes |
| `model` | Model ID — bare (`glm-5.2`, paired with `provider`), combined `provider/id` (`ollama-cloud/glm-5.2`), or `provider/id:thinking` (the `:thinking` is used only if `thinking` is unset) | Yes (requires provider unless combined) |
| `thinking` | off / minimal / low / medium / high / xhigh / max | Yes |
| `tools` | Strict tool allowlist across all tool sources (built-in, MCP, extension, custom). Unknown names reject profile application; an empty array means zero tools; omit the field for no restriction. | Yes |
| `skills` | Skill name allowlist — each resolved to `~/.pi/skills/<name>` + loaded via `resources_discover` | Yes |
| `system_prompt` | Inline text only; never interpreted as a path. Mutually exclusive with `system_prompt_file`. | Yes |
| `system_prompt_file` | Relative path to a prompt file under the profile root. Contained to the profile root, regular file only, max 256 KiB. Mutually exclusive with `system_prompt`. | Yes |
| `replace_system_prompt` | boolean. Default `false`: the profile prompt is **appended** to pi's built-in system prompt. `true`: replace it entirely. | Yes |

`system_prompt` is **inline text only** — it is never interpreted as a file path. Max 4096 characters.

`system_prompt_file` loads prompt text from a file that is contained inside the profile root:

- Path must be relative (no leading `/` or `~/`, no `..` segment).
- Resolved path must stay inside the profile root; symlink escapes are rejected.
- Target must be a regular file and is read once per session.
- Only one of `system_prompt` or `system_prompt_file` may be present in a profile.

### Trust model

A selected profile is trusted executable configuration / least-privilege policy. It can replace the system prompt, scope the available tools, and inject skill paths, so treat profile JSON like code you would run.

Strict semantics:

- `tools` is a strict allowlist across every source. If any name is unknown, the whole profile is rejected and nothing from it is applied. Empty `[]` means zero tools; omitting the field means no restriction (pi default).
- `system_prompt` is inline text only. To load a prompt from disk, use `system_prompt_file` with a relative path under the profile root; absolute, tilde, `..`, and symlink-escape paths are rejected.
- `skills` must be an array of non-empty strings and is validated before use.
- Profile and config files are read with size limits and only as regular files; oversized, symlinked, or non-regular files are rejected.
- Storage is created/tightened as private: profile directories `0700`, files `0600`.

Migration notes for existing profiles:

- Profiles that used `system_prompt` as a file path must switch to `system_prompt_file` and place the prompt file under the profile root.
- Profiles relying on implicit preservation of MCP/extension/custom tools must add each non-built-in tool name explicitly to `tools`.
- `tools: []` now disables all tools; omit the field if you meant "no restriction".
- Symlinked profile or config JSON files are rejected; replace them with real files or point `PI_PROFILES_DIR` at the real directory.

### Skills cherry-pick

The `skills` field lists skill **names** or **paths**. At session start, the extension's `resources_discover` handler resolves each entry and contributes it as a skill path. Bare names resolve to `~/.pi/skills/<name>`; entries containing a path separator (or starting with `~`) are treated as paths (`~/` expanded, relative resolved against cwd, absolute as-is). Skills missing from the resolved path are skipped with a warning (no crash).

- **Additive (default):** if the spawn command does **not** pass `--no-skills`, pi's global skill discovery loads all skills in `~/.pi/skills` **plus** the profile's curated ones. The `skills` field guarantees the curated set is loaded; it does not exclude others.
- **Hard cherry-pick:** pass `--no-skills` on the spawn command (e.g. `pi --profile coder --no-skills`) to disable global discovery. Then **only** the profile's `skills` list loads — nothing else. This is the per-profile skill cherry-pick.

Skills with `disable-model-invocation: true` in their frontmatter are **user-only** slash commands — they load but the agent cannot invoke them autonomously, so they're dead weight in an autonomous profile's `skills` list. Omit them.

Unknown fields are reported as a warning (catches typos).

### 💡 Tips & tricks — a clean, scoped agent profile

For a tightly-scoped autonomous agent (a team worker, a one-off spawn) that should see **only** its curated skills — not every skill on disk — combine the two:

1. **Curate the `skills` array** in the profile — list only the skills that role should invoke.
2. **Pass `--no-skills` on the spawn** (`pi --profile <name> --no-skills`) — disables pi's global skill discovery.

**Result:** the agent loads *only* the skills you listed — nothing else. Smaller context, no skill noise, no accidental invocations of unrelated skills. This is the per-profile hard cherry-pick.

Without `--no-skills`, the `skills` array is **additive** (every skill in `~/.pi/skills` loads too). That's the right default for *interactive* sessions where you want the full slash-command palette available — but the wrong choice for a *bounded autonomous worker* where unrelated skills are distractions + context bloat.

**Omit `disable-model-invocation: true` (user-only) skills** from a scoped profile's `skills` list — an autonomous agent can't invoke them, so they're dead weight even in a cherry-pick.

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
- `new` runs non-interactively when the destination does not exist (it skips the description/edit prompts).
- `edit` and `delete` use interactive dialogs and require an interactive session.
- `rename` requires an interactive session only when the target already exists (to confirm overwrite).
- Profiles are also plain JSON files, so shell commands (`ls`, `rm`, `mv`) work too.

## Default Profiles

Three ready-made profiles — `planner`, `coder`, and `reviewer` — are seeded into `~/.pi/faces/` automatically on first run (after `pi install`). Seeding is idempotent: it runs only once per directory (tracked by a `.defaults-seeded` marker) and never overwrites an existing file, so your edits and deletions stick. If you override `PI_PROFILES_DIR`, seeding is skipped — you own that directory.

| Profile | Model | Purpose |
|---|---|---|
| `planner` | `glm-5.2` | Scope a goal, identify risks, write an actionable plan |
| `coder` | `kimi-k2.7-code` | Take one bounded task, implement, run tests, report |
| `reviewer` | `glm-5.2` | Check implementation vs plan, coverage, edge cases, simplicity |

## How It Works

The extension registers a `--profile` CLI flag, a `/profiles` slash command, and applies the matching JSON in `before_agent_start`.

**Model, thinking, and tools are applied once per session** (so mid-session `/model` changes stick); the system prompt is applied every turn. By default the profile prompt is **appended** to pi's built-in system prompt — set `replace_system_prompt: true` to replace it entirely.

Settings go through pi's hostcalls (`getFlag`, `modelRegistry.find` + `setModel`, `setThinkingLevel`, `setActiveTools`) and a `{ systemPrompt }` return. Unknown tool names reject profile application; unknown profile fields are warned.

**Profiles act as defaults — explicit CLI flags win.** If you also pass `--model`/`--provider`, `--thinking`, or `--tools`/`-t` on the command line, the corresponding profile field is skipped for that run, so a profile sets your defaults and a one-off flag overrides them (e.g. `pi --profile planner --model ollama-cloud/kimi-k2.7-code`).

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
|---|---|---|---|
| `prefix_session_name` | boolean | `true` | Prefix the session display name with `[profile]` while a profile is active |

- The config file is optional — when missing, defaults apply (prefix on).
- Override the config path with the `PI_PROFILES_CONFIG` environment variable (useful for per-launch overrides without editing the file).
- Unknown fields are warned; `null` is treated as absent.
- The prefix is only added when a profile is active (`--profile` is set) and the name does not already carry the tag, so resuming a previously-prefixed session is not double-prefixed.

## License

MIT
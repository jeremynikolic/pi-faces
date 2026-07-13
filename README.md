# pi-agent-profiles

<p align="center">
  <img src="art/banner.png" alt="pi-agent-profiles" width="1280">
</p>

Agent profiles for `pi` — bundle a short description, model, provider, thinking level, tools, and system prompt into a named JSON file, selected via `--profile <name>`. Managed with the `/profiles` slash command.

## Features

- **`--profile <name>` CLI flag**: Select a profile from the command line; flags pass through to `pi` as normal.
- **`/profiles` slash command**: List, show, create, edit, delete, and rename profiles in-session.
- **Bundled config**: Description, model, provider, thinking, tools, and system prompt in one JSON file.
- **Per-session application**: Model, thinking, and tools applied once per session; system prompt applied every turn.
- **Prompt modes**: Append to or replace pi's built-in system prompt (`replace_system_prompt`).
- **Session name prefix**: Active profile tags the session name so sessions group in `/resume` and `pi -r`.
- **Seeded defaults**: `planner`, `coder`, and `reviewer` are written into `~/.pi/agent-profiles/` automatically on first run.
- **Graceful defaults**: Omit any field and `pi` keeps its default; unknown fields and tool names are warned.

## Install

```bash
pi install npm:pi-agent-profiles
```

Or from source:

```bash
pi install ./pi-agent-profiles
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

Profiles live in `~/.pi/agent-profiles/<name>.json`:

```bash
mkdir -p ~/.pi/agent-profiles
ls ~/.pi/agent-profiles/*.json
```

Override the directory with the `PI_PROFILES_DIR` environment variable (default: `~/.pi/agent-profiles`).

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
| `tools` | Tool allowlist as array of strings (built-in tools only; MCP/extension tools are always preserved) | Yes |
| `skills` | Skill name allowlist — each resolved to `~/.pi/skills/<name>` + loaded via `resources_discover` | Yes |
| `system_prompt` | Inline text or path to a file | Yes |
| `replace_system_prompt` | boolean. Default `false`: the profile prompt is **appended** to pi's built-in system prompt. `true`: replace it entirely. | Yes |

`system_prompt` accepts either an inline string or a file path:

- File paths resolve relative to the profile JSON's directory; absolute and `~/` paths also work.
- If the string is not a readable file path, it is treated as inline text.

### Skills cherry-pick

The `skills` field lists skill **names** or **paths**. At session start, the extension's `resources_discover` handler resolves each entry and contributes it as a skill path. Bare names resolve to `~/.pi/skills/<name>`; entries containing a path separator (or starting with `~`) are treated as paths (`~/` expanded, relative resolved against cwd, absolute as-is). Skills missing from the resolved path are skipped with a warning (no crash).

- **Additive (default):** if the spawn command does **not** pass `--no-skills`, pi's global skill discovery loads all skills in `~/.pi/skills` **plus** the profile's curated ones. The `skills` field guarantees the curated set is loaded; it does not exclude others.
- **Hard cherry-pick:** pass `--no-skills` on the spawn command (e.g. `pi --profile coder --no-skills`) to disable global discovery. Then **only** the profile's `skills` list loads — nothing else. This is the per-profile skill cherry-pick.

Skills with `disable-model-invocation: true` in their frontmatter are **user-only** slash commands — they load but the agent cannot invoke them autonomously, so they're dead weight in an autonomous profile's `skills` list. Omit them.

Unknown fields are reported as a warning (catches typos).

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

Three ready-made profiles — `planner`, `coder`, and `reviewer` — are seeded into `~/.pi/agent-profiles/` automatically on first run (after `pi install`). Seeding is idempotent: it runs only once per directory (tracked by a `.defaults-seeded` marker) and never overwrites an existing file, so your edits and deletions stick. If you override `PI_PROFILES_DIR`, seeding is skipped — you own that directory.

| Profile | Model | Purpose |
|---|---|---|
| `planner` | `glm-5.2` | Scope a goal, identify risks, write an actionable plan |
| `coder` | `kimi-k2.7-code` | Take one bounded task, implement, run tests, report |
| `reviewer` | `glm-5.2` | Check implementation vs plan, coverage, edge cases, simplicity |

## How It Works

The extension registers a `--profile` CLI flag, a `/profiles` slash command, and applies the matching JSON in `before_agent_start`.

**Model, thinking, and tools are applied once per session** (so mid-session `/model` changes stick); the system prompt is applied every turn. By default the profile prompt is **appended** to pi's built-in system prompt — set `replace_system_prompt: true` to replace it entirely.

Settings go through pi's hostcalls (`getFlag`, `modelRegistry.find` + `setModel`, `setThinkingLevel`, `setActiveTools`) and a `{ systemPrompt }` return. Unknown tool names are filtered out and warned; unknown profile fields are warned.

**Profiles act as defaults — explicit CLI flags win.** If you also pass `--model`/`--provider`, `--thinking`, or `--tools`/`-t` on the command line, the corresponding profile field is skipped for that run, so a profile sets your defaults and a one-off flag overrides them (e.g. `pi --profile planner --model ollama-cloud/kimi-k2.7-code`).

## Session Name Prefix

When a profile is active, the extension automatically prefixes the session display name with `[<profile-name>]` so sessions group together in `/resume` and `pi -r`.

```text
pi --profile planner --name "Refactor auth module"
# → session shows as "[planner] Refactor auth module" in the selector
```

This applies to names set via `--name`, `/name`, or RPC `setSessionName()`. The prefix is **enabled by default** and controlled by a JSON config file:

```bash
mkdir -p ~/.pi/agent-profiles/config
echo '{"prefix_session_name": false}' > ~/.pi/agent-profiles/config/config.json
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
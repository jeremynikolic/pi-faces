---
name: pi-agent-profiles
description: Set up and manage pi agent profiles. Profiles bundle model, provider, thinking level, tools, and system prompt into a single JSON file, selected via the --profile CLI flag.
---

# Pi Agent Profiles

A profile system for `pi` that bundles a short description, model, provider, thinking level, tools, and system prompt into a single JSON file, selected via a native `--profile` CLI flag. Profiles are managed with the `/profiles` slash command. Implemented as a pi extension — no wrapper script needed.

## Architecture

```
~/.pi/agent-profiles/
├── planner.json          # provider, model, thinking, tools, system_prompt
├── coder.json
└── reviewer.json
```

The extension registers a `--profile` flag and a `/profiles` command. When you pass `--profile planner`, it reads `~/.pi/agent-profiles/planner.json` and applies:
- `provider` + `model` via `setModel()`
- `thinking` via `setThinkingLevel()`
- `tools` via `setActiveTools()`
- `system_prompt` via `before_agent_start` return

The `description` field is not applied to the agent — it is metadata shown by `/profiles list` so you (or an agent) can see what each profile is for at a glance, especially when a profile's `system_prompt` is long.

All fields optional. Omit a field and pi keeps its default.

## Setup

### 1. Install the extension

```bash
pi install npm:pi-agent-profiles
```

Or from a local path:

```bash
pi install ./pi-agent-profiles
```

### 2. Create the profiles directory

```bash
mkdir -p ~/.pi/agent-profiles
```

### 3. Create profiles

Write a JSON file per role, or use `/profiles new <name>` (see "Managing Profiles"). See "Profile Format" below.

## Profile Format

```json
{
  "description": "Plans work before implementation: scopes tasks, identifies risks, and writes a plan.",
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "thinking": "high",
  "tools": ["read", "bash", "grep", "find", "ls"],
  "system_prompt": "You are a planning agent. Your job is to..."
}
```

| Field | Effect | Optional |
|---|---|---|
| `description` | Short purpose string, shown by `/profiles list`. Not applied to the agent. | Yes |
| `provider` | Provider ID (anthropic, openai, etc.) | Yes |
| `model` | Model ID | Yes (requires provider) |
| `thinking` | off / minimal / low / medium / high / xhigh | Yes |
| `tools` | Tool allowlist as array of strings | Yes |
| `system_prompt` | Inline text or path to a file | Yes |

### System prompt: inline vs file path

`system_prompt` accepts either:

**Inline string** (short prompts):
```json
{
  "system_prompt": "You are a code reviewer. Check for bugs, edge cases, and unnecessary complexity."
}
```

**File path** (long prompts with markdown formatting):
```json
{
  "system_prompt": "./system-prompt.md"
}
```

File paths are resolved relative to the profile JSON's directory. Absolute paths and `~/` paths also work. If the string is not a readable file path, it is treated as inline text.

## Creating a New Profile

Quickest way — use the command, which scaffolds the JSON and prompts for a description:

```
/profiles new planner
```

Or write the file by hand:

```bash
mkdir -p ~/.pi/agent-profiles
cat > ~/.pi/agent-profiles/<name>.json << 'EOF'
{
  "description": "...",
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "thinking": "high",
  "tools": ["read", "bash", "grep", "find", "ls"],
  "system_prompt": "You are a..."
}
EOF
```

Or with a separate system prompt file (long prompts):

```bash
mkdir -p ~/.pi/agent-profiles/<name>
cat > ~/.pi/agent-profiles/<name>.json << 'EOF'
{
  "description": "...",
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "system_prompt": "./<name>/system-prompt.md"
}
EOF
# Write the system prompt file
```

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

`/profiles list` and `/profiles show` print into the conversation, so an agent can read the available profiles and their purposes. `new`, `edit`, and `delete` use interactive dialogs and require an interactive session.

Profiles are plain JSON files, so shell commands also work:

```bash
ls ~/.pi/agent-profiles/*.json     # list
rm ~/.pi/agent-profiles/<name>.json # delete
mv ~/.pi/agent-profiles/<old>.json ~/.pi/agent-profiles/<new>.json  # rename
```

## Usage

```bash
pi --profile planner -p "design the caching layer"
pi --profile coder -p "implement the auth module"
pi --profile reviewer -p "review this diff"
```

Additional flags pass through to pi as normal.

## How It Works

The extension hooks two pi APIs:

1. `registerFlag("profile", { type: "string", ... })` — registers the `--profile` CLI flag
2. `before_agent_start` event — reads the profile JSON and applies settings before the model processes any input
3. `registerCommand("profiles", ...)` — registers the `/profiles` slash command for listing and managing profiles

Settings are applied via pi's extension hostcalls:
- `setModel(provider, modelId)` — changes the active provider and model
- `setThinkingLevel(level)` — changes the thinking level
- `setActiveTools(tools)` — restricts the tool allowlist
- `before_agent_start` return `{ systemPrompt }` — replaces the system prompt

Pi's own config precedence still applies for anything the profile doesn't set (API keys, compaction config, etc.).

## Pitfalls

- **Profile must be valid JSON**: The extension logs a warning and falls back to pi defaults if the JSON is invalid.
- **All fields optional**: If a field is missing from the JSON, pi keeps its default for that setting. `description` is metadata only and never changes agent behavior.
- **system_prompt replaces default**: The system prompt from the profile replaces pi's built-in system prompt entirely.
- **File path resolution**: Relative paths in `system_prompt` resolve relative to the profile JSON's directory. If the string is not a readable file, it is treated as inline text.
- **Env var override**: Set `PI_PROFILES_DIR` to use a different profiles directory (default: `~/.pi/agent-profiles`).
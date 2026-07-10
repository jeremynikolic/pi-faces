---
name: pi-agent-profiles
description: Set up and manage pi agent profiles. Profiles bundle model, provider, thinking level, tools, and system prompt into a single JSON file, selected via the --profile CLI flag.
---

# Pi Agent Profiles

A profile system for `pi` that bundles model, provider, thinking level, tools, and system prompt into a single JSON file, selected via a native `--profile` CLI flag. Implemented as a pi extension — no wrapper script needed.

## Architecture

```
~/.pi/agent-profiles/
├── planner.json          # provider, model, thinking, tools, system_prompt
├── coder.json
└── reviewer.json
```

The extension registers a `--profile` flag. When you pass `--profile planner`, it reads `~/.pi/agent-profiles/planner.json` and applies:
- `provider` + `model` via `setModel()`
- `thinking` via `setThinkingLevel()`
- `tools` via `setActiveTools()`
- `system_prompt` via `before_agent_start` return

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

Write a JSON file per role. See "Profile Format" below.

## Profile Format

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "thinking": "high",
  "tools": ["read", "bash", "grep", "find", "ls"],
  "system_prompt": "You are a planning agent. Your job is to..."
}
```

| Field | Effect | Optional |
|---|---|---|
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

```bash
mkdir -p ~/.pi/agent-profiles
cat > ~/.pi/agent-profiles/<name>.json << 'EOF'
{
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "thinking": "high",
  "tools": ["read", "bash", "grep", "find", "ls"],
  "system_prompt": "You are a..."
}
EOF
```

Or with a separate system prompt file:

```bash
mkdir -p ~/.pi/agent-profiles/<name>
cat > ~/.pi/agent-profiles/<name>.json << 'EOF'
{
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "system_prompt": "./<name>/system-prompt.md"
}
EOF
# Write the system prompt file
```

## Managing Profiles

| Action | Command |
|---|---|
| List profiles | `ls ~/.pi/agent-profiles/*.json` |
| Create profile | Write `~/.pi/agent-profiles/<name>.json` |
| Edit profile | Edit `~/.pi/agent-profiles/<name>.json` |
| Delete profile | `rm ~/.pi/agent-profiles/<name>.json` |
| Rename profile | `mv ~/.pi/agent-profiles/<old>.json ~/.pi/agent-profiles/<new>.json` |

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

Settings are applied via pi's extension hostcalls:
- `setModel(provider, modelId)` — changes the active provider and model
- `setThinkingLevel(level)` — changes the thinking level
- `setActiveTools(tools)` — restricts the tool allowlist
- `before_agent_start` return `{ systemPrompt }` — replaces the system prompt

Pi's own config precedence still applies for anything the profile doesn't set (API keys, compaction config, etc.).

## Pitfalls

- **Profile must be valid JSON**: The extension logs a warning and falls back to pi defaults if the JSON is invalid.
- **All fields optional**: If a field is missing from the JSON, pi keeps its default for that setting.
- **system_prompt replaces default**: The system prompt from the profile replaces pi's built-in system prompt entirely.
- **File path resolution**: Relative paths in `system_prompt` resolve relative to the profile JSON's directory. If the string is not a readable file, it is treated as inline text.
- **Env var override**: Set `PI_PROFILES_DIR` to use a different profiles directory (default: `~/.pi/agent-profiles`).
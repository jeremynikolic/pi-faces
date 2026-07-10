# pi-agent-profiles

Agent profiles for `pi` — bundle model, provider, thinking level, tools, and system prompt into a named JSON file, selected via `--profile <name>`.

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

## Profile Directory

Profiles live in `~/.pi/profiles/<name>.json`:

```bash
mkdir -p ~/.pi/profiles
ls ~/.pi/profiles/*.json
```

Override the directory with the `PI_PROFILES_DIR` environment variable (default: `~/.pi/profiles`).

## Profile Format

Each profile is a JSON file. All fields are optional — omit a field and `pi` keeps its default.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "thinking": "high",
  "tools": ["read", "bash", "grep"],
  "system_prompt": "You are a planning agent..."
}
```

| Field | Effect | Optional |
|---|---|---|
| `provider` | Provider ID (anthropic, openai, etc.) | Yes |
| `model` | Model ID | Yes (requires provider) |
| `thinking` | off / minimal / low / medium / high / xhigh | Yes |
| `tools` | Tool allowlist as array of strings | Yes |
| `system_prompt` | Inline text or path to a file | Yes |

`system_prompt` accepts either an inline string or a file path. File paths resolve relative to the profile JSON's directory; absolute and `~/` paths also work. If the string is not a readable file path, it is treated as inline text.

## Managing Profiles

| Action | Command |
|---|---|
| List | `ls ~/.pi/profiles/*.json` |
| Create | Write `~/.pi/profiles/<name>.json` |
| Edit | Edit `~/.pi/profiles/<name>.json` |
| Delete | `rm ~/.pi/profiles/<name>.json` |
| Rename | `mv ~/.pi/profiles/<old>.json ~/.pi/profiles/<new>.json` |

## Example Profiles

See `profiles/` for ready-made planner, coder, and reviewer profiles. Copy them to `~/.pi/profiles/` to use:

```bash
cp profiles/*.json ~/.pi/profiles/
```

## How It Works

The extension registers a `--profile` CLI flag and applies the matching JSON before each agent run via `before_agent_start`. Settings are applied through pi's extension hostcalls: `setModel()`, `setThinkingLevel()`, `setActiveTools()`, and a `{ systemPrompt }` return. Pi's own config precedence still applies for anything the profile doesn't set.

See `skills/pi-agent-profiles/SKILL.md` for the full reference, including pitfalls and the inline-vs-file system prompt behavior.

## License

MIT
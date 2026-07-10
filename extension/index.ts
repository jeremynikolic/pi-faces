/**
 * pi-agent-profiles: Select a full agent profile via --profile <name>
 *
 * Registers a --profile CLI flag. When set, reads ~/.pi/agent-profiles/<name>.json
 * and applies: provider, model, thinking level, tools, and system prompt.
 *
 * Also registers a /profiles slash command for listing and managing profiles.
 *
 * The profile JSON supports all fields optionally. Omit a field and pi keeps
 * its default for that setting.
 *
 * Profile fields:
 *   - description:   short human/agent-readable purpose (shown by /profiles)
 *   - provider:      provider id (anthropic, openai, ...)
 *   - model:         model id (requires provider)
 *   - thinking:      off / minimal / low / medium / high / xhigh
 *   - tools:         tool allowlist as an array of strings
 *   - system_prompt: inline string OR a file path (relative to the profile
 *                    JSON, or absolute / ~/). If the string is not a readable
 *                    file path it is treated as inline prompt text.
 *
 * Install:
 *   pi install npm:pi-agent-profiles
 *
 * Usage:
 *   pi --profile planner -p "design the caching layer"
 *   pi --profile coder -p "implement the auth module"
 *   /profiles list
 *   /profiles edit planner
 *
 * Profile files:
 *   ~/.pi/agent-profiles/planner.json
 *   ~/.pi/agent-profiles/coder.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  unlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILES_DIR =
  (typeof process !== "undefined" && process.env && process.env.PI_PROFILES_DIR) ||
  "~/.pi/agent-profiles";

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return (typeof os !== "undefined" ? os.homedir() : "") + p.slice(1);
  }
  return p;
}

function profilesDir(): string {
  return expandTilde(PROFILES_DIR);
}

function profilePath(name: string): string {
  return path.join(profilesDir(), name + ".json");
}

function readProfile(name: string): Record<string, unknown> | undefined {
  const file = profilePath(name);

  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    console.warn("[pi-agent-profiles] Invalid JSON in " + file + ": " + err);
    return undefined;
  }
}

function readProfileRaw(name: string): { ok: true; content: string } | { ok: false; error: string } {
  const file = profilePath(name);
  try {
    return { ok: true, content: readFileSync(file, "utf-8") };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

interface ProfileSummary {
  name: string;
  description: string | undefined;
}

function listProfiles(): ProfileSummary[] {
  const dir = profilesDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const summaries: ProfileSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    let description: string | undefined;
    const profile = readProfile(name);
    if (profile && typeof profile.description === "string") {
      description = profile.description;
    }
    summaries.push({ name, description });
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

function resolveSystemPrompt(value: unknown, baseDir: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;

  // Try as a file path first
  const resolved = resolvePath(value, baseDir);
  try {
    return readFileSync(resolved, "utf-8").trim();
  } catch {
    // Not a file — treat as inline prompt text
    return value.trim();
  }
}

function resolvePath(p: string, baseDir: string): string {
  if (p.startsWith("/") || p.startsWith("~")) return expandTilde(p);
  return baseDir + "/" + p;
}

function isValidProfileName(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".."
  );
}

function defaultScaffold(description: string): string {
  return (
    JSON.stringify(
      {
        description: description || "TODO: describe this profile's purpose",
        provider: "anthropic",
        model: "claude-sonnet-4",
        thinking: "high",
        tools: ["read", "bash", "grep", "find", "ls"],
        system_prompt: "You are a...",
      },
      null,
      2
    ) + "\n"
  );
}

export default function (pi: ExtensionAPI) {
  // Register the --profile CLI flag
  pi.registerFlag("profile", {
    type: "string",
    description: "Agent profile name (loads ~/.pi/agent-profiles/<name>.json)",
  });

  // Apply the profile before the agent starts
  pi.on("before_agent_start", async (_event, ctx) => {
    const flag =
      (ctx.getFlag && ctx.getFlag("profile")) ||
      (ctx.flags && ctx.flags.profile);
    if (!flag) return;

    const profileName = typeof flag === "string" ? flag : String(flag);
    const dir = profilesDir();
    const profile = readProfile(profileName);

    if (!profile) {
      console.warn(
        "[pi-agent-profiles] No profile found for \"" +
          profileName +
          "\" in " +
          dir
      );
      return;
    }

    // Apply model + provider
    const provider = profile.provider;
    const model = profile.model;
    if (provider && model && ctx.setModel) {
      try {
        await ctx.setModel(provider, model);
      } catch (err) {
        console.warn(
          "[pi-agent-profiles] Failed to set model: " + err
        );
      }
    }

    // Apply thinking level
    const thinking = profile.thinking;
    if (thinking && ctx.setThinkingLevel) {
      try {
        await ctx.setThinkingLevel(thinking);
      } catch (err) {
        console.warn(
          "[pi-agent-profiles] Failed to set thinking level: " + err
        );
      }
    }

    // Apply tools
    const tools = profile.tools;
    if (Array.isArray(tools) && ctx.setActiveTools) {
      try {
        ctx.setActiveTools(tools);
      } catch (err) {
        console.warn(
          "[pi-agent-profiles] Failed to set tools: " + err
        );
      }
    }

    // Apply system prompt
    const systemPrompt = resolveSystemPrompt(
      profile.system_prompt,
      dir + "/" + profileName
    );

    if (systemPrompt) {
      return { systemPrompt };
    }
  });

  // Register the /profiles management command
  pi.registerCommand("profiles", {
    description:
      "Manage agent profiles: list, show, new, edit, delete, rename (usage: /profiles [list|show|new|edit|delete|rename] [name])",
    getArgumentCompletions(argPrefix) {
      const parts = argPrefix.split(/\s+/);
      if (parts.length < 2) return null;
      const sub = parts[0];
      const typed = parts[parts.length - 1];

      // Subcommands that complete a profile name (first or second name arg)
      const nameSubs = new Set(["show", "edit", "delete", "rm", "rename", "mv"]);
      if (!nameSubs.has(sub)) return null;

      return listProfiles()
        .filter((p) => p.name.startsWith(typed))
        .map((p) => ({
          value: p.name,
          label: p.name,
          description: p.description,
        }));
    },
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "list";

      switch (sub) {
        case "list":
        case "ls": {
          return cmdList(ctx);
        }
        case "show":
        case "cat": {
          return cmdShow(parts[1], ctx);
        }
        case "new":
        case "create": {
          return cmdNew(parts[1], ctx);
        }
        case "edit": {
          return cmdEdit(parts[1], ctx);
        }
        case "delete":
        case "rm":
        case "remove": {
          return cmdDelete(parts[1], ctx);
        }
        case "rename":
        case "mv": {
          return cmdRename(parts[1], parts[2], ctx);
        }
        default: {
          ctx.ui.notify(
            "[pi-agent-profiles] Unknown subcommand: " + sub,
            "warning"
          );
          ctx.ui.notify(
            "Usage: /profiles [list|show <name>|new <name>|edit <name>|delete <name>|rename <old> <new>]",
            "info"
          );
        }
      }
    },
  });

  // --- command implementations ---

  async function cmdList(ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) {
    const dir = profilesDir();
    const profiles = listProfiles();
    if (profiles.length === 0) {
      pi.sendMessage({
        customType: "pi-agent-profiles",
        content: "No profiles found in " + dir,
        display: true,
      });
      return;
    }
    const lines = profiles.map((p) => {
      const desc = p.description ? p.description : "(no description)";
      return "• " + p.name + " — " + desc;
    });
    const body =
      "Profiles in " + dir + " (" + profiles.length + "):\n\n" + lines.join("\n");
    pi.sendMessage({
      customType: "pi-agent-profiles",
      content: body,
      display: true,
    });
  }

  async function cmdShow(
    name: string | undefined,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext
  ) {
    if (!isValidProfileName(name)) {
      ctx.ui.notify("Usage: /profiles show <name>", "warning");
      return;
    }
    const raw = readProfileRaw(name);
    if (!raw.ok) {
      ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
      return;
    }
    pi.sendMessage({
      customType: "pi-agent-profiles",
      content: "Profile " + name + ":\n\n```json\n" + raw.content.trim() + "\n```",
      display: true,
    });
  }

  async function cmdNew(
    name: string | undefined,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext
  ) {
    if (!isValidProfileName(name)) {
      ctx.ui.notify("Usage: /profiles new <name>", "warning");
      return;
    }
    const file = profilePath(name);
    if (existsSync(file)) {
      if (!ctx.hasUI) {
        ctx.ui.notify("[pi-agent-profiles] Profile already exists: " + name, "warning");
        return;
      }
      const overwrite = await ctx.ui.confirm(
        "Profile exists",
        name + ".json already exists. Overwrite?"
      );
      if (!overwrite) return;
    }

    let description = "";
    if (ctx.hasUI) {
      description = (await ctx.ui.input("Description (short purpose):", "")) || "";
    }

    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(file, defaultScaffold(description), "utf-8");
    ctx.ui.notify("[pi-agent-profiles] Created " + file, "info");

    if (ctx.hasUI) {
      const doEdit = await ctx.ui.confirm("Edit now?", "Open editor for " + name + "?");
      if (doEdit) await editInEditor(name, ctx);
    }
  }

  async function cmdEdit(
    name: string | undefined,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext
  ) {
    if (!isValidProfileName(name)) {
      ctx.ui.notify("Usage: /profiles edit <name>", "warning");
      return;
    }
    if (!existsSync(profilePath(name))) {
      ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
      return;
    }
    await editInEditor(name, ctx);
  }

  async function editInEditor(
    name: string,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext
  ) {
    if (!ctx.hasUI) {
      ctx.ui.notify("[pi-agent-profiles] edit requires an interactive session", "warning");
      return;
    }
    const raw = readProfileRaw(name);
    if (!raw.ok) {
      ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
      return;
    }
    const edited = await ctx.ui.editor("Edit " + name, raw.content);
    if (edited === undefined) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    try {
      JSON.parse(edited);
    } catch (err) {
      const save = await ctx.ui.confirm(
        "Invalid JSON",
        "This is not valid JSON: " + err + "\n\nSave anyway?"
      );
      if (!save) return;
    }
    writeFileSync(profilePath(name), edited, "utf-8");
    ctx.ui.notify("[pi-agent-profiles] Saved " + name, "info");
  }

  async function cmdDelete(
    name: string | undefined,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext
  ) {
    if (!isValidProfileName(name)) {
      ctx.ui.notify("Usage: /profiles delete <name>", "warning");
      return;
    }
    const file = profilePath(name);
    if (!existsSync(file)) {
      ctx.ui.notify("[pi-agent-profiles] No profile: " + name, "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("[pi-agent-profiles] delete requires confirmation; use an interactive session", "warning");
      return;
    }
    const ok = await ctx.ui.confirm("Delete " + name + "?", "Removes " + file);
    if (!ok) return;
    unlinkSync(file);

    const sib = path.join(profilesDir(), name);
    if (existsSync(sib) && statSync(sib).isDirectory()) {
      const removeDir = await ctx.ui.confirm(
        "Remove prompt directory?",
        "A directory named " + name + "/ exists (likely holds a system_prompt file). Remove it too?"
      );
      if (removeDir) {
        try {
          // recursive remove via exec
          await pi.exec("rm", ["-rf", sib]);
          ctx.ui.notify("[pi-agent-profiles] Removed " + name + "/ and " + name + ".json", "info");
          return;
        } catch (err) {
          ctx.ui.notify("[pi-agent-profiles] Failed to remove " + sib + ": " + err, "warning");
        }
      }
    }
    ctx.ui.notify("[pi-agent-profiles] Deleted " + name, "info");
  }

  async function cmdRename(
    from: string | undefined,
    to: string | undefined,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext
  ) {
    if (!isValidProfileName(from) || !isValidProfileName(to)) {
      ctx.ui.notify("Usage: /profiles rename <old> <new>", "warning");
      return;
    }
    const fromFile = profilePath(from);
    const toFile = profilePath(to);
    if (!existsSync(fromFile)) {
      ctx.ui.notify("[pi-agent-profiles] No profile: " + from, "warning");
      return;
    }
    if (existsSync(toFile)) {
      if (!ctx.hasUI) {
        ctx.ui.notify("[pi-agent-profiles] target exists: " + to, "warning");
        return;
      }
      const overwrite = await ctx.ui.confirm("Target exists", "Overwrite " + to + "?");
      if (!overwrite) return;
    }
    renameSync(fromFile, toFile);

    // Move a matching sibling prompt directory if present
    const fromDir = path.join(profilesDir(), from);
    const toDir = path.join(profilesDir(), to);
    if (
      existsSync(fromDir) &&
      statSync(fromDir).isDirectory() &&
      !existsSync(toDir)
    ) {
      try {
        renameSync(fromDir, toDir);
      } catch (err) {
        ctx.ui.notify(
          "[pi-agent-profiles] Renamed profile but could not move directory " + from + "/: " + err,
          "warning"
        );
      }
    }
    ctx.ui.notify("[pi-agent-profiles] Renamed " + from + " → " + to, "info");
  }
}
/**
 * pi-agent-profiles: Select a full agent profile via --profile <name>
 *
 * Registers a --profile CLI flag. When set, reads ~/.pi/profiles/<name>.json
 * and applies: provider, model, thinking level, tools, and system prompt.
 *
 * The profile JSON supports all fields optionally. Omit a field and pi keeps
 * its default for that setting.
 *
 * system_prompt can be:
 *   - An inline string (the prompt text directly)
 *   - A file path (relative to the profile JSON, or absolute)
 *
 * Install:
 *   pi install npm:pi-agent-profiles
 *
 * Usage:
 *   pi --profile planner -p "design the caching layer"
 *   pi --profile coder -p "implement the auth module"
 *
 * Profile files:
 *   ~/.pi/profiles/planner.json
 *   ~/.pi/profiles/coder.json
 */

import type { ExtensionAPI } from "@anthropic/pi-coding-agent";
import { readFileSync } from "node:fs";
import os from "node:os";

const PROFILES_DIR =
  (typeof process !== "undefined" && process.env && process.env.PI_PROFILES_DIR) ||
  "~/.pi/profiles";

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return (typeof os !== "undefined" ? os.homedir() : "") + p.slice(1);
  }
  return p;
}

function resolvePath(p: string, baseDir: string): string {
  if (p.startsWith("/") || p.startsWith("~")) return expandTilde(p);
  return baseDir + "/" + p;
}

function readProfile(name: string): Record<string, unknown> | undefined {
  const dir = expandTilde(PROFILES_DIR);
  const file = dir + "/" + name + ".json";

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

function resolveSystemPrompt(
  value: unknown,
  baseDir: string
): string | undefined {
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

export default function (pi: ExtensionAPI) {
  // Register the --profile CLI flag
  pi.registerFlag({
    name: "profile",
    type: "string",
    description: "Agent profile name (loads ~/.pi/profiles/<name>.json)",
  });

  // Apply the profile before the agent starts
  pi.on("before_agent_start", async (_event, ctx) => {
    const flag =
      (ctx.getFlag && ctx.getFlag("profile")) ||
      (ctx.flags && ctx.flags.profile);
    if (!flag) return;

    const profileName = typeof flag === "string" ? flag : String(flag);
    const dir = expandTilde(PROFILES_DIR);
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
}
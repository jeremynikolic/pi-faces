import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, statSync, unlinkSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { profilePath, profilesDir } from "./paths.ts";
import {
	atomicWrite,
	defaultScaffold,
	isValidProfileName,
	listProfiles,
	readProfileRaw,
} from "./profile.ts";

const SUBCOMMANDS = ["list", "show", "new", "edit", "delete", "rename"];

/** Register the `/profiles` management command and its handlers. */
export function registerProfilesCommand(pi: ExtensionAPI): void {
	pi.registerCommand("profiles", {
		description:
			"Manage agent profiles: list, show, new, edit, delete, rename (usage: /profiles [list|show|new|edit|delete|rename] [name])",
		getArgumentCompletions(argPrefix) {
			const parts = argPrefix.split(/\s+/);

			// No subcommand typed yet → complete subcommand names.
			if (parts.length < 2) {
				const prefix = parts[0] ?? "";
				const all = [...SUBCOMMANDS];
				return all
					.filter((s) => s.startsWith(prefix))
					.map((s) => ({ value: s, label: s, description: undefined }));
			}

			const sub = parts[0];
			const canonical = SUBCOMMANDS.includes(sub);

			if (!canonical) return null;

			// rename: complete only the source (first name arg), never the
			// target — completing the target with existing names invites overwrite.
			if (sub === "rename") {
				if (parts.length !== 2) return null;
				const typed = parts[1];
				return listProfiles()
					.filter((p) => p.name.startsWith(typed))
					.map((p) => ({ value: sub + " " + p.name, label: p.name, description: p.description }));
			}

			// show/edit/delete take a single name arg.
			if (parts.length !== 2) return null;
			const typed = parts[1];
			return listProfiles()
				.filter((p) => p.name.startsWith(typed))
				.map((p) => ({ value: sub + " " + p.name, label: p.name, description: p.description }));
		},
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] || "list";

			switch (sub) {
				case "list":
					return cmdList(ctx);
				case "show":
					return cmdShow(parts[1], ctx);
				case "new":
					return cmdNew(parts[1], ctx);
				case "edit":
					return cmdEdit(parts[1], ctx);
				case "delete":
					return cmdDelete(parts[1], ctx);
				case "rename":
					return cmdRename(parts[1], parts[2], ctx);
				default:
					ctx.ui.notify("[pi-faces] Unknown subcommand: " + sub, "warning");
					ctx.ui.notify(
						"Usage: /profiles [list|show <name>|new <name>|edit <name>|delete <name>|rename <old> <new>]",
						"info"
					);
			}
		},
	});

	// --- command implementations ---

	async function cmdList(ctx: ExtensionCommandContext) {
		const dir = profilesDir();
		const profiles = listProfiles();
		if (profiles.length === 0) {
			pi.sendMessage({
				customType: "pi-faces",
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
			customType: "pi-faces",
			content: body,
			display: true,
		});
	}

	async function cmdShow(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles show <name>", "warning");
			return;
		}
		const raw = readProfileRaw(name);
		if (!raw.ok) {
			ctx.ui.notify("[pi-faces] No profile: " + name, "warning");
			return;
		}
		pi.sendMessage({
			customType: "pi-faces",
			content: "Profile " + name + ":\n\n```json\n" + raw.content.trim() + "\n```",
			display: true,
		});
	}

	async function cmdNew(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles new <name>", "warning");
			return;
		}
		const file = profilePath(name);
		if (existsSync(file)) {
			if (!ctx.hasUI) {
				ctx.ui.notify("[pi-faces] Profile already exists: " + name, "warning");
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

		try {
			mkdirSync(profilesDir(), { recursive: true });
			atomicWrite(file, defaultScaffold(description));
		} catch (err) {
			ctx.ui.notify("[pi-faces] Failed to create profile: " + err, "error");
			return;
		}
		ctx.ui.notify("[pi-faces] Created " + file, "info");

		if (ctx.hasUI) {
			const doEdit = await ctx.ui.confirm("Edit now?", "Open editor for " + name + "?");
			if (doEdit) await editInEditor(name, ctx);
		}
	}

	async function cmdEdit(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles edit <name>", "warning");
			return;
		}
		if (!existsSync(profilePath(name))) {
			ctx.ui.notify("[pi-faces] No profile: " + name, "warning");
			return;
		}
		await editInEditor(name, ctx);
	}

	async function editInEditor(name: string, ctx: ExtensionCommandContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("[pi-faces] edit requires an interactive session", "warning");
			return;
		}
		const raw = readProfileRaw(name);
		if (!raw.ok) {
			ctx.ui.notify("[pi-faces] No profile: " + name, "warning");
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
		try {
			atomicWrite(profilePath(name), edited);
		} catch (err) {
			ctx.ui.notify("[pi-faces] Failed to save profile: " + err, "error");
			return;
		}
		ctx.ui.notify("[pi-faces] Saved " + name, "info");
	}

	async function cmdDelete(name: string | undefined, ctx: ExtensionCommandContext) {
		if (!isValidProfileName(name)) {
			ctx.ui.notify("Usage: /profiles delete <name>", "warning");
			return;
		}
		const file = profilePath(name);
		if (!existsSync(file)) {
			ctx.ui.notify("[pi-faces] No profile: " + name, "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"[pi-faces] delete requires confirmation; use an interactive session",
				"warning"
			);
			return;
		}
		const ok = await ctx.ui.confirm("Delete " + name + "?", "Removes " + file);
		if (!ok) return;
		try {
			unlinkSync(file);
		} catch (err) {
			ctx.ui.notify("[pi-faces] Failed to delete profile: " + err, "error");
			return;
		}

		const sib = path.join(profilesDir(), name);
		if (existsSync(sib) && statSync(sib).isDirectory()) {
			const removeDir = await ctx.ui.confirm(
				"Remove prompt directory?",
				"A directory named " + name + "/ exists (likely holds a system_prompt file). Remove it too?"
			);
			if (removeDir) {
				try {
					rmSync(sib, { recursive: true, force: true });
					ctx.ui.notify(
						"[pi-faces] Removed " + name + "/ and " + name + ".json",
						"info"
					);
					return;
				} catch (err) {
					ctx.ui.notify(
						"[pi-faces] Deleted " + name + ".json but failed to remove " + name + "/: " + err,
						"warning"
					);
					return;
				}
			}
		}
		ctx.ui.notify("[pi-faces] Deleted " + name, "info");
	}

	async function cmdRename(
		from: string | undefined,
		to: string | undefined,
		ctx: ExtensionCommandContext
	) {
		if (!isValidProfileName(from) || !isValidProfileName(to)) {
			ctx.ui.notify("Usage: /profiles rename <old> <new>", "warning");
			return;
		}
		const fromFile = profilePath(from);
		const toFile = profilePath(to);
		if (!existsSync(fromFile)) {
			ctx.ui.notify("[pi-faces] No profile: " + from, "warning");
			return;
		}
		const toExisted = existsSync(toFile);
		if (toExisted) {
			if (!ctx.hasUI) {
				ctx.ui.notify("[pi-faces] target exists: " + to, "warning");
				return;
			}
			const overwrite = await ctx.ui.confirm("Target exists", "Overwrite " + to + "?");
			if (!overwrite) return;
		}

		// Preflight the sibling prompt directory. If a sibling source dir exists
		// AND a target dir already exists, we cannot move it (would need to merge)
		// and leaving the source dir orphaned would break the renamed profile's
		// system_prompt path. Abort the whole rename in that case.
		const fromDir = path.join(profilesDir(), from);
		const toDir = path.join(profilesDir(), to);
		const hasSib = existsSync(fromDir) && statSync(fromDir).isDirectory();
		if (hasSib && existsSync(toDir)) {
			ctx.ui.notify(
				"[pi-faces] target directory exists: " + to + "/ — rename aborted (cannot merge directories)",
				"warning"
			);
			return;
		}

		try {
			renameSync(fromFile, toFile);
		} catch (err) {
			ctx.ui.notify("[pi-faces] Failed to rename profile: " + err, "error");
			return;
		}

		if (hasSib) {
			try {
				renameSync(fromDir, toDir);
			} catch (err) {
				// Roll back the profile rename only if we did not just overwrite
				// an existing target (otherwise rollback would clobber the old file).
				if (!toExisted) {
					try {
						renameSync(toFile, fromFile);
					} catch {
						// best-effort rollback; report the split state below
					}
				}
				ctx.ui.notify(
					"[pi-faces] Renamed profile but could not move directory " +
						from +
						"/: " + err,
					"warning"
				);
				return;
			}
		}
		ctx.ui.notify("[pi-faces] Renamed " + from + " → " + to, "info");
	}
}
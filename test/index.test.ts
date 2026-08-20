import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	existsSync,
	symlinkSync,
	chmodSync,
	lstatSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import factory, {
	resolvePromptValue,
	isValidProfileName,
	parseProfileFile,
	parseConfigFile,
	hasProfilePrefix,
	withProfilePrefix,
	parseModelRef,
	readBoundedFile,
	THINKING_LEVELS,
	SUPPORTED_PROFILE_KEYS,
	type Profile,
	type PackageConfig,
} from "../src/index.ts";
import {
	MAX_INLINE_PROMPT_LENGTH,
	MAX_PROMPT_FILE_BYTES,
	MAX_PROMPT_FILE_PATH_LENGTH,
	MAX_PROFILE_JSON_BYTES,
	MAX_CONFIG_BYTES,
	MAX_TOOLS_STRING_LENGTH,
	MAX_SKILL_ENTRIES,
	MAX_SKILL_ENTRY_LENGTH,
} from "../src/limits.ts";
import { resetRealProfilesRoot, realProfilesRoot } from "../src/paths.ts";
import { readProfile } from "../src/profile.ts";

// Mock node:fs only for renameSync so we can force the sibling-directory move to
// fail (after the profile file was renamed) and exercise the rollback branch.
// Everything else delegates to the real fs, so the rest of the suite is
// unaffected. The flag is reset to null by default.
const __piapMock = vi.hoisted(() => ({
	throwOnRenamePath: null as string | null,
	swapOpenSync: null as string | null,
}));
vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			if (__piapMock.throwOnRenamePath !== null && to === __piapMock.throwOnRenamePath) {
				throw new Error("forced dir-rename failure");
			}
			return actual.renameSync(from, to);
		},
		openSync: (path: string | Buffer, flags: string | number, mode?: number) => {
			const fd = actual.openSync(path, flags, mode);
			if (typeof path === "string" && __piapMock.swapOpenSync !== null) {
				try {
					actual.unlinkSync(path);
				} catch {
					// ignore
				}
				actual.symlinkSync(__piapMock.swapOpenSync, path);
				__piapMock.swapOpenSync = null;
			}
			return fd;
		},
	};
});

// --- typed stubs (no `any`) --------------------------------------------------

interface CapturedCommand {
	description: string;
	getArgumentCompletions: (argPrefix: string) => unknown;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface PiCalls {
	setModel: unknown[];
	setThinkingLevel: unknown[];
	setActiveTools: unknown[][];
	sendMessage: { customType: string; content: string; display: boolean }[];
	setSessionName: string[];
}

type AnyHandler = (event: any, ctx: ExtensionContext) => unknown;

function makePi(calls: PiCalls, flags: Map<string, boolean | string>) {
	const handlers = new Map<string, AnyHandler[]>();
	const commands = new Map<string, CapturedCommand>();
	const allTools: { name: string; sourceInfo?: { source: string } }[] = [
		{ name: "read", sourceInfo: { source: "builtin" } },
		{ name: "bash", sourceInfo: { source: "builtin" } },
		{ name: "edit", sourceInfo: { source: "builtin" } },
		{ name: "write", sourceInfo: { source: "builtin" } },
		{ name: "grep", sourceInfo: { source: "builtin" } },
		{ name: "find", sourceInfo: { source: "builtin" } },
		{ name: "ls", sourceInfo: { source: "builtin" } },
		{ name: "mcp_coord", sourceInfo: { source: "mcp" } },
		{ name: "ext_extra", sourceInfo: { source: "extension" } },
	];
	let sessionName: string | undefined;

	const pi = {
		getFlag: (n: string) => flags.get(n),
		registerFlag: () => {},
		on: (ev: string, h: AnyHandler) => {
			const list = handlers.get(ev) ?? [];
			list.push(h);
			handlers.set(ev, list);
		},
		registerCommand: (name: string, o: CapturedCommand) => {
			commands.set(name, o);
		},
		sendMessage: (m: { customType: string; content: string; display: boolean }) => calls.sendMessage.push(m),
		setModel: async (model: unknown) => {
			calls.setModel.push(model);
			return true;
		},
		setThinkingLevel: (level: unknown) => calls.setThinkingLevel.push(level),
		setActiveTools: (tools: string[]) => calls.setActiveTools.push(tools),
		getAllTools: () => allTools,
		getSessionName: () => sessionName,
		setSessionName: (name: string) => {
			sessionName = name;
			calls.setSessionName.push(name);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		handlers,
		command: (name: string) => commands.get(name),
		setSessionNameState: (name: string | undefined) => {
			sessionName = name;
		},
	};
}

interface UiOpts {
	notify?: (m: string, t?: "info" | "warning" | "error") => void;
	confirm?: () => Promise<boolean>;
	input?: () => Promise<string | undefined>;
	editor?: () => Promise<string | undefined>;
}

function uiStub(opts: UiOpts = {}): ExtensionUIContext {
	return {
		notify: opts.notify ?? (() => {}),
		confirm: opts.confirm ?? (async () => false),
		input: opts.input ?? (async () => undefined),
		editor: opts.editor ?? (async () => undefined),
	} as unknown as ExtensionUIContext;
}

interface CtxOpts {
	ui?: ExtensionUIContext;
	hasUI?: boolean;
	modelRegistry?: ExtensionContext["modelRegistry"];
}

function makeCtx(opts: CtxOpts = {}): ExtensionCommandContext {
	return {
		ui: opts.ui ?? uiStub(),
		hasUI: opts.hasUI ?? false,
		mode: "print",
		cwd: process.cwd(),
		modelRegistry: opts.modelRegistry,
	} as unknown as ExtensionCommandContext;
}

function modelCtx(findImpl: (p: string, m: string) => unknown): ExtensionCommandContext {
	return makeCtx({ modelRegistry: { find: findImpl } as unknown as ExtensionContext["modelRegistry"] });
}

function event(sp?: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "",
		systemPrompt: sp ?? "BUILT-IN",
	} as BeforeAgentStartEvent;
}
function sessionStartEvent() {
	return { type: "session_start" } as unknown as BeforeAgentStartEvent;
}

async function runApplySessionStart(handlers: Map<string, AnyHandler[]>, ctx: ExtensionContext): Promise<void> {
	const h = handlers.get("session_start")?.[0];
	if (h) await h(sessionStartEvent(), ctx);
}

async function runSessionStart(handlers: Map<string, AnyHandler[]>, ctx: ExtensionContext): Promise<void> {
	for (const h of handlers.get("session_start") ?? []) {
		await h(sessionStartEvent(), ctx);
	}
}

function makeCalls(): PiCalls {
	return { setModel: [], setThinkingLevel: [], setActiveTools: [], sendMessage: [], setSessionName: [] };
}

function setupCommand() {
	const calls = makeCalls();
	const flags = new Map<string, boolean | string>();
	const { pi, command } = makePi(calls, flags);
	factory(pi);
	return { calls, flags, command };
}

// setup/teardown -------------------------------------------------------------

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "piap-test-"));
	process.env.PI_PROFILES_DIR = dir;
	resetRealProfilesRoot();
});

afterEach(() => {
	delete process.env.PI_PROFILES_DIR;
	__piapMock.throwOnRenamePath = null;
	__piapMock.swapOpenSync = null;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function writeProfile(name: string, profile: Profile): void {
	writeFileSync(join(dir, name + ".json"), JSON.stringify(profile));
}

function writeConfig(config: PackageConfig): void {
	mkdirSync(join(dir, "config"), { recursive: true });
	writeFileSync(join(dir, "config", "config.json"), JSON.stringify(config));
}

function withArgv(argv: string[], fn: () => Promise<void> | void): Promise<void> {
	const original = process.argv;
	process.argv = argv;
	return (async () => {
		try {
			await fn();
		} finally {
			process.argv = original;
		}
	})();
}

// --- pure helpers -----------------------------------------------------------

describe("isValidProfileName", () => {
	it("accepts a normal name", () => {
		expect(isValidProfileName("planner")).toBe(true);
	});
	it("rejects path traversal and special names", () => {
		for (const bad of ["", undefined, "../other", "a/b", "a\\b", ".", ".."]) {
			expect(isValidProfileName(bad as string | undefined)).toBe(false);
		}
	});
	it("rejects whitespace", () => {
		expect(isValidProfileName("my profile")).toBe(false);
		expect(isValidProfileName("a\tb")).toBe(false);
		expect(isValidProfileName("a\nb")).toBe(false);
	});
});

// --- schema + strict whitelist ----------------------------------------------

describe("parseProfileFile schema", () => {
	it("accepts a valid profile with every supported key", () => {
		const r = parseProfileFile(
			JSON.stringify({
				description: "d",
				model: "ollama-cloud/glm-5.2:high",
				provider: "ignored",
				thinking: "high",
				tools: "read, bash",
				skill: ["qmd"],
				"system-prompt": "replace",
				"append-system-prompt": "append",
			}),
			"f.json"
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.warnings).toHaveLength(0);
	});

	it("deduplicates skill entries in first-seen order", () => {
		const r = parseProfileFile('{"skill":["a","a","b","A"]}', "f.json");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.profile.skill).toEqual(["a", "b", "A"]);
	});

	it("rejects non-object JSON", () => {
		for (const c of ["[]", "null", '"hi"', "42"]) {
			expect(parseProfileFile(c, "f.json").ok).toBe(false);
		}
	});

	it("rejects invalid JSON", () => {
		expect(parseProfileFile("{not json", "f.json").ok).toBe(false);
	});

	it("rejects null values", () => {
		for (const key of Array.from(SUPPORTED_PROFILE_KEYS)) {
			const obj: Record<string, unknown> = {};
			obj[key] = null;
			expect(parseProfileFile(JSON.stringify(obj), "f.json").ok).toBe(false);
		}
	});

	it("rejects wrong field types", () => {
		expect(parseProfileFile('{"description":5}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"tools":["read"]}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"skill":"x"}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"thinking":"nope"}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"system-prompt":[]}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"append-system-prompt":true}', "f.json").ok).toBe(false);
	});

	it("rejects over-long fields", () => {
		expect(
			parseProfileFile('{"description":"' + "x".repeat(MAX_INLINE_PROMPT_LENGTH + 1) + '"}', "f.json").ok
		).toBe(false);
		expect(
			parseProfileFile('{"tools":"' + "x".repeat(MAX_TOOLS_STRING_LENGTH + 1) + '"}', "f.json").ok
		).toBe(false);
		expect(
			parseProfileFile('{"skill":["' + "x".repeat(MAX_SKILL_ENTRY_LENGTH + 1) + '"]}', "f.json").ok
		).toBe(false);
		expect(
			parseProfileFile(
				'{"skill":' + JSON.stringify(Array(MAX_SKILL_ENTRIES + 1).fill("s")) + "}",
				"f.json"
			).ok
		).toBe(false);
	});

	it("rejects legacy and unknown keys, naming the supported set", () => {
		for (const bad of [
			"skills",
			"system_prompt",
			"system_prompt_file",
			"replace_system_prompt",
			"no-skills",
			"theme",
			"name",
			"profile",
			"typo",
		]) {
			const r = parseProfileFile(JSON.stringify({ [bad]: "x" }), "f.json");
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.error).toContain(bad);
				expect(r.error).toContain(Array.from(SUPPORTED_PROFILE_KEYS).join(", "));
			}
		}
	});

	it("rejects a recursive profile key", () => {
		const r = parseProfileFile('{"profile":"nested"}', "f.json");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("profile");
	});

	it("allows both prompt keys together", () => {
		const r = parseProfileFile(
			'{"system-prompt":"r","append-system-prompt":"a"}',
			"f.json"
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.warnings).toHaveLength(0);
	});

	it("success result has no unknown-field warnings", () => {
		const r = parseProfileFile('{"description":"x"}', "f.json");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.warnings).toHaveLength(0);
	});
});

describe("parseProfileFile model/provider cross-field", () => {
	it("packed model passes without provider", () => {
		expect(parseProfileFile('{"model":"ollama-cloud/glm-5.2:high"}', "f.json").ok).toBe(true);
	});

	it("bare model with provider passes", () => {
		expect(
			parseProfileFile('{"model":"glm-5.2","provider":"ollama-cloud"}', "f.json").ok
		).toBe(true);
	});

	it("packed model with separate provider passes (packed wins)", () => {
		expect(
			parseProfileFile('{"model":"ollama-cloud/glm-5.2","provider":"other"}', "f.json").ok
		).toBe(true);
	});

	it("bare model without provider rejects", () => {
		const r = parseProfileFile('{"model":"glm-5.2"}', "f.json");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("packed provider/id");
	});

	it("provider without model rejects", () => {
		const r = parseProfileFile('{"provider":"ollama-cloud"}', "f.json");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("provider requires a model");
	});

	it("empty packed provider or id rejects", () => {
		expect(parseProfileFile('{"model":"/glm-5.2"}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"model":"ollama-cloud/"}', "f.json").ok).toBe(false);
	});
});

// --- prompt resolver / security ---------------------------------------------

describe("resolvePromptValue", () => {
	it("returns literal strings verbatim", () => {
		const r = resolvePromptValue("  You are…\n", dir);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toBe("  You are…\n");
	});

	it("treats @foo and @ as literal", () => {
		expect(resolvePromptValue("@role.md", dir)).toEqual({ ok: true, content: "@role.md" });
		expect(resolvePromptValue("@", dir)).toEqual({ ok: true, content: "@" });
	});

	it("loads @./ file content verbatim, preserving whitespace and final newline", () => {
		writeFileSync(join(dir, "role.md"), "  leading\ntrailing  \n");
		const r = resolvePromptValue("@./role.md", dir);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toBe("  leading\ntrailing  \n");
	});

	it("rejects @~/ path", () => {
		const r = resolvePromptValue("@~/secret", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("@~/secret");
	});

	it("rejects @/ absolute path", () => {
		const r = resolvePromptValue("@/etc/passwd", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("@/etc/passwd");
	});

	it("rejects @./../ escape", () => {
		const r = resolvePromptValue("@./../secret", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("@./../secret");
	});

	it("rejects missing file", () => {
		const r = resolvePromptValue("@./missing.md", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("missing.md");
	});

	it("rejects a directory", () => {
		mkdirSync(join(dir, "prompts"));
		const r = resolvePromptValue("@./prompts", dir);
		expect(r.ok).toBe(false);
	});

	it("rejects a FIFO", () => {
		if (process.platform === "win32") return;
		const fifo = join(dir, "pipe");
		spawnSync("mkfifo", [fifo]);
		const r = resolvePromptValue("@./pipe", dir);
		expect(r.ok).toBe(false);
	});

	it("rejects an oversized file without echoing content", () => {
		const p = join(dir, "huge.md");
		writeFileSync(p, Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1, "x"));
		const r = resolvePromptValue("@./huge.md", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain(String(MAX_PROMPT_FILE_BYTES + 1));
			expect(r.error).not.toContain("xxxxxxxx");
		}
	});

	it("rejects a final-leaf symlink to an in-root file", () => {
		mkdirSync(join(dir, "prompts"));
		writeFileSync(join(dir, "prompts", "target.md"), "target");
		symlinkSync(join(dir, "prompts", "target.md"), join(dir, "link.md"));
		const r = resolvePromptValue("@./link.md", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("symlink");
	});

	it("rejects a final-leaf symlink that escapes the root", () => {
		const external = mkdtempSync(join(tmpdir(), "piap-ext-"));
		writeFileSync(join(external, "secret.md"), "external");
		symlinkSync(join(external, "secret.md"), join(dir, "escape.md"));
		const r = resolvePromptValue("@./escape.md", dir);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("escape.md");
			expect(r.error).not.toContain("external");
		}
		rmSync(external, { recursive: true, force: true });
	});

	it("returns originally-opened inode content after a mid-call symlink swap", () => {
		const external = mkdtempSync(join(tmpdir(), "piap-swap-ext-"));
		writeFileSync(join(external, "target.md"), "external");
		writeFileSync(join(dir, "sp.md"), "good");
		__piapMock.swapOpenSync = join(external, "target.md");
		const r = resolvePromptValue("@./sp.md", dir);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toBe("good");
		expect(readFileSync(join(dir, "sp.md"), "utf-8")).toBe("external");
		rmSync(external, { recursive: true, force: true });
	});

	it("loads an in-root file when the profile root itself is a symlink", () => {
		const real = mkdtempSync(join(tmpdir(), "piap-realroot-"));
		writeFileSync(join(real, "sp.md"), "symlinked root");
		const linkDir = join(tmpdir(), "piap-linkroot-" + Date.now());
		symlinkSync(real, linkDir);
		process.env.PI_PROFILES_DIR = linkDir;
		resetRealProfilesRoot();
		const r = resolvePromptValue("@./sp.md", realProfilesRoot());
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toBe("symlinked root");
		const up = resolvePromptValue("@./../escape.md", realProfilesRoot());
		expect(up.ok).toBe(false);
		process.env.PI_PROFILES_DIR = dir;
		resetRealProfilesRoot();
		rmSync(real, { recursive: true, force: true });
		try {
			rmSync(linkDir, { recursive: true, force: true });
		} catch {
			// symlink to dir may need unlink
		}
	});
});

// --- model parser -----------------------------------------------------------

describe("parseModelRef", () => {
	it("splits a packed provider/id", () => {
		expect(parseModelRef(undefined, "ollama-cloud/glm-5.2")).toEqual({
			provider: "ollama-cloud",
			modelId: "glm-5.2",
			thinkingHint: undefined,
		});
	});

	it("uses separate provider for a bare id", () => {
		expect(parseModelRef("ollama-cloud", "glm-5.2")).toEqual({
			provider: "ollama-cloud",
			modelId: "glm-5.2",
			thinkingHint: undefined,
		});
	});

	it("packed provider wins over separate provider", () => {
		expect(parseModelRef("other", "ollama-cloud/glm-5.2")).toEqual({
			provider: "ollama-cloud",
			modelId: "glm-5.2",
			thinkingHint: undefined,
		});
	});

	it("strips a recognised trailing :thinking hint", () => {
		expect(parseModelRef("ollama-cloud", "glm-5.2:high")).toEqual({
			provider: "ollama-cloud",
			modelId: "glm-5.2",
			thinkingHint: "high",
		});
	});

	it("treats an unrecognised trailing suffix as part of the id", () => {
		expect(parseModelRef("ollama-cloud", "gpt-oss:20b")).toEqual({
			provider: "ollama-cloud",
			modelId: "gpt-oss:20b",
			thinkingHint: undefined,
		});
	});

	it("handles colon-bearing id with recognised final hint", () => {
		expect(parseModelRef(undefined, "ollama-cloud/gpt-oss:20b:low")).toEqual({
			provider: "ollama-cloud",
			modelId: "gpt-oss:20b",
			thinkingHint: "low",
		});
	});
});

// --- applier lifecycle / precedence -----------------------------------------

describe("session_start applier", () => {
	it("applies model/thinking/tools once and appends prompt every turn", async () => {
		writeProfile("planner", {
			provider: "anthropic",
			model: "claude-sonnet-4",
			thinking: "high",
			tools: "read, bash",
			"append-system-prompt": "You are a planner.",
		});
		const calls = makeCalls();
		const flags = new Map([["profile", "planner"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx((p, m) => ({ id: m, provider: p }));
		await runApplySessionStart(handlers, ctx);
		const r1 = await handlers.get("before_agent_start")![0](event("BUILT-IN"), ctx);
		const r2 = await handlers.get("before_agent_start")![0](event("BUILT-IN"), ctx);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["high"]);
		expect(calls.setActiveTools).toEqual([["read", "bash"]]);
		expect(r1).toEqual({ systemPrompt: "BUILT-IN\n\nYou are a planner." });
		expect(r2).toEqual({ systemPrompt: "BUILT-IN\n\nYou are a planner." });
	});

	it("replaces the built-in prompt with system-prompt", async () => {
		writeProfile("p", { "system-prompt": "ONLY THIS" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r).toEqual({ systemPrompt: "ONLY THIS" });
	});

	it("composes both prompt keys with exactly two newlines", async () => {
		writeProfile("p", {
			"system-prompt": "replace ",
			"append-system-prompt": " append",
		});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const r = await handlers.get("before_agent_start")![0](event("BASE"), makeCtx());
		expect(r).toEqual({ systemPrompt: "replace \n\n append" });
	});

	it("loads prompt from @./ file for either key without trimming", async () => {
		writeFileSync(join(dir, "sp.md"), "  file prompt\n");
		writeProfile("p", { "append-system-prompt": "@./sp.md" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r).toEqual({ systemPrompt: "BUILT-IN\n\n  file prompt\n" });
	});

	it("applies model thinking hint when thinking field is absent", async () => {
		writeProfile("p", { model: "ollama-cloud/glm-5.2:high" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, modelCtx(() => ({ id: "x" })));
		expect(calls.setThinkingLevel).toEqual(["high"]);
	});

	it("lets separate thinking override model hint", async () => {
		writeProfile("p", { model: "ollama-cloud/glm-5.2:high", thinking: "low" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, modelCtx(() => ({ id: "x" })));
		expect(calls.setThinkingLevel).toEqual(["low"]);
	});

	it("rejects unknown tools entirely with no partial hostcalls", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProfile("p", { provider: "x", model: "y", thinking: "high", tools: "read, nope" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx(() => ({ id: "y" }));
		await runApplySessionStart(handlers, ctx);
		expect(calls.setModel).toHaveLength(0);
		expect(calls.setThinkingLevel).toHaveLength(0);
		expect(calls.setActiveTools).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nope"));
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), ctx);
		expect(r).toBeUndefined();
	});

	it("does not reject unknown profile tools when tools concern dropped by CLI", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProfile("p", { tools: "nope" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await withArgv(["node", "pi", "--profile", "p", "--tools", "read"], async () => {
			await runApplySessionStart(handlers, makeCtx());
		});
		expect(calls.setActiveTools).toHaveLength(0);
		expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("nope"));
	});

	it("sets zero tools when tools is an empty string", async () => {
		writeProfile("p", { tools: "" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		expect(calls.setActiveTools).toEqual([[]]);
	});

	it("leaves default tools when tools is absent", async () => {
		writeProfile("p", {});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		expect(calls.setActiveTools).toHaveLength(0);
	});

	it("deduplicates and trims tools while preserving order", async () => {
		writeProfile("p", { tools: " read , bash , read , ls " });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		expect(calls.setActiveTools).toEqual([["read", "bash", "ls"]]);
	});

	it("rejects invalid dropped profile prompt file only when prompt concern is active", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProfile("p", {
			"system-prompt": "@./../escape.md",
			"append-system-prompt": "keep",
		});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await withArgv(["node", "pi", "--profile", "p", "--append-system-prompt", "cli"], async () => {
			await runApplySessionStart(handlers, makeCtx());
		});
		// dropped profile prompts: invalid @./../escape.md must not be opened/errored
		expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("escape.md"));
		const r = await handlers.get("before_agent_start")![0](event("BASE"), makeCtx());
		expect(r).toBeUndefined();
	});

	it("rejects profile when an active prompt file is invalid", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProfile("p", { "append-system-prompt": "@./../escape.md" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("escape.md"));
		expect(calls.setActiveTools).toHaveLength(0);
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r).toBeUndefined();
	});

	it("re-validates on reload", async () => {
		writeProfile("p", { tools: "nope" });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		expect(calls.setActiveTools).toHaveLength(0);
		writeProfile("p", { tools: "read" });
		warnSpy.mockClear();
		await runApplySessionStart(handlers, makeCtx());
		expect(calls.setActiveTools).toEqual([["read"]]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("refreshes cached prompts on reload", async () => {
		writeFileSync(join(dir, "sp.md"), "A");
		writeProfile("p", { "append-system-prompt": "@./sp.md" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const r1 = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r1).toEqual({ systemPrompt: "BUILT-IN\n\nA" });
		writeFileSync(join(dir, "sp.md"), "B");
		await runApplySessionStart(handlers, makeCtx());
		const r2 = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r2).toEqual({ systemPrompt: "BUILT-IN\n\nB" });
	});
});

// --- CLI precedence ---------------------------------------------------------

describe("CLI precedence", () => {
	it("no explicit flags -> profile applies fully", async () => {
		writeProfile("p", {
			model: "ollama-cloud/glm-5.2:high",
			tools: "read",
			"append-system-prompt": "sp",
		});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx(() => ({ id: "x" }));
		await runApplySessionStart(handlers, ctx);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["high"]);
		expect(calls.setActiveTools).toEqual([["read"]]);
	});

	it("--model X drops profile model and model hint, keeps profile thinking", async () => {
		writeProfile("p", { model: "ollama-cloud/glm-5.2:high", thinking: "low" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx(() => ({ id: "x" }));
		await withArgv(["node", "pi", "--profile", "p", "--model", "ollama-cloud/kimi-k2.7-code"], async () => {
			await runApplySessionStart(handlers, ctx);
		});
		expect(calls.setModel).toHaveLength(0);
		expect(calls.setThinkingLevel).toEqual(["low"]);
	});

	it("--provider X alone drops profile model and hint", async () => {
		writeProfile("p", { model: "ollama-cloud/glm-5.2:high" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx(() => ({ id: "x" }));
		await withArgv(["node", "pi", "--profile", "p", "--provider", "openai"], async () => {
			await runApplySessionStart(handlers, ctx);
		});
		expect(calls.setModel).toHaveLength(0);
		expect(calls.setThinkingLevel).toHaveLength(0);
	});

	it("--thinking X drops profile thinking, keeps model", async () => {
		writeProfile("p", { model: "ollama-cloud/glm-5.2:high" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx(() => ({ id: "x" }));
		await withArgv(["node", "pi", "--profile", "p", "--thinking", "low"], async () => {
			await runApplySessionStart(handlers, ctx);
		});
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toHaveLength(0);
	});

	it("each tools alias drops profile setActiveTools", async () => {
		writeProfile("p", { tools: "read" });
		const aliases = [
			["node", "pi", "--profile", "p", "--tools", "bash"],
			["node", "pi", "--profile", "p", "-t", "bash"],
			["node", "pi", "--profile", "p", "--no-tools"],
			["node", "pi", "--profile", "p", "-nt"],
			["node", "pi", "--profile", "p", "--exclude-tools", "bash"],
			["node", "pi", "--profile", "p", "-xt", "bash"],
		];
		for (const argv of aliases) {
			const calls = makeCalls();
			const flags = new Map([["profile", "p"]]);
			const { pi, handlers } = makePi(calls, flags);
			factory(pi);
			await withArgv(argv, async () => {
				await runApplySessionStart(handlers, makeCtx());
			});
			expect(calls.setActiveTools).toHaveLength(0);
		}
	});

	it("dangling tools value flags do not override", async () => {
		writeProfile("p", { tools: "read" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await withArgv(["node", "pi", "--profile", "p", "--tools"], async () => {
			await runApplySessionStart(handlers, makeCtx());
		});
		expect(calls.setActiveTools).toEqual([["read"]]);
	});

	it("=value spellings do not override any concern", async () => {
		writeProfile("p", {
			model: "ollama-cloud/glm-5.2:high",
			thinking: "low",
			tools: "read",
			"append-system-prompt": "sp",
		});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx(() => ({ id: "x" }));
		await withArgv(
			[
				"node",
				"pi",
				"--profile",
				"p",
				"--model=ollama-cloud/kimi-k2.7-code",
				"--thinking=medium",
				"--tools=bash",
				"--append-system-prompt=cli",
			],
			async () => {
				await runApplySessionStart(handlers, ctx);
			}
		);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["low"]);
		expect(calls.setActiveTools).toEqual([["read"]]);
		const r = await handlers.get("before_agent_start")![0](event("BASE"), ctx);
		expect(r).toEqual({ systemPrompt: "BASE\n\nsp" });
	});

	it("explicit prompt flags drop profile prompts", async () => {
		writeProfile("p", { "append-system-prompt": "profile" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await withArgv(["node", "pi", "--profile", "p", "--system-prompt", "cli"], async () => {
			await runApplySessionStart(handlers, makeCtx());
		});
		const r = await handlers.get("before_agent_start")![0](event("BASE"), makeCtx());
		expect(r).toBeUndefined();
	});

	it("explicit prompt flags with no value do not drop profile prompts", async () => {
		writeProfile("p", { "append-system-prompt": "profile" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await withArgv(["node", "pi", "--profile", "p", "--system-prompt"], async () => {
			await runApplySessionStart(handlers, makeCtx());
		});
		const r = await handlers.get("before_agent_start")![0](event("BASE"), makeCtx());
		expect(r).toEqual({ systemPrompt: "BASE\n\nprofile" });
	});
});

// --- skills -----------------------------------------------------------------

describe("resources_discover skills", () => {
	it("returns profile skills when they exist on disk", async () => {
		const skillDir = mkdtempSync(join(tmpdir(), "piap-skill-"));
		writeProfile("p", { skill: [skillDir] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const res = handlers.get("resources_discover")![0](
			{ cwd: process.cwd(), reason: "test" },
			makeCtx()
		) as { skillPaths?: string[] };
		expect(res?.skillPaths).toEqual([skillDir]);
		rmSync(skillDir, { recursive: true, force: true });
	});

	it("warns and skips missing profile skills", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProfile("p", { skill: ["/nope"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const res = handlers.get("resources_discover")![0](
			{ cwd: process.cwd(), reason: "test" },
			makeCtx()
		);
		expect(res).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("/nope"));
	});

	it("adds CLI --skill paths to profile skills", async () => {
		const skillDir = mkdtempSync(join(tmpdir(), "piap-skill-"));
		writeProfile("p", {});
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		let res: { skillPaths?: string[] } | undefined;
		await withArgv(["node", "pi", "--profile", "p", "--skill", skillDir], async () => {
			await runApplySessionStart(handlers, makeCtx());
			res = handlers.get("resources_discover")![0](
				{ cwd: process.cwd(), reason: "test" },
				makeCtx()
			) as { skillPaths?: string[] };
		});
		expect(res?.skillPaths).toEqual([skillDir]);
		rmSync(skillDir, { recursive: true, force: true });
	});

	it("still returns profile skills when --no-skills is present", async () => {
		const skillDir = mkdtempSync(join(tmpdir(), "piap-skill-"));
		writeProfile("p", { skill: [skillDir] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await withArgv(["node", "pi", "--profile", "p", "--no-skills"], async () => {
			await runApplySessionStart(handlers, makeCtx());
		});
		const res = handlers.get("resources_discover")![0](
			{ cwd: process.cwd(), reason: "test" },
			makeCtx()
		) as { skillPaths?: string[] };
		expect(res?.skillPaths).toEqual([skillDir]);
		rmSync(skillDir, { recursive: true, force: true });
	});

	it("returns undefined when profile is rejected", async () => {
		writeProfile("p", { tools: "nope", skill: ["/x"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		const res = handlers.get("resources_discover")![0](
			{ cwd: process.cwd(), reason: "test" },
			makeCtx()
		);
		expect(res).toBeUndefined();
	});
});

// --- /profiles command ------------------------------------------------------

describe("/profiles command", () => {
	it("list prints an empty message when there are no profiles", async () => {
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("list", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
		expect(calls.sendMessage[0].content).toContain("No profiles found in");
	});

	it("list prints names + descriptions, sorted", async () => {
		writeProfile("zebra", { description: "z" });
		writeProfile("alpha", { description: "a" });
		writeProfile("mid", {});
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("list", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
		const body = calls.sendMessage[0].content;
		expect(body.indexOf("alpha")).toBeLessThan(body.indexOf("mid"));
		expect(body.indexOf("mid")).toBeLessThan(body.indexOf("zebra"));
		expect(body).toContain("alpha — a");
		expect(body).toContain("mid — (no description)");
	});

	it("default subcommand is list", async () => {
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
		expect(calls.sendMessage[0].content).toContain("No profiles found");
	});

	it("show with an invalid/missing name notifies and does not message", async () => {
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("show ../x", makeCtx());
		await command("profiles")!.handler("show nope", makeCtx());
		expect(calls.sendMessage).toHaveLength(0);
	});

	it("show displays the persisted new-format JSON", async () => {
		writeProfile("demo", { model: "ollama-cloud/glm-5.2:high", tools: "read" });
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("show demo", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
		expect(calls.sendMessage[0].content).toContain('"model":"ollama-cloud/glm-5.2:high"');
		expect(calls.sendMessage[0].content).toContain('"tools":"read"');
	});

	it("new writes a new-format scaffold", async () => {
		const { command } = setupCommand();
		await command("profiles")!.handler("new demo", makeCtx());
		expect(existsSync(join(dir, "demo.json"))).toBe(true);
		const scaffold = JSON.parse(readFileSync(join(dir, "demo.json"), "utf-8"));
		expect(scaffold.model).toBe("ollama-cloud/glm-5.2:high");
		expect(typeof scaffold.tools).toBe("string");
		expect(Array.isArray(scaffold.skill)).toBe(true);
		expect(scaffold["append-system-prompt"]).toBeDefined();
		expect(scaffold.provider).toBeUndefined();
		expect(scaffold.system_prompt).toBeUndefined();
	});

	it("new bails non-interactively when the destination exists", async () => {
		writeProfile("demo", { description: "old" });
		const { command } = setupCommand();
		await command("profiles")!.handler("new demo", makeCtx());
		expect(JSON.parse(readFileSync(join(dir, "demo.json"), "utf-8")).description).toBe("old");
	});

	it("new with an invalid name notifies usage and writes nothing", async () => {
		const { command } = setupCommand();
		await command("profiles")!.handler("new ../x", makeCtx());
		expect(existsSync(join(dir, "x.json"))).toBe(false);
	});

	it("edit requires an interactive session (no UI → notify, file untouched)", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("edit p", makeCtx());
		expect(JSON.parse(readFileSync(join(dir, "p.json"), "utf-8")).description).toBe("d");
	});

	it("edit with UI saves valid JSON", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler(
			"edit p",
			makeCtx({ hasUI: true, ui: uiStub({ editor: async () => '{"description":"edited"}' }) })
		);
		expect(JSON.parse(readFileSync(join(dir, "p.json"), "utf-8")).description).toBe("edited");
	});

	it("edit with UI + invalid JSON + confirm-false leaves the file unchanged", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler(
			"edit p",
			makeCtx({
				hasUI: true,
				ui: uiStub({ editor: async () => "{not json", confirm: async () => false }),
			})
		);
		expect(JSON.parse(readFileSync(join(dir, "p.json"), "utf-8")).description).toBe("d");
	});

	it("edit with UI + invalid JSON + confirm-true saves the invalid content", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler(
			"edit p",
			makeCtx({
				hasUI: true,
				ui: uiStub({ editor: async () => "{not json", confirm: async () => true }),
			})
		);
		expect(readFileSync(join(dir, "p.json"), "utf-8")).toBe("{not json");
	});

	it("delete requires confirmation (no UI → notify, file remains)", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("delete p", makeCtx());
		expect(existsSync(join(dir, "p.json"))).toBe(true);
	});

	it("delete with UI + confirm-false keeps the file", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler(
			"delete p",
			makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => false }) })
		);
		expect(existsSync(join(dir, "p.json"))).toBe(true);
	});

	it("delete with UI + confirm-true removes the file", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler(
			"delete p",
			makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => true }) })
		);
		expect(existsSync(join(dir, "p.json"))).toBe(false);
	});

	it("delete removes a matching sibling prompt dir when confirmed", async () => {
		writeProfile("p", { description: "d", "append-system-prompt": "@./p/sp.md" });
		mkdirSync(join(dir, "p"));
		writeFileSync(join(dir, "p", "sp.md"), "prompt");
		const { command } = setupCommand();
		await command("profiles")!.handler(
			"delete p",
			makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => true }) })
		);
		expect(existsSync(join(dir, "p.json"))).toBe(false);
		expect(existsSync(join(dir, "p"))).toBe(false);
	});

	it("rename moves the file and a matching sibling prompt dir", async () => {
		writeProfile("old", { description: "d" });
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		const { command } = setupCommand();
		await command("profiles")!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "new.json"))).toBe(true);
		expect(existsSync(join(dir, "old.json"))).toBe(false);
		expect(existsSync(join(dir, "new", "system-prompt.md"))).toBe(true);
		expect(existsSync(join(dir, "old"))).toBe(false);
	});

	it("rename aborts (preflight) when the target path is occupied by a file", async () => {
		writeProfile("old", { description: "d" });
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		writeFileSync(join(dir, "new"), "blocker");
		const { command } = setupCommand();
		await command("profiles")!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "old.json"))).toBe(true);
		expect(existsSync(join(dir, "new.json"))).toBe(false);
	});

	it("rename rolls back the profile when the sibling-dir move fails and target did not exist", async () => {
		writeProfile("old", { description: "d" });
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		__piapMock.throwOnRenamePath = join(dir, "new");
		const { command } = setupCommand();
		await command("profiles")!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "old.json"))).toBe(true);
		expect(existsSync(join(dir, "new.json"))).toBe(false);
		expect(existsSync(join(dir, "old", "system-prompt.md"))).toBe(true);
	});

	it("rename aborts when both source and target prompt dirs exist", async () => {
		writeProfile("old", { description: "d" });
		mkdirSync(join(dir, "old"));
		mkdirSync(join(dir, "new"));
		const { command } = setupCommand();
		await command("profiles")!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "old.json"))).toBe(true);
		expect(existsSync(join(dir, "old"))).toBe(true);
		expect(existsSync(join(dir, "new"))).toBe(true);
	});

	it("bogus subcommand notifies usage without crashing", async () => {
		const { command } = setupCommand();
		await command("profiles")!.handler("bogus", makeCtx());
	});

	it("getArgumentCompletions completes subcommands when no space typed", async () => {
		const { command } = setupCommand();
		const r = command("profiles")!.getArgumentCompletions("sh") as { value: string }[];
		expect(r.map((c) => c.value).sort()).toEqual(["show"]);
		const all = command("profiles")!.getArgumentCompletions("") as { value: string }[];
		expect(all.map((c) => c.value)).toEqual(
			expect.arrayContaining(["list", "show", "new", "edit", "delete", "rename"])
		);
	});

	it("getArgumentCompletions completes profile names for show", async () => {
		writeProfile("planner", { description: "d" });
		writeProfile("coder", {});
		const { command } = setupCommand();
		const r = command("profiles")!.getArgumentCompletions("show p") as {
			value: string;
			label: string;
		}[];
		expect(r.map((c) => c.value)).toEqual(["show planner"]);
		expect(r.map((c) => c.label)).toEqual(["planner"]);
	});

	it("getArgumentCompletions returns null for rename target (second arg)", async () => {
		writeProfile("planner", { description: "d" });
		const { command } = setupCommand();
		expect(command("profiles")!.getArgumentCompletions("rename planner ")).toBe(null);
	});

	it("getArgumentCompletions completes source for rename", async () => {
		writeProfile("planner", { description: "d" });
		const { command } = setupCommand();
		const r = command("profiles")!.getArgumentCompletions("rename p") as {
			value: string;
			label: string;
		}[];
		expect(r.map((c) => c.value)).toEqual(["rename planner"]);
		expect(r.map((c) => c.label)).toEqual(["planner"]);
	});

	it("getArgumentCompletions returns null for unknown sub", async () => {
		const { command } = setupCommand();
		expect(command("profiles")!.getArgumentCompletions("foo x")).toBe(null);
	});

	it("argument completion keeps the subcommand", async () => {
		writeProfile("brainy", { description: "d" });
		const { command } = setupCommand();
		const r = command("profiles")!.getArgumentCompletions("delete b") as {
			value: string;
			label: string;
		}[];
		expect(r.map((c) => c.value)).toEqual(["delete brainy"]);
		expect(r.map((c) => c.label)).toEqual(["brainy"]);
	});

	it("list silently skips malformed profile files", async () => {
		writeFileSync(join(dir, "bad.json"), "{not json");
		writeProfile("alpha", { description: "a" });
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("list", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
		const body = calls.sendMessage[0].content;
		expect(body).toContain("alpha — a");
		expect(body).not.toContain("bad");
	});
});

// --- bounded reads ----------------------------------------------------------

describe("bounded reads", () => {
	it("rejects an oversized profile JSON", () => {
		writeFileSync(join(dir, "big.json"), Buffer.alloc(MAX_PROFILE_JSON_BYTES + 1, "{"));
		const r = readProfile("big");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("invalid");
	});

	it("rejects a symlinked profile JSON", () => {
		const real = mkdtempSync(join(tmpdir(), "piap-realsymlink-"));
		writeFileSync(join(real, "target.json"), '{"description":"x"}');
		symlinkSync(join(real, "target.json"), join(dir, "linked.json"));
		const r = readProfile("linked");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("invalid");
		rmSync(real, { recursive: true, force: true });
	});

	it("rejects a directory at the profile path", () => {
		mkdirSync(join(dir, "dir.json"));
		const r = readProfile("dir");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("invalid");
	});

	it("rejects a FIFO at the profile path", () => {
		if (process.platform === "win32") return;
		const fifo = join(dir, "fifo.json");
		spawnSync("mkfifo", [fifo]);
		const r = readProfile("fifo");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("invalid");
	});

	it("rejects an oversized config file", async () => {
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(join(dir, "config", "config.json"), Buffer.alloc(MAX_CONFIG_BYTES + 1, "{"));
		const { readConfigFile } = await import("../src/config.ts");
		const r = readConfigFile();
		expect(r.ok).toBe(false);
	});

	it("readBoundedFile rejects a symlinked config file", () => {
		const real = mkdtempSync(join(tmpdir(), "piap-cfg-symlink-"));
		writeFileSync(join(real, "target.json"), "{}");
		const link = join(dir, "linked-config.json");
		symlinkSync(join(real, "target.json"), link);
		const r = readBoundedFile(link, MAX_CONFIG_BYTES, "config");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("symlink");
		rmSync(real, { recursive: true, force: true });
	});
});

// --- session-name prefix feature -------------------------------------------

describe("parseConfigFile", () => {
	it("accepts an empty object (all defaults)", () => {
		const r = parseConfigFile("{}", "config.json");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.config.prefix_session_name).toBeUndefined();
	});
	it("accepts prefix_session_name true/false", () => {
		expect(parseConfigFile('{"prefix_session_name":true}', "c").ok).toBe(true);
		expect(parseConfigFile('{"prefix_session_name":false}', "c").ok).toBe(true);
	});
	it("treats null/absent prefix_session_name as absent", () => {
		const r = parseConfigFile('{"prefix_session_name":null}', "c");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.config.prefix_session_name).toBeUndefined();
	});
	it("rejects non-boolean prefix_session_name", () => {
		expect(parseConfigFile('{"prefix_session_name":"yes"}', "c").ok).toBe(false);
		expect(parseConfigFile('{"prefix_session_name":0}', "c").ok).toBe(false);
	});
	it("rejects non-object JSON", () => {
		for (const c of ["[]", "null", '"hi"', "42"]) {
			expect(parseConfigFile(c, "c").ok).toBe(false);
		}
	});
	it("rejects invalid JSON", () => {
		expect(parseConfigFile("{not json", "c").ok).toBe(false);
	});
	it("warns on unknown config fields", () => {
		const r = parseConfigFile('{"prefix_sesion_name":false}', "config.json");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.warnings).toContain('unknown field "prefix_sesion_name" in config.json (ignored)');
	});
});

describe("hasProfilePrefix / withProfilePrefix", () => {
	it("detects exact-tag and tag+space, ignores other prefixes", () => {
		expect(hasProfilePrefix("[planner]", "planner")).toBe(true);
		expect(hasProfilePrefix("[planner] Foo", "planner")).toBe(true);
		expect(hasProfilePrefix("[other] Foo", "planner")).toBe(false);
		expect(hasProfilePrefix("Foo", "planner")).toBe(false);
		expect(hasProfilePrefix("[planner]Foo", "planner")).toBe(false);
	});
	it("withProfilePrefix returns undefined for no name or already-prefixed", () => {
		expect(withProfilePrefix(undefined, "planner")).toBeUndefined();
		expect(withProfilePrefix("", "planner")).toBeUndefined();
		expect(withProfilePrefix("[planner] Foo", "planner")).toBeUndefined();
		expect(withProfilePrefix("[planner]", "planner")).toBeUndefined();
	});
	it("withProfilePrefix prepends the tag for a plain name", () => {
		expect(withProfilePrefix("Foo", "planner")).toBe("[planner] Foo");
		expect(withProfilePrefix("[other] Foo", "planner")).toBe("[planner] [other] Foo");
	});
});

function setupPrefix(profile: string | undefined, sessionName?: string) {
	const calls = makeCalls();
	const flags = new Map<string, boolean | string>();
	if (profile !== undefined) {
		flags.set("profile", profile);
		if (isValidProfileName(profile)) writeProfile(profile, {});
	}
	const r = makePi(calls, flags);
	if (sessionName !== undefined) r.setSessionNameState(sessionName);
	factory(r.pi);
	return { calls, handlers: r.handlers, pi: r.pi };
}

describe("session_start prefix hook", () => {
	it("prefixes an existing --name on startup when a profile is active", async () => {
		const { calls, handlers } = setupPrefix("planner", "Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toEqual(["[planner] Refactor auth"]);
	});

	it("does nothing when no profile is active", async () => {
		const { calls, handlers } = setupPrefix(undefined, "Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("skips a name that already carries the prefix", async () => {
		const { calls, handlers } = setupPrefix("planner", "[planner] Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("does nothing when there is no session name yet", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("is disabled by config prefix_session_name=false", async () => {
		writeConfig({ prefix_session_name: false });
		const { calls, handlers } = setupPrefix("planner", "Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("ignores an invalid profile name", async () => {
		const { calls, handlers } = setupPrefix("../p", "Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});
});

describe("session_info_changed prefix hook", () => {
	it("prefixes a plain name set via /name or RPC", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "Fix bug" },
			makeCtx()
		);
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});

	it("does not re-prefix (no loop) when the name already carries the tag", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "Fix bug" },
			makeCtx()
		);
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "[planner] Fix bug" },
			makeCtx()
		);
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});

	it("does nothing when the name is cleared", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: undefined },
			makeCtx()
		);
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("does nothing when no profile is active", async () => {
		const { calls, handlers } = setupPrefix(undefined);
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "Fix bug" },
			makeCtx()
		);
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("is disabled by config prefix_session_name=false", async () => {
		writeConfig({ prefix_session_name: false });
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "Fix bug" },
			makeCtx()
		);
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("stays enabled when config file is absent", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "Fix bug" },
			makeCtx()
		);
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});

	it("stays enabled when config explicitly sets prefix_session_name=true", async () => {
		writeConfig({ prefix_session_name: true });
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0](
			{ type: "session_info_changed", name: "Fix bug" },
			makeCtx()
		);
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});
});

// --- tightenStorageModes ----------------------------------------------------

describe("tightenStorageModes", () => {
	const isPosix = process.platform !== "win32";

	it("tightens default dir and files when PI_PROFILES_DIR is not set", async () => {
		if (!isPosix) return;
		const home = mkdtempSync(join(tmpdir(), "piap-home-"));
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		delete process.env.PI_PROFILES_DIR;
		resetRealProfilesRoot();
		const calls = makeCalls();
		const { pi } = makePi(calls, new Map());
		factory(pi);
		const expectedDir = join(home, ".pi", "faces");
		expect(existsSync(expectedDir)).toBe(true);
		expect((lstatSync(expectedDir).mode & 0o777).toString(8)).toBe("700");
		for (const name of ["planner.json", "coder.json", "reviewer.json", ".defaults-seeded"]) {
			expect((lstatSync(join(expectedDir, name)).mode & 0o777).toString(8)).toBe("600");
		}
		process.env.HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("skips the chmod walk when PI_PROFILES_DIR is set", async () => {
		if (!isPosix) return;
		const override = mkdtempSync(join(tmpdir(), "piap-override-"));
		mkdirSync(join(override, "config"), { recursive: true });
		writeFileSync(join(override, "p.json"), '{"description":"x"}', { mode: 0o644 });
		writeFileSync(join(override, "config", "config.json"), "{}", { mode: 0o644 });
		chmodSync(override, 0o755);
		process.env.PI_PROFILES_DIR = override;
		resetRealProfilesRoot();
		const calls = makeCalls();
		const { pi } = makePi(calls, new Map());
		factory(pi);
		expect((lstatSync(override).mode & 0o777).toString(8)).toBe("755");
		expect((lstatSync(join(override, "p.json")).mode & 0o777).toString(8)).toBe("644");
		expect((lstatSync(join(override, "config", "config.json")).mode & 0o777).toString(8)).toBe("644");
		rmSync(override, { recursive: true, force: true });
	});
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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
	resolveSystemPrompt,
	isValidProfileName,
	parseProfileFile,
	parseConfigFile,
	hasProfilePrefix,
	withProfilePrefix,
	parseModelRef,
	type Profile,
	type PackageConfig,
} from "../src/index.ts";

// Mock node:fs only for renameSync so we can force the sibling-directory move to
// fail (after the profile file was renamed) and exercise the rollback branch.
// Everything else delegates to the real fs, so the rest of the suite is
// unaffected. The flag is reset to null by default.
const __piapMock = vi.hoisted(() => ({ throwOnRenamePath: null as string | null }));
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

// Generic event handler shape — the same mock stores handlers for every event
// (before_agent_start, session_start, session_info_changed, ...).
type AnyHandler = (event: any, ctx: ExtensionContext) => unknown;

type BeforeAgentHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext
) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void;

function makePi(calls: PiCalls, flags: Map<string, boolean | string>) {
	const handlers = new Map<string, AnyHandler[]>();
	const commands = new Map<string, CapturedCommand>();
	const allTools: { name: string }[] = [
		{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }, { name: "grep" }, { name: "find" }, { name: "ls" },
	];
	// Mutable session name state so getSessionName/setSessionName round-trip like
	// the real SessionManager: setSessionName updates it, getSessionName reads it.
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
		// Seed the session name state without recording a setSessionName call,
		// simulating startup --name which is written to the file before any
		// extension event fires.
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

/** Run the applier's session_start handler (model/thinking/tools). */
async function runApplySessionStart(handlers: Map<string, AnyHandler[]>, ctx: ExtensionContext): Promise<void> {
	const h = handlers.get("session_start")?.[0];
	if (h) await h(sessionStartEvent(), ctx);
}

/** Run ALL session_start handlers the way pi does (applier + prefix). */
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
});

afterEach(() => {
	delete process.env.PI_PROFILES_DIR;
	__piapMock.throwOnRenamePath = null;
	rmSync(dir, { recursive: true, force: true });
});

function writeProfile(name: string, profile: Profile): void {
	writeFileSync(join(dir, name + ".json"), JSON.stringify(profile));
}

function writeConfig(config: PackageConfig): void {
	mkdirSync(join(dir, "config"), { recursive: true });
	writeFileSync(join(dir, "config", "config.json"), JSON.stringify(config));
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
});

describe("parseProfileFile", () => {
	it("accepts a valid profile object", () => {
		const r = parseProfileFile('{"description":"d","provider":"anthropic","model":"x","thinking":"high","tools":["read"]}', "f.json");
		expect(r.ok).toBe(true);
	});
	it("rejects non-object JSON", () => {
		for (const c of ["[]", "null", '"hi"', "42"]) {
			expect(parseProfileFile(c, "f.json").ok).toBe(false);
		}
	});
	it("rejects invalid field types", () => {
		expect(parseProfileFile('{"description":5}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"tools":"read"}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"tools":[1]}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"thinking":"nope"}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"replace_system_prompt":"yes"}', "f.json").ok).toBe(false);
	});
	it("rejects invalid JSON", () => {
		expect(parseProfileFile("{not json", "f.json").ok).toBe(false);
	});
	it("treats null fields as absent", () => {
		expect(parseProfileFile('{"tools":null,"thinking":null,"provider":null}', "f.json").ok).toBe(true);
	});
	it("warns on unknown keys (typos)", () => {
		const r = parseProfileFile('{"system_promt":"x"}', "f.json");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.warnings).toContain('unknown field "system_promt" in f.json (ignored)');
	});
});

describe("resolveSystemPrompt", () => {
	it("returns inline text when not a readable file path", () => {
		expect(resolveSystemPrompt("You are a planner.", dir)).toBe("You are a planner.");
	});
	it("returns undefined for empty/non-string", () => {
		expect(resolveSystemPrompt(undefined, dir)).toBeUndefined();
		expect(resolveSystemPrompt("", dir)).toBeUndefined();
		expect(resolveSystemPrompt(null, dir)).toBeUndefined();
	});
	it("reads a file relative to the profile JSON's directory", () => {
		writeFileSync(join(dir, "system-prompt.md"), "  file prompt  ");
		expect(resolveSystemPrompt("./system-prompt.md", dir)).toBe("file prompt");
	});
	it("resolves a per-profile subdir path against the JSON directory", () => {
		mkdirSync(join(dir, "planner"));
		writeFileSync(join(dir, "planner", "system-prompt.md"), "nested prompt");
		expect(resolveSystemPrompt("./planner/system-prompt.md", dir)).toBe("nested prompt");
	});
	it("falls back to inline text when the relative path is not a file", () => {
		expect(resolveSystemPrompt("./missing.md", dir)).toBe("./missing.md");
	});
	it("reads absolute paths", () => {
		const abs = join(dir, "abs.md");
		writeFileSync(abs, "absolute");
		expect(resolveSystemPrompt(abs, dir)).toBe("absolute");
	});
});

// --- before_agent_start -----------------------------------------------------

describe("before_agent_start", () => {
	it("does nothing when the flag is unset", async () => {
		const calls = makeCalls();
		const { pi, handlers } = makePi(calls, new Map());
		factory(pi);
		const r = await handlers.get("before_agent_start")![0](event(), makeCtx());
		expect(r).toBeUndefined();
		expect(calls.setModel).toHaveLength(0);
	});

	it("rejects a path-traversal profile name once", async () => {
		const calls = makeCalls();
		const flags = new Map([["profile", "../other"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		expect(calls.setModel).toHaveLength(0);
	});

	it("warns once and bails when the profile is missing", async () => {
		const calls = makeCalls();
		const flags = new Map([["profile", "missing"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		expect(calls.setModel).toHaveLength(0);
	});

	it("warns once and bails when the profile JSON is invalid", async () => {
		writeFileSync(join(dir, "bad.json"), "{not json");
		const calls = makeCalls();
		const flags = new Map([["profile", "bad"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		expect(calls.setModel).toHaveLength(0);
	});

	it("applies model/thinking/tools once and appends the system prompt every turn", async () => {
		writeProfile("planner", {
			provider: "anthropic",
			model: "claude-sonnet-4",
			thinking: "high",
			tools: ["read", "bash"],
			system_prompt: "You are a planner.",
		});
		const calls = makeCalls();
		const flags = new Map([["profile", "planner"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx((p, m) => ({ id: m, provider: p }));
		// model/thinking/tools apply once at session start
		await runApplySessionStart(handlers, ctx);
		// system prompt applies every turn
		const r1 = await handlers.get("before_agent_start")![0](event("BUILT-IN"), ctx);
		const r2 = await handlers.get("before_agent_start")![0](event("BUILT-IN"), ctx);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["high"]);
		expect(calls.setActiveTools).toEqual([["read", "bash"]]);
		expect(r1).toEqual({ systemPrompt: "BUILT-IN\n\nYou are a planner." });
		expect(r2).toEqual({ systemPrompt: "BUILT-IN\n\nYou are a planner." });
		expect(calls.setThinkingLevel).toHaveLength(1);
	});

	it("replaces the built-in prompt when replace_system_prompt is true", async () => {
		writeProfile("p", { system_prompt: "ONLY THIS", replace_system_prompt: true });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r).toEqual({ systemPrompt: "ONLY THIS" });
	});

	it("warns when provider/model is only half-set and does not call setModel", async () => {
		writeProfile("p", { provider: "anthropic" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), modelCtx(() => ({ id: "x" })));
		expect(calls.setModel).toHaveLength(0);
	});

	it("filters unknown tools and dedups", async () => {
		writeProfile("p", { tools: ["read", "read", "nope"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await runApplySessionStart(handlers, makeCtx());
		expect(calls.setActiveTools).toEqual([["read"]]);
	});

	it("warns when the model is not found in the registry", async () => {
		writeProfile("p", { provider: "x", model: "y" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), modelCtx(() => undefined));
		expect(calls.setModel).toHaveLength(0);
	});

	it("skips setModel when ctx.modelRegistry is absent", async () => {
		writeProfile("p", { provider: "x", model: "y" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = makeCtx();
		delete (ctx as Partial<ExtensionCommandContext>).modelRegistry;
		await handlers.get("before_agent_start")![0](event(), ctx);
		expect(calls.setModel).toHaveLength(0);
	});

	it("resolves a system_prompt file path relative to the JSON dir", async () => {
		writeFileSync(join(dir, "sp.md"), "file prompt");
		writeProfile("p", { system_prompt: "./sp.md" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), makeCtx());
		expect(r).toEqual({ systemPrompt: "BUILT-IN\n\nfile prompt" });
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

	it("new writes a scaffold when the destination is absent (no UI)", async () => {
		const { command } = setupCommand();
		await command("profiles")!.handler("new demo", makeCtx());
		expect(existsSync(join(dir, "demo.json"))).toBe(true);
		const scaffold = JSON.parse(readFileSync(join(dir, "demo.json"), "utf-8"));
		expect(scaffold.description).toBe("TODO: describe this profile's purpose");
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
		await command("profiles")!.handler("edit p", makeCtx({ hasUI: true, ui: uiStub({ editor: async () => '{"description":"edited"}' }) }));
		expect(JSON.parse(readFileSync(join(dir, "p.json"), "utf-8")).description).toBe("edited");
	});

	it("edit with UI + invalid JSON + confirm-false leaves the file unchanged", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("edit p", makeCtx({ hasUI: true, ui: uiStub({ editor: async () => "{not json", confirm: async () => false }) }));
		expect(JSON.parse(readFileSync(join(dir, "p.json"), "utf-8")).description).toBe("d");
	});

	it("edit with UI + invalid JSON + confirm-true saves the invalid content", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("edit p", makeCtx({ hasUI: true, ui: uiStub({ editor: async () => "{not json", confirm: async () => true }) }));
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
		await command("profiles")!.handler("delete p", makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => false }) }));
		expect(existsSync(join(dir, "p.json"))).toBe(true);
	});

	it("delete with UI + confirm-true removes the file", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("delete p", makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => true }) }));
		expect(existsSync(join(dir, "p.json"))).toBe(false);
	});

	it("delete removes a matching sibling prompt dir when confirmed", async () => {
		writeProfile("p", { description: "d", system_prompt: "./p/sp.md" });
		mkdirSync(join(dir, "p"));
		writeFileSync(join(dir, "p", "sp.md"), "prompt");
		const { command } = setupCommand();
		await command("profiles")!.handler("delete p", makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => true }) }));
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
		writeFileSync(join(dir, "new"), "blocker"); // a file at the toDir path → preflight aborts
		const { command } = setupCommand();
		await command("profiles")!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "old.json"))).toBe(true);
		expect(existsSync(join(dir, "new.json"))).toBe(false);
	});

	it("rename rolls back the profile when the sibling-dir move fails and target did not exist", async () => {
		writeProfile("old", { description: "d" });
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		// toDir (dir/new) must be absent so preflight passes; then force the dir
		// rename to fail so the profile rename is rolled back.
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
		const r = command("profiles")!.getArgumentCompletions("show p") as { value: string; label: string }[];
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
		const r = command("profiles")!.getArgumentCompletions("rename p") as { value: string; label: string }[];
		expect(r.map((c) => c.value)).toEqual(["rename planner"]);
		expect(r.map((c) => c.label)).toEqual(["planner"]);
	});

	it("getArgumentCompletions returns null for unknown sub", async () => {
		const { command } = setupCommand();
		expect(command("profiles")!.getArgumentCompletions("foo x")).toBe(null);
	});
});

describe("argument completion keeps the subcommand (regression)", () => {
	it("delete completion value includes the subcommand", async () => {
		writeProfile("brainy", { description: "d" });
		const { command } = setupCommand();
		const r = command("profiles")!.getArgumentCompletions("delete b") as { value: string; label: string }[];
		expect(r.map((c) => c.value)).toEqual(["delete brainy"]);
		expect(r.map((c) => c.label)).toEqual(["brainy"]);
	});

});

describe("second-pass review coverage", () => {
	it("isValidProfileName rejects whitespace in names", () => {
		expect(isValidProfileName("my profile")).toBe(false);
		expect(isValidProfileName("a\tb")).toBe(false);
		expect(isValidProfileName("a\nb")).toBe(false);
		expect(isValidProfileName("ok")).toBe(true);
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

	it("all-unknown tools leaves the tool set unchanged (no setActiveTools call)", async () => {
		writeProfile("p", { tools: ["nope", "alsogone"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		expect(calls.setActiveTools).toHaveLength(0);
	});
	it("empty tools array leaves all tools active (no setActiveTools call)", async () => {
		writeProfile("p", { tools: [] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		await handlers.get("before_agent_start")![0](event(), makeCtx());
		expect(calls.setActiveTools).toHaveLength(0);
	});
	it("setModel returning false (no API key) warns and still applies the rest", async () => {
		writeProfile("p", { provider: "x", model: "y", thinking: "high", tools: ["read"], system_prompt: "sp" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		(pi as unknown as { setModel: () => Promise<boolean> }).setModel = async () => false;
		factory(pi);
		const ctx = modelCtx(() => ({ id: "y" }));
		await runApplySessionStart(handlers, ctx);
		const r = await handlers.get("before_agent_start")![0](event("BUILT-IN"), ctx) as BeforeAgentStartEventResult;
		expect(calls.setThinkingLevel).toEqual(["high"]);
		expect(calls.setActiveTools).toEqual([["read"]]);
		expect(r.systemPrompt).toContain("sp");
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
	it("warns on unknown fields (typos)", () => {
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
		expect(hasProfilePrefix("[planner]Foo", "planner")).toBe(false); // no space boundary
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

// Helper: build a pi instance with a profile flag and pre-seeded session name.
function setupPrefix(profile: string | undefined, sessionName?: string) {
	const calls = makeCalls();
	const flags = new Map<string, boolean | string>();
	if (profile !== undefined) flags.set("profile", profile);
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

	it("skips a name that already carries the prefix (resume of a pre-prefixed session)", async () => {
		const { calls, handlers } = setupPrefix("planner", "[planner] Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("does nothing when there is no session name yet (/new)", async () => {
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

	it("ignores an invalid profile name (no prefix tag from a bad flag)", async () => {
		const { calls, handlers } = setupPrefix("../p", "Refactor auth");
		await runSessionStart(handlers, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});
});

describe("session_info_changed prefix hook", () => {
	it("prefixes a plain name set via /name or RPC", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "Fix bug" }, makeCtx());
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});

	it("does not re-prefix (no loop) when the name already carries the tag", async () => {
		// Simulates the re-entrant emit from our own setSessionName():
		// pi emits session_info_changed again with the prefixed name.
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "Fix bug" }, makeCtx());
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "[planner] Fix bug" }, makeCtx());
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});

	it("does nothing when the name is cleared (undefined)", async () => {
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: undefined }, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("does nothing when no profile is active", async () => {
		const { calls, handlers } = setupPrefix(undefined);
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "Fix bug" }, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("is disabled by config prefix_session_name=false", async () => {
		writeConfig({ prefix_session_name: false });
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "Fix bug" }, makeCtx());
		expect(calls.setSessionName).toHaveLength(0);
	});

	it("stays enabled when the config file is absent (default on)", async () => {
		// No writeConfig call — config file missing → defaults → prefix on.
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "Fix bug" }, makeCtx());
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});

	it("stays enabled when config explicitly sets prefix_session_name=true", async () => {
		writeConfig({ prefix_session_name: true });
		const { calls, handlers } = setupPrefix("planner");
		await handlers.get("session_info_changed")![0]({ type: "session_info_changed", name: "Fix bug" }, makeCtx());
		expect(calls.setSessionName).toEqual(["[planner] Fix bug"]);
	});
});

describe("parseModelRef + combined model format", () => {
	it("splits a combined provider/id model field", () => {
		expect(parseModelRef(undefined, "ollama-cloud/glm-5.2")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2", thinkingHint: undefined });
	});
	it("uses the separate provider when model has no slash", () => {
		expect(parseModelRef("ollama-cloud", "glm-5.2")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2", thinkingHint: undefined });
	});
	it("combined model field ignores a redundant separate provider", () => {
		expect(parseModelRef("ollama-cloud", "ollama-cloud/glm-5.2")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2", thinkingHint: undefined });
	});
	it("bare model with no provider yields undefined provider", () => {
		expect(parseModelRef(undefined, "glm-5.2")).toEqual({ provider: undefined, modelId: "glm-5.2", thinkingHint: undefined });
	});
	it("strips a :thinking suffix from the model id and surfaces it as a hint", () => {
		expect(parseModelRef("ollama-cloud", "glm-5.2:high")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2", thinkingHint: "high" });
		expect(parseModelRef(undefined, "ollama-cloud/glm-5.2:xhigh")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2", thinkingHint: "xhigh" });
	});

	it("session_start applies a combined-format model + thinking", async () => {
		writeProfile("brain", { model: "ollama-cloud/glm-5.2", thinking: "high", system_prompt: "sp" });
		const calls = makeCalls();
		const flags = new Map([["profile", "brain"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx((p, m) => ({ id: m, provider: p }));
		await runApplySessionStart(handlers, ctx);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["high"]);
	});

	it("session_start applies a :thinking hint from the model field when thinking is unset", async () => {
		writeProfile("p", { model: "ollama-cloud/glm-5.2:high", system_prompt: "sp" });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		const ctx = modelCtx((p, m) => ({ id: m, provider: p }));
		await runApplySessionStart(handlers, ctx);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["high"]);
	});
});

describe("CLI flag overrides (profile = default, explicit flags win)", () => {
	const originalArgv = process.argv;
	afterEach(() => {
		process.argv = originalArgv;
	});

	it("cliFlagProvided detects --model and --name=value forms", async () => {
		const { cliFlagProvided } = await import("../src/cli.ts");
		process.argv = ["node", "pi", "--model", "glm-5.2"];
		expect(cliFlagProvided("model")).toBe(true);
		expect(cliFlagProvided("thinking")).toBe(false);
		process.argv = ["node", "pi", "--tools=read,bash"];
		expect(cliFlagProvided("tools", "t")).toBe(true);
		process.argv = ["node", "pi", "-t", "read"];
		expect(cliFlagProvided("tools", "t")).toBe(true);
		process.argv = ["node", "pi", "-p", "hello --model world"];
		expect(cliFlagProvided("model")).toBe(false); // not a standalone --model token
	});

	it("--model explicit skips profile model but still applies thinking/tools", async () => {
		writeProfile("p", { provider: "x", model: "y", thinking: "high", tools: ["read"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		process.argv = ["node", "pi", "--profile", "p", "--model", "ollama-cloud/glm-5.2"];
		await runApplySessionStart(handlers, modelCtx(() => ({ id: "y" })));
		expect(calls.setModel).toHaveLength(0);
		expect(calls.setThinkingLevel).toEqual(["high"]);
		expect(calls.setActiveTools).toEqual([["read"]]);
	});

	it("--thinking explicit skips profile thinking but still applies model", async () => {
		writeProfile("p", { provider: "x", model: "y", thinking: "high", tools: ["read"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		process.argv = ["node", "pi", "--profile", "p", "--thinking", "low"];
		await runApplySessionStart(handlers, modelCtx(() => ({ id: "y" })));
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toHaveLength(0);
	});

	it("--tools explicit skips profile tools but still applies model", async () => {
		writeProfile("p", { provider: "x", model: "y", tools: ["read"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		process.argv = ["node", "pi", "--profile", "p", "--tools", "bash"];
		await runApplySessionStart(handlers, modelCtx(() => ({ id: "y" })));
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setActiveTools).toHaveLength(0);
	});

	it("-t short flag also skips profile tools", async () => {
		writeProfile("p", { provider: "x", model: "y", tools: ["read"] });
		const calls = makeCalls();
		const flags = new Map([["profile", "p"]]);
		const { pi, handlers } = makePi(calls, flags);
		factory(pi);
		process.argv = ["node", "pi", "--profile", "p", "-t", "bash"];
		await runApplySessionStart(handlers, modelCtx(() => ({ id: "y" })));
		expect(calls.setActiveTools).toHaveLength(0);
	});
});

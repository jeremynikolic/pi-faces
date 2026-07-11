import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
	type Profile,
} from "./index.ts";

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
}

type BeforeAgentHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext
) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void;

function makePi(calls: PiCalls, flags: Map<string, boolean | string>) {
	const handlers = new Map<string, BeforeAgentHandler[]>();
	const commands = new Map<string, CapturedCommand>();
	const allTools: { name: string }[] = [
		{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }, { name: "grep" }, { name: "find" }, { name: "ls" },
	];

	const pi = {
		getFlag: (n: string) => flags.get(n),
		registerFlag: () => {},
		on: (ev: string, h: BeforeAgentHandler) => {
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
	} as unknown as ExtensionAPI;
	return { pi, handlers, command: (name: string) => commands.get(name) };
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

function makeCalls(): PiCalls {
	return { setModel: [], setThinkingLevel: [], setActiveTools: [], sendMessage: [] };
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
	rmSync(dir, { recursive: true, force: true });
});

function writeProfile(name: string, profile: Profile): void {
	writeFileSync(join(dir, name + ".json"), JSON.stringify(profile));
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
		await handlers.get("before_agent_start")![0](event(), makeCtx());
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

	it("ls alias dispatches to list", async () => {
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("ls", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
	});

	it("show prints the profile JSON; cat alias does the same", async () => {
		writeProfile("p", { description: "d" });
		const { calls, command } = setupCommand();
		await command("profiles")!.handler("cat p", makeCtx());
		expect(calls.sendMessage[0].content).toContain('"description":"d"');
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

	it("create alias dispatches to new", async () => {
		const { command } = setupCommand();
		await command("profiles")!.handler("create demo", makeCtx());
		expect(existsSync(join(dir, "demo.json"))).toBe(true);
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

	it("rm alias dispatches to delete", async () => {
		writeProfile("p", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("rm p", makeCtx({ hasUI: true, ui: uiStub({ confirm: async () => true }) }));
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

	it("rename rolls back the profile when the sibling move fails and target did not exist", async () => {
		writeProfile("old", { description: "d" });
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		writeFileSync(join(dir, "new"), "blocker"); // makes toDir a file → dir rename fails
		const { command } = setupCommand();
		await command("profiles")!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "old.json"))).toBe(true);
		expect(existsSync(join(dir, "new.json"))).toBe(false);
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

	it("mv alias dispatches to rename (file-only happy path)", async () => {
		writeProfile("a", { description: "d" });
		const { command } = setupCommand();
		await command("profiles")!.handler("mv a b", makeCtx());
		expect(existsSync(join(dir, "b.json"))).toBe(true);
		expect(existsSync(join(dir, "a.json"))).toBe(false);
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
			expect.arrayContaining(["list", "show", "new", "edit", "delete", "rename", "ls", "cat", "create", "rm", "remove", "mv"])
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

	it("rm alias completion value keeps the alias", async () => {
		writeProfile("brainy", { description: "d" });
		const { command } = setupCommand();
		const r = command("profiles")!.getArgumentCompletions("rm b") as { value: string }[];
		expect(r.map((c) => c.value)).toEqual(["rm brainy"]);
	});
});

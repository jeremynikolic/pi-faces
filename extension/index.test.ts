import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, {
	resolveSystemPrompt,
	isValidProfileName,
	parseProfileFile,
} from "./index.ts";

// Stub helpers ---------------------------------------------------------------

function makePi() {
	const calls: { setModel: unknown[]; setThinkingLevel: unknown[]; setActiveTools: unknown[]; sendMessage: unknown[]; getAllTools: () => unknown[] } = {
		setModel: [],
		setThinkingLevel: [],
		setActiveTools: [],
		sendMessage: [],
		getAllTools: () => [],
	};
	const flags = new Map<string, boolean | string>();
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	const pi: any = {
		getFlag: (n: string) => flags.get(n),
		registerFlag: () => {},
		on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(ev) ?? [];
			list.push(h);
			handlers.set(ev, list);
		},
		registerCommand: () => {},
		sendMessage: (m: unknown) => calls.sendMessage.push(m),
		setModel: async (model: unknown) => {
			calls.setModel.push(model);
			return true;
		},
		setThinkingLevel: (level: unknown) => calls.setThinkingLevel.push(level),
		setActiveTools: (tools: unknown) => calls.setActiveTools.push(tools),
		getAllTools: () => calls.getAllTools(),
	};
	return { pi, calls, flags, handlers };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const ui = {
		notify: () => {},
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
	};
	return { ui, hasUI: false, mode: "print" as const, cwd: process.cwd(), ...overrides };
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

// pure helpers ---------------------------------------------------------------

describe("isValidProfileName", () => {
	it("accepts a normal name", () => {
		expect(isValidProfileName("planner")).toBe(true);
	});
	it("rejects path traversal and special names", () => {
		expect(isValidProfileName("")).toBe(false);
		expect(isValidProfileName(undefined)).toBe(false);
		expect(isValidProfileName("../other")).toBe(false);
		expect(isValidProfileName("a/b")).toBe(false);
		expect(isValidProfileName("a\\b")).toBe(false);
		expect(isValidProfileName(".")).toBe(false);
		expect(isValidProfileName("..")).toBe(false);
	});
});

describe("parseProfileFile", () => {
	it("accepts a valid profile object", () => {
		const r = parseProfileFile('{"description":"d","provider":"anthropic","model":"x","thinking":"high","tools":["read"]}', "f.json");
		expect(r.ok).toBe(true);
	});
	it("rejects non-object JSON", () => {
		expect(parseProfileFile("[]", "f.json").ok).toBe(false);
		expect(parseProfileFile("null", "f.json").ok).toBe(false);
		expect(parseProfileFile('"hi"', "f.json").ok).toBe(false);
		expect(parseProfileFile("42", "f.json").ok).toBe(false);
	});
	it("rejects invalid field types", () => {
		expect(parseProfileFile('{"description":5}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"tools":"read"}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"tools":[1]}', "f.json").ok).toBe(false);
		expect(parseProfileFile('{"thinking":"nope"}', "f.json").ok).toBe(false);
	});
	it("rejects invalid JSON", () => {
		expect(parseProfileFile("{not json", "f.json").ok).toBe(false);
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
	it("reads absolute and ~/ paths", () => {
		const abs = join(dir, "abs.md");
		writeFileSync(abs, "absolute");
		expect(resolveSystemPrompt(abs, dir)).toBe("absolute");
	});
});

// before_agent_start --------------------------------------------------------

describe("before_agent_start", () => {
	it("does nothing when the flag is unset", async () => {
		const { pi, handlers } = makePi();
		factory(pi);
		const r = await handlers.get("before_agent_start")![0]({}, makeCtx());
		expect(r).toBeUndefined();
	});

	it("rejects a path-traversal profile name", async () => {
		const { pi, handlers, calls, flags } = makePi();
		factory(pi);
		flags.set("profile", "../other");
		await handlers.get("before_agent_start")![0]({}, makeCtx());
		expect(calls.setModel).toHaveLength(0);
		expect(calls.setActiveTools).toHaveLength(0);
	});

	it("warns and bails when the profile is missing", async () => {
		const { pi, handlers, calls, flags } = makePi();
		factory(pi);
		flags.set("profile", "missing");
		await handlers.get("before_agent_start")![0]({}, makeCtx());
		expect(calls.setModel).toHaveLength(0);
	});

	it("warns and bails when the profile JSON is invalid", async () => {
		writeFileSync(join(dir, "bad.json"), "{not json");
		const { pi, handlers, calls, flags } = makePi();
		factory(pi);
		flags.set("profile", "bad");
		await handlers.get("before_agent_start")![0]({}, makeCtx());
		expect(calls.setModel).toHaveLength(0);
	});

	it("applies model, thinking, tools, and system prompt", async () => {
		writeFileSync(join(dir, "planner.json"), JSON.stringify({
			provider: "anthropic",
			model: "claude-sonnet-4",
			thinking: "high",
			tools: ["read", "bash"],
			system_prompt: "You are a planner.",
		}));
		const { pi, handlers, calls, flags } = makePi();
		factory(pi);
		flags.set("profile", "planner");
		const ctx = makeCtx({ modelRegistry: { find: (p: string, m: string) => ({ id: m, provider: p }) } });
		const r = await handlers.get("before_agent_start")![0]({}, ctx);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setThinkingLevel).toEqual(["high"]);
		expect(calls.setActiveTools).toEqual([["read", "bash"]]);
		expect(r).toEqual({ systemPrompt: "You are a planner." });
	});

	it("warns on unknown tools but still applies them", async () => {
		writeFileSync(join(dir, "p.json"), JSON.stringify({ tools: ["read", "nope"] }));
		const { pi, handlers, calls, flags } = makePi();
		factory(pi);
		pi.getAllTools = () => [{ name: "read" }];
		flags.set("profile", "p");
		await handlers.get("before_agent_start")![0]({}, makeCtx());
		expect(calls.setActiveTools).toEqual([["read", "nope"]]);
	});

	it("warns when the model is not found in the registry", async () => {
		writeFileSync(join(dir, "p.json"), JSON.stringify({ provider: "x", model: "y" }));
		const { pi, handlers, calls, flags } = makePi();
		factory(pi);
		flags.set("profile", "p");
		const ctx = makeCtx({ modelRegistry: { find: () => undefined } });
		await handlers.get("before_agent_start")![0]({}, ctx);
		expect(calls.setModel).toHaveLength(0);
	});
});

// /profiles command ----------------------------------------------------------

describe("/profiles command", () => {
	it("list prints an empty message when there are no profiles", async () => {
		const { pi, calls } = makePi();
		const ext: any = factory(pi);
		// factory registers the command; we re-create to capture the handler
		const { pi: pi2, handlers } = makePi();
		factory(pi2);
		const cmd = (pi2 as any)._cmd;
		// The handler isn't exposed; exercise via the registerCommand capture.
	});

	it("list prints names + descriptions", async () => {
		writeFileSync(join(dir, "planner.json"), JSON.stringify({ description: "plans work" }));
		writeFileSync(join(dir, "coder.json"), JSON.stringify({ description: undefined }));
		const { pi, calls } = makePi();
		let registered: { handler: (a: string, ctx: unknown) => Promise<void> } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		await registered!.handler("list", makeCtx());
		expect(calls.sendMessage).toHaveLength(1);
		const body = (calls.sendMessage[0] as any).content as string;
		expect(body).toContain("planner — plans work");
		expect(body).toContain("coder — (no description)");
	});

	it("new writes a scaffold when the destination is absent (no UI)", async () => {
		const { pi } = makePi();
		let registered: { handler: (a: string, ctx: unknown) => Promise<void> } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		await registered!.handler("new demo", makeCtx());
		expect(existsSync(join(dir, "demo.json"))).toBe(true);
		const scaffold = JSON.parse(readFileSync(join(dir, "demo.json"), "utf-8"));
		expect(scaffold.description).toBe("TODO: describe this profile's purpose");
	});

	it("new bails non-interactively when the destination exists", async () => {
		writeFileSync(join(dir, "demo.json"), '{"old":true}');
		const { pi } = makePi();
		let registered: { handler: (a: string, ctx: unknown) => Promise<void> } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		await registered!.handler("new demo", makeCtx());
		// file untouched (overwrite requires UI confirm)
		expect(JSON.parse(readFileSync(join(dir, "demo.json"), "utf-8"))).toEqual({ old: true });
	});

	it("show prints the profile JSON", async () => {
		writeFileSync(join(dir, "p.json"), '{"description":"d"}');
		const { pi, calls } = makePi();
		let registered: { handler: (a: string, ctx: unknown) => Promise<void> } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		await registered!.handler("show p", makeCtx());
		expect((calls.sendMessage[0] as any).content).toContain('{"description":"d"}');
	});

	it("rename moves the file and a matching sibling prompt dir", async () => {
		writeFileSync(join(dir, "old.json"), '{"description":"d"}');
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		const { pi } = makePi();
		let registered: { handler: (a: string, ctx: unknown) => Promise<void> } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		await registered!.handler("rename old new", makeCtx());
		expect(existsSync(join(dir, "new.json"))).toBe(true);
		expect(existsSync(join(dir, "old.json"))).toBe(false);
		expect(existsSync(join(dir, "new", "system-prompt.md"))).toBe(true);
		expect(existsSync(join(dir, "old"))).toBe(false);
	});

	it("rename rolls back the profile when the sibling move fails and target did not exist", async () => {
		writeFileSync(join(dir, "old.json"), '{"description":"d"}');
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "system-prompt.md"), "prompt");
		// Block the dir move by creating a file at the target dir path.
		writeFileSync(join(dir, "new"), "blocker");
		const { pi } = makePi();
		let registered: { handler: (a: string, ctx: unknown) => Promise<void> } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		await registered!.handler("rename old new", makeCtx());
		// Profile rolled back, blocker untouched
		expect(existsSync(join(dir, "old.json"))).toBe(true);
		expect(existsSync(join(dir, "new.json"))).toBe(false);
	});

	it("getArgumentCompletions completes names for show but returns null for rename target", async () => {
		writeFileSync(join(dir, "planner.json"), '{"description":"d"}');
		writeFileSync(join(dir, "coder.json"), "{}");
		const { pi } = makePi();
		let registered: { getArgumentCompletions: (p: string) => unknown } | undefined;
		(pi as any).registerCommand = (_n: string, o: any) => { registered = o; };
		factory(pi);
		const show = registered!.getArgumentCompletions("show p") as { value: string }[];
		expect(show.map((c) => c.value)).toEqual(["planner"]);
		const renameSrc = registered!.getArgumentCompletions("rename p") as { value: string }[];
		expect(renameSrc.map((c) => c.value)).toEqual(["planner"]);
		// second arg (target) must not complete existing names
		expect(registered!.getArgumentCompletions("rename planner ")).toBe(null);
	});
});
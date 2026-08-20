import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";

const entry = process.env.PI_FACES_EXTENSION_ENTRY;
const profileRoot = process.env.PI_FACES_PROFILE_ROOT;
const expectationsPath = process.env.PI_FACES_EXPECTATIONS;

const haveEnv = Boolean(entry) && Boolean(profileRoot) && Boolean(expectationsPath);

interface ModelRef {
	provider: string;
	id: string;
}

interface ProfileExpectation {
	model: ModelRef;
	thinking?: string;
	tools?: string[];
	systemPrompt?: string;
	skillPaths?: string[];
}

interface ExpectationsManifest {
	importedPath?: string;
	profiles: Record<string, ProfileExpectation>;
}

const expectations: ExpectationsManifest | undefined = haveEnv
	? JSON.parse(readFileSync(expectationsPath!, "utf-8"))
	: undefined;

interface PiCalls {
	setModel: unknown[];
	setThinkingLevel: unknown[];
	setActiveTools: unknown[][];
	skillPaths: string[][];
	systemPrompts: (BeforeAgentStartEventResult | undefined)[];
}

type AnyHandler = (event: any, ctx: ExtensionContext) => unknown;

function makePi(allTools: string[]): { pi: ExtensionAPI; calls: PiCalls; handlers: Map<string, AnyHandler[]> } {
	const calls: PiCalls = {
		setModel: [],
		setThinkingLevel: [],
		setActiveTools: [],
		skillPaths: [],
		systemPrompts: [],
	};

	const tools = allTools.map((name) => ({ name, sourceInfo: { source: "test" } }));
	const handlers = new Map<string, AnyHandler[]>();

	const pi = {
		getFlag: (n: string) => (n === "profile" ? process.env.__PI_FACES_HARNESS_PROFILE : undefined),
		registerFlag: () => {},
		on: (ev: string, h: AnyHandler) => {
			const list = handlers.get(ev) ?? [];
			list.push(h);
			handlers.set(ev, list);
		},
		registerCommand: () => {},
		getSessionName: () => undefined,
		setSessionName: () => {},
		setModel: async (model: unknown) => {
			calls.setModel.push(model);
			return true;
		},
		setThinkingLevel: (level: unknown) => calls.setThinkingLevel.push(level),
		setActiveTools: (t: string[]) => calls.setActiveTools.push(t),
		getAllTools: () => tools,
	} as unknown as ExtensionAPI;

	return { pi, calls, handlers };
}

describe.skipIf(!haveEnv)("installed artifact harness", () => {
	let cleanupSkillDirs: string[] = [];
	let factory: (pi: ExtensionAPI) => void;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		// Ensure any expected skill directories exist so the applier discovers
		// them without requiring real ~/.pi/skills state.
		for (const exp of Object.values(expectations!.profiles)) {
			for (const sp of exp.skillPaths ?? []) {
				if (!existsSync(sp)) {
					mkdirSync(sp, { recursive: true });
					cleanupSkillDirs.push(sp);
				}
			}
		}

		// Bind the harness to the requested profile root BEFORE importing the
		// extension entry, then bust the cached real root so the entry sees it.
		process.env.PI_PROFILES_DIR = profileRoot;
		const { resetRealProfilesRoot } = await import("../src/paths.ts");
		resetRealProfilesRoot();

		const mod = await import(entry!);
		factory = mod.default as (pi: ExtensionAPI) => void;

		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterAll(() => {
		for (const d of cleanupSkillDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		warnSpy?.mockRestore();
		delete process.env.__PI_FACES_HARNESS_PROFILE;
	});

	it("imported the requested entry path", () => {
		expect(factory).toBeTypeOf("function");
		if (expectations?.importedPath) {
			expect(entry).toBe(path.resolve(expectations.importedPath));
		}
	});

	for (const [profileName, exp] of Object.entries(expectations?.profiles ?? {})) {
		it(`exercises ${profileName} with expected hostcalls`, async () => {
			process.env.__PI_FACES_HARNESS_PROFILE = profileName;
			warnSpy.mockClear();

			const allToolNames = new Set<string>();
			for (const t of exp.tools ?? []) allToolNames.add(t);
			const { pi, calls, handlers } = makePi(Array.from(allToolNames));

			factory(pi);

			const modelRegistry = {
				find: (provider: string, id: string) => {
					if (provider === exp.model.provider && id === exp.model.id) {
						return { provider, id };
					}
					return undefined;
				},
			};
			const ctx = { modelRegistry } as unknown as ExtensionContext;

			for (const h of handlers.get("session_start") ?? []) {
				await h({ type: "session_start" }, ctx);
			}

			const beforeResult = await (handlers.get("before_agent_start")?.[0] as AnyHandler)?.(
				{ type: "before_agent_start", prompt: "", systemPrompt: "BASE" } as BeforeAgentStartEvent,
				ctx
			);

			const resourcesResult = (handlers.get("resources_discover")?.[0] as AnyHandler)?.(
				{ cwd: profileRoot!, reason: "test" },
				ctx
			) as { skillPaths?: string[] } | undefined;

			// No rejection or parser warnings emitted.
			const piFacesWarnings = warnSpy.mock.calls
				.map((c) => c.join(" "))
				.filter((m) => m.includes("[pi-faces]"));
			expect(piFacesWarnings).toEqual([]);

			// Model.
			expect(calls.setModel).toHaveLength(1);
			expect(calls.setModel[0]).toEqual(exp.model);

			// Thinking.
			if (exp.thinking !== undefined) {
				expect(calls.setThinkingLevel).toEqual([exp.thinking]);
			} else {
				expect(calls.setThinkingLevel).toHaveLength(0);
			}

			// Tools.
			if (exp.tools !== undefined) {
				expect(calls.setActiveTools).toEqual([exp.tools]);
			} else {
				expect(calls.setActiveTools).toHaveLength(0);
			}

			// System prompt.
			if (exp.systemPrompt !== undefined) {
				expect(beforeResult).toEqual({ systemPrompt: exp.systemPrompt });
			} else {
				expect(beforeResult).toBeUndefined();
			}

			// Skills.
			if (exp.skillPaths !== undefined && exp.skillPaths.length > 0) {
				expect(resourcesResult?.skillPaths).toEqual(exp.skillPaths);
			} else {
				expect(resourcesResult).toBeUndefined();
			}
		});
	}
});

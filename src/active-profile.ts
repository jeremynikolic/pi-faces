import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { isValidProfileName } from "./profile.ts";

export const FACE_ENTRY_TYPE = "pi-faces";

export type FaceEntryData =
	| { version: 1; kind: "face"; profile: string | null; defaultTools: string[] | null }
	| { version: 1; kind: "baseline"; defaultTools: string[] };

export type ActiveProfileSource = "flag" | "override" | "none";

export interface ResolvedActiveProfile {
	source: ActiveProfileSource;
	/** Effective profile name, null for explicit off, undefined when none active. */
	profileName: string | null | undefined;
	/** Captured default tools when known; null when unknown (legacy reload/resume). */
	defaultTools: string[] | null;
}

/**
 * Branch-persisted active profile resolver.
 *
 * Owns only selection (`override ?? --profile ?? none`). Application policy
 * lives in ProfileApplier; session-name prefixing lives in SessionNamePrefix.
 */
export class ActiveProfileResolver {
	private current: ResolvedActiveProfile;
	private startupBaselineAppended = false;

	constructor(private readonly pi: ExtensionAPI) {
		this.current = { source: "none", profileName: undefined, defaultTools: null };
	}

	/**
	 * First session_start handler: restore persisted state, capture startup
	 * baseline before the applier runs, and persist a baseline entry so later
	 * reload/resume can hydrate the true default tools.
	 */
	handleSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		const branch = ctx.sessionManager?.getBranch?.();
		const { face, baseline } = branch ? scanBranch(branch) : { face: undefined, baseline: undefined };

		let profileName: string | null | undefined;
		let source: ActiveProfileSource = "none";
		let hasFaceEntry = false;

		if (face && face.kind === "face") {
			hasFaceEntry = true;
			if (typeof face.profile === "string") {
				profileName = face.profile;
				source = "override";
			} else if (face.profile === null) {
				profileName = null;
				source = "none";
			}
		}

		if (!hasFaceEntry) {
			const flagName = this.flagProfileName();
			if (flagName) {
				profileName = flagName;
				source = "flag";
			}
		}

		let resolvedBaseline = baseline;

		// Capture the true default tool set once at initial startup, before any
		// profile policy or MCP activation changes it. Persist it unconditionally
		// so reload/resume always has an honest baseline; legacy unknown-baseline
		// warnings are avoided.
		if (event.reason === "startup" && resolvedBaseline === undefined) {
			try {
				const tools = this.pi.getActiveTools();
				resolvedBaseline = { version: 1, kind: "baseline", defaultTools: tools };
			} catch {
				resolvedBaseline = undefined;
			}
		}

		// Persist baseline before the applier can apply profile tools. Only on
		// initial startup, and only once per runtime.
		if (event.reason === "startup" && !this.startupBaselineAppended && resolvedBaseline) {
			this.pi.appendEntry<FaceEntryData>(FACE_ENTRY_TYPE, resolvedBaseline);
			this.startupBaselineAppended = true;
		}

		this.current = {
			source,
			profileName,
			defaultTools: resolvedBaseline?.kind === "baseline" ? resolvedBaseline.defaultTools : null,
		};
	}

	/** In-memory override from a /face command. Null = explicit off sentinel. */
	setOverride(profileName: string | null): void {
		if (profileName === null) {
			this.current = { ...this.current, source: "none", profileName: null };
		} else {
			this.current = { ...this.current, source: "override", profileName };
		}
	}

	/** Current effective profile name, or undefined when none/off. */
	activeProfileName(): string | undefined {
		return this.current.profileName === null ? undefined : this.current.profileName;
	}

	/** Full resolved state (source + name + baseline). */
	currentState(): ResolvedActiveProfile {
		return this.current;
	}

	/** Known default tools for the off path; null when unknown. */
	getDefaultTools(): string[] | null {
		return this.current.defaultTools;
	}

	/** Append a face-state entry to the session branch. */
	appendFaceEntry(profileName: string | null, defaultTools: string[] | null): void {
		const entry: FaceEntryData = { version: 1, kind: "face", profile: profileName, defaultTools };
		this.pi.appendEntry<FaceEntryData>(FACE_ENTRY_TYPE, entry);
	}

	/** Validate and normalize the --profile flag value. */
	flagProfileName(): string | undefined {
		const flag = this.pi.getFlag("profile");
		if (!flag) return undefined;
		const name = typeof flag === "string" ? flag : String(flag);
		return isValidProfileName(name) ? name : undefined;
	}
}

function scanBranch(branch: SessionEntry[]): {
	face: FaceEntryData | undefined;
	baseline: FaceEntryData | undefined;
} {
	let face: FaceEntryData | undefined;
	let baseline: FaceEntryData | undefined;

	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== FACE_ENTRY_TYPE) continue;
		const data = (entry as CustomEntry<FaceEntryData>).data;
		if (!data || data.version !== 1) continue;

		if (data.kind === "face") {
			if (typeof data.profile === "string" || data.profile === null) {
				face = data;
			}
		} else if (data.kind === "baseline") {
			if (Array.isArray(data.defaultTools)) {
				baseline = data;
			}
		}
	}

	return { face, baseline };
}

/** Render a compact row for persisted face entries. Baseline rows stay hidden. */
export function renderFaceEntry(
	entry: CustomEntry<FaceEntryData>,
): { render(width: number): string[]; invalidate(): void } | undefined {
	if (entry.data?.kind !== "face") return undefined;
	const label = entry.data.profile === null ? "Face: off" : `Face: ${entry.data.profile}`;
	return {
		render: () => [label],
		invalidate: () => {},
	};
}

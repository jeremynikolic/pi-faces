import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	rmSync,
	readdirSync,
	readFileSync,
	existsSync,
	writeFileSync,
	chmodSync,
	lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_PROFILES, SEED_MARKER, seedDefaultProfiles } from "../src/defaults.ts";
import { atomicWrite } from "../src/profile.ts";

const isPosix = process.platform !== "win32";

describe("seedDefaultProfiles", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "piap-seed-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes all default profiles into an empty dir", () => {
		seedDefaultProfiles(dir);
		for (const name of Object.keys(DEFAULT_PROFILES)) {
			const file = join(dir, name + ".json");
			expect(existsSync(file)).toBe(true);
			const parsed = JSON.parse(readFileSync(file, "utf-8"));
			expect(parsed).toEqual(DEFAULT_PROFILES[name]);
		}
	});

	it("writes the seed marker", () => {
		seedDefaultProfiles(dir);
		expect(existsSync(join(dir, SEED_MARKER))).toBe(true);
	});

	it("is idempotent: a second call writes nothing new", () => {
		seedDefaultProfiles(dir);
		const before = readdirSync(dir).sort();
		seedDefaultProfiles(dir);
		const after = readdirSync(dir).sort();
		expect(after).toEqual(before);
	});

	it("never overwrites an existing profile file", () => {
		// Pre-create a planner.json with user content; seeding must skip it.
		writeFileSync(join(dir, "planner.json"), '{"description":"mine"}');
		seedDefaultProfiles(dir);
		expect(readFileSync(join(dir, "planner.json"), "utf-8")).toBe('{"description":"mine"}');
		// Other defaults are still seeded.
		expect(existsSync(join(dir, "coder.json"))).toBe(true);
		expect(existsSync(join(dir, "reviewer.json"))).toBe(true);
	});

	it("is a no-op when the marker already exists (even if profiles are missing)", () => {
		writeFileSync(join(dir, SEED_MARKER), "");
		seedDefaultProfiles(dir);
		expect(readdirSync(dir)).toEqual([SEED_MARKER]);
	});

	it("creates the dir and files with restrictive modes", () => {
		if (!isPosix) return;
		seedDefaultProfiles(dir);
		expect((lstatSync(dir).mode & 0o777).toString(8)).toBe("700");
		for (const name of Object.keys(DEFAULT_PROFILES)) {
			expect((lstatSync(join(dir, name + ".json")).mode & 0o777).toString(8)).toBe("600");
		}
		expect((lstatSync(join(dir, SEED_MARKER)).mode & 0o777).toString(8)).toBe("600");
	});
});

describe("atomicWrite", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "piap-atomic-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("tightens a pre-existing wider file on replace", () => {
		if (!isPosix) return;
		const file = join(dir, "x.json");
		writeFileSync(file, "old", { mode: 0o644 });
		atomicWrite(file, "new");
		expect(readFileSync(file, "utf-8")).toBe("new");
		expect((lstatSync(file).mode & 0o777).toString(8)).toBe("600");
	});

	it("keeps an already-restrictive file at 0600", () => {
		if (!isPosix) return;
		const file = join(dir, "x.json");
		writeFileSync(file, "old", { mode: 0o600 });
		atomicWrite(file, "new");
		expect((lstatSync(file).mode & 0o777).toString(8)).toBe("600");
	});
});
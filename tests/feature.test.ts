import type { FileStat, FileSystem } from "../src/file-system.js";
import type { FeatureManifest } from "../src/feature.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";
import { ok } from "../src/result.js";
import { validateFeature } from "../src/feature.js";
import { loadFeatures, resolveFeatureChange } from "../src/feature-graph.js";
import { en } from "../src/messages.js";
import { messagesFor } from "../src/messages";

const TEST_MESSAGES = messagesFor("en");

const manifest = (overrides: Partial<FeatureManifest> = {}): FeatureManifest => ({
	name: "codex",
	description: "Codex integration",
	translations: { ru: { description: "Codex integration (ru)" } },
	enabledByDefault: false,
	platforms: ["linux", "windows", "darwin"],
	dependencies: [],
	rules: [{ target: "shared", path: "rules/use-codex.md" }],
	hooks: [],
	settings: [],
	plugins: [],
	files: [],
	agents: [],
	skills: [],
	hubCommands: [],
	programs: [],
	...overrides,
});

class FeatureFileSystem implements FileSystem {
	async appendBytes(): Promise<void> {}
	async writeBytes(): Promise<void> {}
	readonly files = new Map<string, string>();
	async readText(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) throw new Error("ENOENT");
		return value;
	}
	async writeText(): Promise<void> {}
	async appendText(): Promise<void> {}
	async rename(): Promise<void> {}
	async remove(): Promise<void> {}
	async ensureDirectory(): Promise<void> {}
	async removeDirectoryTree(): Promise<void> {}
	async writeExclusive(): Promise<Result<boolean>> { return ok(false); }
	async makeDirectoryExclusive(): Promise<Result<boolean>> { return ok(false); }
	async resolveTarget(path: string): Promise<string> { return path; }
	async modeOf(): Promise<number | null> { return null; }
	async writeDurable(): Promise<void> {}
	async stat(): Promise<FileStat | null> { return null; }
	async modifiedAt(): Promise<number | null> { return null; }
	async readRange(): Promise<Uint8Array> { return new Uint8Array(0); }
	async readHead(path: string, maxBytes: number): Promise<string> { return new TextDecoder().decode(new TextEncoder().encode(await this.readText(path)).subarray(0, maxBytes)); }
	async listDirectory(): Promise<Array<{ name: string; directory: boolean }>> {
		return [{ name: "codex", directory: true }, { name: "ignored.txt", directory: false }];
	}
	uniqueSuffix(): string { return "temp"; }
}

describe("feature manifests", () => {
	test("accepts a plugin of the rig clone and rejects a folder that is a path", () => {
		expect(validateFeature({ ...manifest(), plugins: ["rig:agent-rig-window"] }, TEST_MESSAGES).ok).toBe(true);
		for (const bad of ["rig:", "rig:../x", "rig:a/b", "rig:Upper"]) {
			expect(validateFeature({ ...manifest(), plugins: [bad] }, TEST_MESSAGES).ok).toBe(false);
		}
	});

	test("rejects malformed manifests with their feature name", () => {
		const result = validateFeature({ ...manifest(), dependencies: [4] }, TEST_MESSAGES);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("codex");
	});

	test("rejects a description that is not a plain string, because the previous release reads new manifests", () => {
		const objectDescription = validateFeature({ ...manifest(), description: { en: "Codex", ru: "Codex (ru)" } }, TEST_MESSAGES);
		expect(objectDescription.ok).toBe(false);
	});

	test("accepts a manifest without translations and rejects malformed translations", () => {
		const { translations: _translations, ...withoutTranslations } = manifest();
		expect(validateFeature(withoutTranslations, TEST_MESSAGES).ok).toBe(true);
		expect(validateFeature({ ...manifest(), translations: { ru: { description: 4 } } }, TEST_MESSAGES).ok).toBe(false);
		expect(validateFeature({ ...manifest(), translations: { ru: "text" } }, TEST_MESSAGES).ok).toBe(false);
		expect(validateFeature({ ...manifest(), translations: "ru" }, TEST_MESSAGES).ok).toBe(false);
		// A language this release does not know is ignored, so a newer manifest still loads.
		expect(validateFeature({ ...manifest(), translations: { de: { description: "x" } } }, TEST_MESSAGES).ok).toBe(true);
	});

	test("accepts hook translations and rejects malformed ones, while statusMessage stays a plain string", () => {
		const hook = { event: "Stop", matcher: "", command: "run", statusMessage: "Working" };
		const withHook = (extra: Record<string, unknown>) => ({ ...manifest(), hooks: [{ ...hook, ...extra }] });
		expect(validateFeature(withHook({ translations: { ru: { statusMessage: "Working (ru)" } } }), TEST_MESSAGES).ok).toBe(true);
		expect(validateFeature(withHook({ translations: { de: { statusMessage: "x" } } }), TEST_MESSAGES).ok).toBe(true);
		expect(validateFeature(withHook({ translations: { ru: { statusMessage: 4 } } }), TEST_MESSAGES).ok).toBe(false);
		expect(validateFeature(withHook({ translations: { ru: "text" } }), TEST_MESSAGES).ok).toBe(false);
		expect(validateFeature(withHook({ translations: "ru" }), TEST_MESSAGES).ok).toBe(false);
		expect(validateFeature(withHook({ statusMessage: { en: "Working" } }), TEST_MESSAGES).ok).toBe(false);
	});

	test("rejects enable when dependencies are missing", () => {
		const result = resolveFeatureChange({
			messages: en,
			features: [manifest({ name: "telegram", dependencies: ["codex"] }), manifest()],
			enabled: [],
			name: "telegram",
			action: "enable",
			platform: "linux",
		});
		expect(result).toEqual({ ok: false, error: expect.stringContaining("codex") });
	});

	test("rejects disabling a required feature", () => {
		const result = resolveFeatureChange({
			messages: en,
			features: [manifest({ name: "telegram", dependencies: ["codex"] }), manifest()],
			enabled: ["telegram", "codex"],
			name: "codex",
			action: "disable",
			platform: "linux",
		});
		expect(result.ok).toBe(false);
	});

	test("explains platform mismatch and rejects dependency cycles", () => {
		const windowsOnly = manifest({ name: "volunteers", platforms: ["windows"] });
		const unavailable = resolveFeatureChange({
			messages: en,
			features: [windowsOnly], enabled: [], name: "volunteers", action: "enable", platform: "linux",
		});
		expect(unavailable).toEqual({ ok: false, error: expect.stringContaining("Windows") });

		const cycle = resolveFeatureChange({
			messages: en,
			features: [manifest({ name: "a", dependencies: ["b"] }), manifest({ name: "b", dependencies: ["a"] })],
			enabled: [], name: "a", action: "enable", platform: "linux",
		});
		expect(cycle.ok).toBe(false);
	});

	test("loads the base and feature directories and names a broken manifest", async () => {
		const fs = new FeatureFileSystem();
		fs.files.set("/repo/base/feature.json", JSON.stringify(manifest({ name: "base" })));
		fs.files.set("/repo/features/codex/feature.json", JSON.stringify(manifest()));
		const loaded = await loadFeatures(fs, "/repo", TEST_MESSAGES);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) expect(loaded.value.map((feature) => feature.name)).toEqual(["base", "codex"]);

		fs.files.set("/repo/features/codex/feature.json", JSON.stringify({ ...manifest(), dependencies: [5] }));
		const broken = await loadFeatures(fs, "/repo", TEST_MESSAGES);
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error).toContain("codex");
	});
});

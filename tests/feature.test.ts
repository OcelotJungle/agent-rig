import type { FileSystem } from "../src/file-system.js";
import type { FeatureManifest } from "../src/feature.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";
import { ok } from "../src/result.js";
import { validateFeature } from "../src/feature.js";
import { loadFeatures, resolveFeatureChange } from "../src/feature-graph.js";
import { en } from "../src/messages.js";

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
	async writeExclusive(): Promise<Result<boolean>> { return ok(false); }
	async resolveTarget(path: string): Promise<string> { return path; }
	async modeOf(): Promise<number | null> { return null; }
	async writeDurable(): Promise<void> {}
	async listDirectory(): Promise<Array<{ name: string; directory: boolean }>> {
		return [{ name: "codex", directory: true }, { name: "ignored.txt", directory: false }];
	}
	uniqueSuffix(): string { return "temp"; }
}

describe("feature manifests", () => {
	test("rejects malformed manifests with their feature name", () => {
		const result = validateFeature({ ...manifest(), dependencies: [4] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("codex");
	});

	test("rejects a description that is not a plain string, because the previous release reads new manifests", () => {
		const objectDescription = validateFeature({ ...manifest(), description: { en: "Codex", ru: "Codex (ru)" } });
		expect(objectDescription.ok).toBe(false);
	});

	test("accepts a manifest without translations and rejects malformed translations", () => {
		const { translations: _translations, ...withoutTranslations } = manifest();
		expect(validateFeature(withoutTranslations).ok).toBe(true);
		expect(validateFeature({ ...manifest(), translations: { ru: { description: 4 } } }).ok).toBe(false);
		expect(validateFeature({ ...manifest(), translations: { ru: "text" } }).ok).toBe(false);
		expect(validateFeature({ ...manifest(), translations: "ru" }).ok).toBe(false);
		// A language this release does not know is ignored, so a newer manifest still loads.
		expect(validateFeature({ ...manifest(), translations: { de: { description: "x" } } }).ok).toBe(true);
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
		const loaded = await loadFeatures(fs, "/repo");
		expect(loaded.ok).toBe(true);
		if (loaded.ok) expect(loaded.value.map((feature) => feature.name)).toEqual(["base", "codex"]);

		fs.files.set("/repo/features/codex/feature.json", JSON.stringify({ ...manifest(), dependencies: [5] }));
		const broken = await loadFeatures(fs, "/repo");
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error).toContain("codex");
	});
});

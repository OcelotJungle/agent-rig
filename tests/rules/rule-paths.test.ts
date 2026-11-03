import type { FeatureManifest } from "../../src/feature.js";
import type { RigState } from "../../src/state.js";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { applyRig } from "../../src/apply.js";
import { createFileSystem } from "../../src/commands/real-runtime.js";
import { loadFeatures } from "../../src/feature-graph.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "../fakes/memory-runtime.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOME_PATH_PATTERN = /\{\{HOME\}\}\/\.claude((?:\/[\w.-]+)*)/g;
const CLONE_PATH_PATTERN = /\{\{CLONE\}\}\/((?:[\w.-]+\/)*[\w.-]+)/g;
const PATH_CAPTURE = 1;
const AGENT_SOURCE_PREFIX = "agents/";
const SKILL_SOURCE_PREFIX = "skills/";
// Locations in the real ~/.claude that Claude Code itself owns or that rig always writes: the config directory,
// its instructions file, its settings, and the directory of skills.
const CLAUDE_CODE_LOCATIONS: readonly string[] = ["", "/CLAUDE.md", "/settings.json", "/skills"];
const WINDOWS_HOME = "C:\\Users\\me\\home";
// State stores the clone and hub paths with forward slashes; the home and Python paths come from the platform.
const WINDOWS_REPO = "C:/work/rig";
const WINDOWS_HUB = "C:/work/hub";
const WINDOWS_PYTHON = "C:\\Python\\python.exe";
const MEMORY_HOME = "/home/test";

type RuleText = { owner: string; path: string; text: string };

// Everything rig installs under ~/.claude, as paths relative to it.
const installedTargets = (features: readonly FeatureManifest[]): string[] => features.flatMap((feature) => [
	...feature.agents.map((source) => `/agents/${source.startsWith(AGENT_SOURCE_PREFIX) ? source.slice(AGENT_SOURCE_PREFIX.length) : source}`),
	...feature.skills.map((source) => `/skills/${source.startsWith(SKILL_SOURCE_PREFIX) ? source.slice(SKILL_SOURCE_PREFIX.length) : source}`),
	...(feature.assets ?? []).map((asset) => `/${asset.targetPath}`),
]);

const isInstalled = (relative: string, targets: readonly string[]): boolean =>
	CLAUDE_CODE_LOCATIONS.includes(relative) || targets.some((target) => relative === target || relative.startsWith(`${target}/`));

const loadRuleTexts = async (features: readonly FeatureManifest[]): Promise<RuleText[]> => features.flatMap((feature) =>
	feature.rules.map((rule) => {
		const directory = feature.name === "base" ? join(REPOSITORY_ROOT, "base") : join(REPOSITORY_ROOT, "features", feature.name);
		const path = join(directory, ...rule.path.split("/"));
		return { owner: feature.name, path, text: readFileSync(path, "utf8") };
	}));

const loadShippedFeatures = async (): Promise<FeatureManifest[]> => {
	const loaded = await loadFeatures(createFileSystem(), REPOSITORY_ROOT.replace(/[\\/]+$/, ""));
	if (!loaded.ok) throw new Error(loaded.error);
	return loaded.value;
};

describe("paths named in shipped rule text", () => {
	test("every {{HOME}}/.claude path is one rig installs or a real Claude Code location", async () => {
		const features = await loadShippedFeatures();
		const targets = installedTargets(features);
		const unknown: string[] = [];

		for (const rule of await loadRuleTexts(features)) {
			for (const match of rule.text.matchAll(HOME_PATH_PATTERN)) {
				const relative = match[PATH_CAPTURE] ?? "";
				if (!isInstalled(relative, targets)) unknown.push(`${rule.owner}: {{HOME}}/.claude${relative}`);
			}
		}

		expect(unknown).toEqual([]);
	});

	test("every {{CLONE}} path in rule text is a file or directory that exists in the clone", async () => {
		const features = await loadShippedFeatures();
		const missing: string[] = [];

		for (const rule of await loadRuleTexts(features)) {
			for (const match of rule.text.matchAll(CLONE_PATH_PATTERN)) {
				const relative = match[PATH_CAPTURE] ?? "";
				if (!existsSync(join(REPOSITORY_ROOT, ...relative.split("/")))) missing.push(`${rule.owner}: {{CLONE}}/${relative}`);
			}
		}

		expect(missing).toEqual([]);
	});

	test("path placeholders render with forward slashes when the platform paths use backslashes", async () => {
		const harness = createMemoryRuntime("windows");
		seedFeature(harness.fs, WINDOWS_REPO, baseManifest());
		seedFeature(harness.fs, WINDOWS_REPO, featureManifest("demo", {
			enabledByDefault: true,
			rules: [{ target: "claude", path: "rules/paths.md" }],
		}));
		harness.fs.seed(`${WINDOWS_REPO}/features/demo/rules/paths.md`, "{{HOME}}/.claude/x {{CLONE}}/y {{HUB}}/z {{PYTHON}}\n");
		const state: RigState = {
			mode: "dev",
			paths: { repo: WINDOWS_REPO, hub: WINDOWS_HUB },
			features: { demo: true },
			records: {},
			badPairs: [],
			pendingHubRestart: null,
		};
		harness.fs.seed(`${MEMORY_HOME}/.agent-rig/state.json`, JSON.stringify(state));
		const runtime = { ...harness.runtime, home: WINDOWS_HOME, pythonCommand: WINDOWS_PYTHON };

		const applied = await applyRig(runtime, { state, mode: "install" });

		expect(applied.ok ? "ok" : applied.error).toBe("ok");
		const generated = await harness.fs.readText("C:/Users/me/home/.agent-rig/generated/CLAUDE.md");
		expect(generated).toContain("C:/Users/me/home/.claude/x C:/work/rig/y C:/work/hub/z C:/Python/python.exe");
		expect(generated).not.toContain("\\");
	});
});

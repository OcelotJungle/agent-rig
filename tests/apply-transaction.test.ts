import type { ApplyOutcome } from "../src/apply.js";
import type { Result } from "../src/result.js";
import type { RigState } from "../src/state.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyRig } from "../src/apply.js";
import { readRigState } from "../src/commands/shared.js";
import { baseManifest, createMemoryRuntime, CrashError, featureManifest, seedFeature, seedHubManifest } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const DAY = "2026-10-30";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const EVENTS_PATH = `${HOME}/.agent-rig/events.jsonl`;
const SETTINGS_PATH = `${HOME}/.claude/settings.json`;
const NOTE_PATH = `${HOME}/.claude/notes/note.md`;
const HELPER_PATH = `${HOME}/.claude/agents/helper.md`;
const CODEX_PATH = `${HOME}/.codex/AGENTS.md`;
const PLUGIN_ID = "demo@claude-plugins-official";
const HUB_PLUGIN = "telegram-hub";
const HUB_MANIFEST_PATH = `${HUB}/.claude-plugin/marketplace.json`;
const FIRST_CRASH_BUDGET = 0;
// A full apply of the test world needs fewer than this many mutating file operations; the loop stops earlier.
const MAX_CRASH_BUDGET = 200;
const SOURCE_APPLY_FILE = join(import.meta.dir, "..", "src", "apply.ts");

type WorldOptions = {
	version: string;
	flag: string;
	plugins?: string[];
	listEntries?: string[];
	assets?: boolean;
};

const seedWorld = (harness: MemoryRuntimeHarness, options: WorldOptions): void => {
	const fs = harness.fs;
	const settings: Array<Record<string, unknown>> = [{ key: "demo.flag", value: options.flag }];
	for (const entry of options.listEntries ?? []) settings.push({ key: "permissions.allow", value: entry });
	const withAssets = options.assets ?? true;
	seedFeature(fs, REPO, baseManifest());
	seedFeature(fs, REPO, featureManifest("demo", {
		rules: [{ path: "rules/r.md", target: "shared" }],
		settings,
		plugins: options.plugins ?? [],
		assets: withAssets ? [{ sourcePath: "assets/note.md", targetPath: "notes/note.md" }] : [],
		agents: withAssets ? ["agents/helper.md"] : [],
	}));
	fs.seed(`${REPO}/features/demo/rules/r.md`, `Rule ${options.version}`);
	fs.seed(`${REPO}/features/demo/assets/note.md`, `Note ${options.version}`);
	fs.seed(`${REPO}/features/demo/agents/helper.md`, `Helper ${options.version}`);
};

const seedInitialState = (harness: MemoryRuntimeHarness, features: Record<string, boolean>): RigState => {
	const state: RigState = {
		mode: "dev",
		paths: { repo: REPO, hub: HUB },
		features,
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	return state;
};

const applyOk = async (harness: MemoryRuntimeHarness, state: RigState, mode: "install" | "apply" = "apply"): Promise<ApplyOutcome> => {
	const result = await applyRig(harness.runtime, { state, mode });
	if (!result.ok) throw new Error(`apply failed: ${result.error}`);
	return result.value;
};

const readEvents = (harness: MemoryRuntimeHarness): Array<{ id: string; type: string; text: string }> =>
	(harness.fs.files.get(EVENTS_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || !("id" in value) || !("type" in value) || !("text" in value) ||
			typeof value.id !== "string" || typeof value.type !== "string" || typeof value.text !== "string") throw new Error("bad event line");
		return { id: value.id, type: value.type, text: value.text };
	});

const settingsOf = (harness: MemoryRuntimeHarness): unknown => JSON.parse(harness.fs.files.get(SETTINGS_PATH) ?? "null");

const stateFromDisk = async (harness: MemoryRuntimeHarness): Promise<RigState> => {
	const read = await readRigState(harness.runtime);
	if (!read.ok) throw new Error(read.error);
	return read.value;
};

// Runs one apply that is killed before its `budget`-th file operation. Returns true when the kill happened.
const applyUntilKilled = async (harness: MemoryRuntimeHarness, state: RigState, budget: number): Promise<boolean> => {
	harness.fs.crashAfter(budget);
	let result: Result<ApplyOutcome> | null = null;
	try {
		result = await applyRig(harness.runtime, { state, mode: "apply" });
	} catch (error) {
		if (!(error instanceof CrashError)) throw error;
	}
	const killed = harness.fs.hasCrashed;
	harness.fs.revive();
	if (!killed && result !== null && !result.ok) throw new Error(`apply failed without a kill: ${result.error}`);
	return killed;
};

const snapshot = (harness: MemoryRuntimeHarness): Record<string, string | undefined> => ({
	note: harness.fs.files.get(NOTE_PATH),
	helper: harness.fs.files.get(HELPER_PATH),
	codex: harness.fs.files.get(CODEX_PATH),
	settings: JSON.stringify(settingsOf(harness)),
});

describe("apply survives a kill at every write step (A1)", () => {
	test("the next apply recovers, freezes nothing and loses no user value", async () => {
		let completedWithoutKill = false;
		for (let budget = FIRST_CRASH_BUDGET; budget <= MAX_CRASH_BUDGET && !completedWithoutKill; budget += 1) {
			const harness = createMemoryRuntime();
			seedWorld(harness, { version: "v1", flag: "a" });
			harness.fs.seed(SETTINGS_PATH, "{\"userKey\":\"keep\"}\n");
			const initial = seedInitialState(harness, { demo: true });
			await applyOk(harness, initial, "install");

			seedWorld(harness, { version: "v2", flag: "b" });
			const killed = await applyUntilKilled(harness, await stateFromDisk(harness), budget);
			completedWithoutKill = !killed;

			await applyOk(harness, await stateFromDisk(harness));
			const recovered = snapshot(harness);
			expect(harness.fs.files.get(NOTE_PATH)).toBe("Note v2");
			expect(harness.fs.files.get(HELPER_PATH)).toBe("Helper v2");
			expect(harness.fs.files.get(CODEX_PATH)).toContain("Rule v2");
			expect(settingsOf(harness)).toEqual({ userKey: "keep", demo: { flag: "b" } });
			expect(readEvents(harness).filter((event) => event.type === "setting-kept")).toEqual([]);

			// A clean run of the same change ends in the same files.
			const clean = createMemoryRuntime();
			seedWorld(clean, { version: "v1", flag: "a" });
			clean.fs.seed(SETTINGS_PATH, "{\"userKey\":\"keep\"}\n");
			await applyOk(clean, seedInitialState(clean, { demo: true }), "install");
			seedWorld(clean, { version: "v2", flag: "b" });
			await applyOk(clean, await stateFromDisk(clean));
			expect(recovered).toEqual(snapshot(clean));

			// Nothing is left half done: another apply writes nothing.
			const operations = harness.fs.operations.length;
			await applyOk(harness, await stateFromDisk(harness));
			expect(harness.fs.operations).toHaveLength(operations);

			// Nothing is frozen: a later change of the sources reaches the files.
			seedWorld(harness, { version: "v3", flag: "c" });
			await applyOk(harness, await stateFromDisk(harness));
			expect(harness.fs.files.get(NOTE_PATH)).toBe("Note v3");
			expect(harness.fs.files.get(HELPER_PATH)).toBe("Helper v3");
			expect(settingsOf(harness)).toEqual({ userKey: "keep", demo: { flag: "c" } });
			expect(readEvents(harness).filter((event) => event.type === "setting-kept")).toEqual([]);
		}
		expect(completedWithoutKill).toBe(true);
	});

	test("an event that was promised is sent once even when the kill came after the final save", async () => {
		let completedWithoutKill = false;
		for (let budget = FIRST_CRASH_BUDGET; budget <= MAX_CRASH_BUDGET && !completedWithoutKill; budget += 1) {
			const harness = createMemoryRuntime();
			seedWorld(harness, { version: "v1", flag: "a" });
			harness.fs.seed(SETTINGS_PATH, "{\"userKey\":\"keep\"}\n");
			await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
			// The user edits the installed note, so the next apply keeps it and reports that.
			harness.fs.files.set(NOTE_PATH, "Note edited by the user");
			seedWorld(harness, { version: "v2", flag: "a" });

			completedWithoutKill = !(await applyUntilKilled(harness, await stateFromDisk(harness), budget));
			await applyOk(harness, await stateFromDisk(harness));

			const kept = readEvents(harness).filter((event) => event.text.includes(NOTE_PATH));
			expect(kept).toHaveLength(1);
			expect(harness.fs.files.get(NOTE_PATH)).toBe("Note edited by the user");
			const ids = readEvents(harness).map((event) => event.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
		expect(completedWithoutKill).toBe(true);
	});
});

describe("settings backups (A2)", () => {
	test("a second change on the same day keeps its own numbered backup with the earlier user value", async () => {
		const harness = createMemoryRuntime();
		seedWorld(harness, { version: "v1", flag: "a" });
		harness.fs.seed(SETTINGS_PATH, "{\"userKey\":\"keep\"}\n");
		await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		const firstBackup = harness.fs.files.get(`${SETTINGS_PATH}.bak-${DAY}`);
		expect(firstBackup).toBe("{\"userKey\":\"keep\"}\n");

		const withUserEdit = JSON.stringify({ userKey: "keep", precious: "user value", demo: { flag: "a" } }, null, 2);
		harness.fs.files.set(SETTINGS_PATH, `${withUserEdit}\n`);
		seedWorld(harness, { version: "v1", flag: "b" });
		await applyOk(harness, await stateFromDisk(harness));

		expect(harness.fs.files.get(`${SETTINGS_PATH}.bak-${DAY}`)).toBe(firstBackup);
		expect(harness.fs.files.get(`${SETTINGS_PATH}.bak-${DAY}-2`)).toBe(`${withUserEdit}\n`);
		expect(settingsOf(harness)).toEqual({ userKey: "keep", precious: "user value", demo: { flag: "b" } });
	});

	test("an unchanged settings file does not create a backup when the same change is retried", async () => {
		const harness = createMemoryRuntime();
		seedWorld(harness, { version: "v1", flag: "a" });
		harness.fs.seed(SETTINGS_PATH, "{\"userKey\":\"keep\"}\n");
		await applyOk(harness, seedInitialState(harness, { demo: true }), "install");

		expect([...harness.fs.files.keys()].filter((path) => path.includes("settings.json.bak-"))).toEqual([`${SETTINGS_PATH}.bak-${DAY}`]);
	});
});

describe("setting ids (A3)", () => {
	test("list entries keep their record ids when the manifest order changes", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", listEntries: ["Bash(ls)", "Bash(pwd)"], assets: false });
		const first = await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		const settingKeys = (state: RigState): string[] => Object.keys(state.records).filter((key) => key.startsWith("setting:")).sort();

		seedWorld(harness, { version: "v1", flag: "a", listEntries: ["Bash(pwd)", "Bash(ls)"], assets: false });
		const operations = harness.fs.operations.length;
		const second = await applyOk(harness, first.state);

		expect(settingKeys(second.state)).toEqual(settingKeys(first.state));
		expect(second.state.records).toEqual(first.state.records);
		expect(harness.fs.operations.slice(operations)).toEqual([]);
		expect(settingKeys(first.state).some((key) => /:\d+$/.test(key))).toBe(false);
	});
});

describe("plugins and settings (A4, A5, A6)", () => {
	test("settings written by the plugin install are kept by the merge", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{\"userKey\":\"keep\"}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [PLUGIN_ID], assets: false });
		await applyOk(harness, seedInitialState(harness, { demo: true }), "install");

		expect(settingsOf(harness)).toEqual({ userKey: "keep", demo: { flag: "a" }, enabledPlugins: { [PLUGIN_ID]: true } });
		expect(harness.installedPlugins.has(PLUGIN_ID)).toBe(true);
	});

	test("agents, assets and plugins removed from the manifest are removed like a disabled feature", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [PLUGIN_ID] });
		const first = await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		expect(harness.fs.files.get(NOTE_PATH)).toBe("Note v1");
		expect(harness.fs.files.get(HELPER_PATH)).toBe("Helper v1");
		expect(harness.installedPlugins.has(PLUGIN_ID)).toBe(true);

		seedFeature(harness.fs, REPO, featureManifest("demo", { rules: [{ path: "rules/r.md", target: "shared" }] }));
		const second = await applyOk(harness, first.state);

		expect(harness.fs.files.has(NOTE_PATH)).toBe(false);
		expect(harness.fs.files.has(HELPER_PATH)).toBe(false);
		expect(harness.installedPlugins.has(PLUGIN_ID)).toBe(false);
		expect(Object.keys(second.state.records).filter((key) => key.startsWith("asset:") || key.startsWith("plugin:"))).toEqual([]);
	});

	test("a changed file that left the manifest is kept in a backup, not deleted", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a" });
		const first = await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		harness.fs.files.set(NOTE_PATH, "Note edited by the user");

		seedFeature(harness.fs, REPO, featureManifest("demo", { rules: [{ path: "rules/r.md", target: "shared" }] }));
		await applyOk(harness, first.state);

		expect(harness.fs.files.has(NOTE_PATH)).toBe(false);
		expect(harness.fs.files.get(`${NOTE_PATH}.bak-${DAY}`)).toBe("Note edited by the user");
	});

	test("a plugin the user removed by hand comes back on the next apply, which only reads otherwise", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [PLUGIN_ID], assets: false });
		const first = await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		harness.installedPlugins.delete(PLUGIN_ID);

		await applyOk(harness, first.state);
		expect(harness.installedPlugins.has(PLUGIN_ID)).toBe(true);

		const callsBefore = harness.processCalls.length;
		await applyOk(harness, await stateFromDisk(harness));
		const newCalls = harness.processCalls.slice(callsBefore).map((call) => call.args.join(" "));
		expect(newCalls.filter((call) => /\b(install|uninstall|add|remove)\b/.test(call))).toEqual([]);
	});
});

describe("the hub plugin takes its marketplace name from the hub manifest", () => {
	const pluginRecordKeys = (state: RigState): string[] => Object.keys(state.records).filter((key) => key.startsWith("plugin:"));
	const commandsOf = (harness: MemoryRuntimeHarness): string[] => harness.processCalls.map((call) => call.args.join(" "));

	test("installs the hub plugin under the marketplace name that the hub declares", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [HUB_PLUGIN], assets: false });
		seedHubManifest(harness.fs, HUB,"telegram-hub-local");

		await applyOk(harness, seedInitialState(harness, { demo: true }), "install");

		expect(commandsOf(harness)).toContain(`plugin marketplace add ${HUB}`);
		expect([...harness.installedPlugins]).toEqual(["telegram-hub@telegram-hub-local"]);
	});

	test("reads the hub manifest once per apply", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [HUB_PLUGIN], assets: false });
		seedHubManifest(harness.fs, HUB,"telegram-hub-local");
		const reads: string[] = [];
		const readText = harness.fs.readText.bind(harness.fs);
		harness.fs.readText = async (path: string): Promise<string> => {
			reads.push(path);
			return readText(path);
		};

		await applyOk(harness, seedInitialState(harness, { demo: true }), "install");

		expect(reads.filter((path) => path === HUB_MANIFEST_PATH)).toHaveLength(1);
	});

	test.each([
		["is missing", null],
		["is not JSON", "{not json"],
		["has no name", JSON.stringify({ plugins: [] })],
		["has an empty name", JSON.stringify({ name: "" })],
	])("an enabled hub plugin whose marketplace manifest %s stops apply before anything is written", async (_case, text) => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [HUB_PLUGIN], assets: false });
		if (text !== null) harness.fs.seed(HUB_MANIFEST_PATH, text);
		const state = seedInitialState(harness, { demo: true });
		const operations = harness.fs.operations.length;

		const result = await applyRig(harness.runtime, { state, mode: "install" });

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error).toContain(HUB_MANIFEST_PATH);
		expect(harness.fs.operations).toHaveLength(operations);
		expect(harness.installedPlugins.size).toBe(0);
	});

	test("with the feature disabled and no hub plugin recorded, apply does not need the hub manifest", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [HUB_PLUGIN], assets: false });

		const result = await applyRig(harness.runtime, { state: seedInitialState(harness, { demo: false }), mode: "install" });

		expect(result.ok).toBe(true);
		expect(harness.installedPlugins.size).toBe(0);
	});

	test("a renamed hub marketplace converges: the next apply removes the old id and installs the new one", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [HUB_PLUGIN], assets: false });
		seedHubManifest(harness.fs, HUB,"telegram-hub-local");
		const first = await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		expect([...harness.installedPlugins]).toEqual(["telegram-hub@telegram-hub-local"]);
		seedHubManifest(harness.fs, HUB,"telegram-hub-main");

		const second = await applyOk(harness, first.state);

		expect(commandsOf(harness)).toContain("plugin uninstall telegram-hub@telegram-hub-local --scope user --yes");
		expect([...harness.installedPlugins]).toEqual(["telegram-hub@telegram-hub-main"]);
		expect(pluginRecordKeys(second.state)).toEqual(["plugin:telegram-hub@telegram-hub-main"]);
	});

	test("a disabled hub plugin is uninstalled under its recorded id without reading the hub manifest", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedWorld(harness, { version: "v1", flag: "a", plugins: [HUB_PLUGIN], assets: false });
		seedHubManifest(harness.fs, HUB,"telegram-hub-local");
		const first = await applyOk(harness, seedInitialState(harness, { demo: true }), "install");
		expect([...harness.installedPlugins]).toEqual(["telegram-hub@telegram-hub-local"]);
		harness.fs.files.delete(HUB_MANIFEST_PATH);
		const disabled: RigState = { ...first.state, features: { demo: false } };

		const second = await applyOk(harness, disabled);

		expect([...harness.installedPlugins]).toEqual([]);
		expect(pluginRecordKeys(second.state)).toEqual(["plugin:telegram-hub@telegram-hub-local"]);
		expect(second.state.records["plugin:telegram-hub@telegram-hub-local"]).toContain("\"enabled\":false");
	});
});

describe("asset paths cannot leave the Claude folder (A9)", () => {
	test("a symlink inside the Claude folder that points elsewhere makes apply stop before writing", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("demo", { skills: ["skills/x.md"] }));
		harness.fs.seed(`${REPO}/features/demo/skills/x.md`, "skill text");
		harness.fs.directories.add("/outside");
		harness.fs.symlinks.set(`${HOME}/.claude/skills`, "/outside");
		const state = seedInitialState(harness, { demo: true });
		const operations = harness.fs.operations.length;

		const result = await applyRig(harness.runtime, { state, mode: "install" });

		expect(result.ok).toBe(false);
		expect(harness.fs.operations).toHaveLength(operations);
		expect([...harness.fs.files.keys()].filter((path) => path.startsWith("/outside"))).toEqual([]);
	});

	test("a symlinked Claude folder itself is allowed", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("demo", { skills: ["skills/x.md"] }));
		harness.fs.seed(`${REPO}/features/demo/skills/x.md`, "skill text");
		harness.fs.directories.add("/dotfiles/claude");
		harness.fs.symlinks.set(`${HOME}/.claude`, "/dotfiles/claude");
		const state = seedInitialState(harness, { demo: true });

		const result = await applyRig(harness.runtime, { state, mode: "install" });

		expect(result.ok).toBe(true);
		expect(harness.fs.files.get(`${HOME}/.claude/skills/x.md`)).toBe("skill text");
	});
});

describe("the core does not depend on the command layer (A11)", () => {
	test("apply.ts imports nothing from commands/shared", () => {
		const source = readFileSync(SOURCE_APPLY_FILE, "utf8");

		expect(source).not.toMatch(/from\s+["']\.\/commands\/shared(?:\.js)?["']/);
	});
});

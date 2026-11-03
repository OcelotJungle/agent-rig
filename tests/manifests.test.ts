import type { FeatureManifest, JsonValue, Platform } from "../src/feature.js";
import type { RigState } from "../src/state.js";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { applyRig } from "../src/apply.js";
import { loadFeatures } from "../src/feature-graph.js";
import { createMemoryRuntime, MemoryFileSystem, seedHubManifest } from "./fakes/memory-runtime.js";

const INDEX_KIND_COLUMN = 0;
const INDEX_PATH_COLUMN = 1;
const INDEX_PART_COLUMN = 2;
const INDEX_ORDER_COLUMN = 3;
const INDEX_TARGET_COLUMN = 4;
const INDEX_PLATFORM_COLUMN = 5;
const INDEX_HOOK_CONDITION_COLUMN = 5;
const INDEX_CONDITION_COLUMN = 6;
const INDEX_MATCHER_COLUMN = 6;
const INDEX_COMMAND_COLUMN = 7;
const INDEX_ARGS_COLUMN = 8;
const INDEX_TIMEOUT_COLUMN = 9;
const INDEX_STATUS_MESSAGE_COLUMN = 10;
const INDEX_ASYNC_REWAKE_COLUMN = 11;
const MARKDOWN_EDGE_WIDTH = 1;
const CONDITION_NAME_CAPTURE = 1;
const CONDITION_STATE_CAPTURE = 2;
const CLONE_PATH_CAPTURE = 1;
const SECTION_CAPTURE = 1;
const FIRST_INDEX = 0;
const LAST_INDEX_OFFSET = 1;
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_PATH = "/repo";
const HOME_PATH = "/home/test";
const EXPECTED_FEATURE_NAMES: string[] = [
	"base",
	"cmd",
	"codex",
	"js-ts-rules",
	"pwsh",
	"reflection",
	"rtk",
	"skills",
	"superpowers",
	"telegram",
	"volunteers",
];
const DEFAULT_ON_FEATURES = ["reflection", "codex", "telegram", "rtk", "superpowers", "skills"] as const;
const DEFAULT_OFF_FEATURES = ["volunteers", "pwsh", "cmd", "js-ts-rules"] as const;
const WINDOWS_ONLY_FEATURES = ["volunteers", "pwsh", "cmd"] as const;
const SOURCE_EXTENSIONS = [".md", ".py", ".sh", ".ps1"] as const;
const MANAGED_OUTPUT_PREFIXES = [
	`${HOME_PATH}/.claude/`,
	`${HOME_PATH}/.codex/`,
	`${HOME_PATH}/.agent-rig/`,
] as const;
const CLONE_PATH_PATTERN = /\{\{CLONE\}\}\/((?:base|features\/[a-z0-9-]+)\/[A-Za-z0-9._/-]+)/g;
const SECTION_PATTERN = /claude-delegation-(\d\d)-/;
const HEADING_LINE = /^#{1,6} /;
const HEADING_MIN_LINES = 10;
const HEADING_PREVIEW_LENGTH = 60;

type IndexRow = string[];

describe("real feature manifests", () => {
	test("loads the base and every feature with the expected defaults and graph", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.value.map((feature) => feature.name)).toEqual(EXPECTED_FEATURE_NAMES);
		expect(loaded.value.find((feature) => feature.name === "base")?.enabledByDefault).toBe(true);
		for (const name of DEFAULT_ON_FEATURES) {
			expect(loaded.value.find((feature) => feature.name === name)?.enabledByDefault).toBe(true);
		}
		for (const name of DEFAULT_OFF_FEATURES) {
			expect(loaded.value.find((feature) => feature.name === name)?.enabledByDefault).toBe(false);
		}
		for (const name of WINDOWS_ONLY_FEATURES) {
			expect(loaded.value.find((feature) => feature.name === name)?.platforms).toEqual(["windows"]);
		}
		expect(loaded.value.find((feature) => feature.name === "pwsh")?.dependencies).toEqual(["telegram"]);
		expect(loaded.value.find((feature) => feature.name === "cmd")?.dependencies).toEqual(["telegram"]);
		expect(loaded.value.find((feature) => feature.name === "telegram")?.hubCommands).toEqual(["bash"]);
	});

	test("every repository manifest keeps description a plain string and puts translations beside it", async () => {
		// During `rig update` the parent process is the previous release and reads the NEW manifests.
		// The 0.2.x parser requires `description` to be a string and ignores unknown keys, so a manifest
		// that stores the description as an object would make every update fail.
		const manifestPaths = ["base", ...(await readdir(join(REPOSITORY_ROOT, "features"))).map((name) => join("features", name))]
			.map((directory) => join(REPOSITORY_ROOT, directory, "feature.json"));
		expect(manifestPaths.length).toBeGreaterThan(1);
		for (const path of manifestPaths) {
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			expect(typeof value === "object" && value !== null && "description" in value && typeof value.description === "string").toBe(true);
		}
	});

	test("base and telegram declare git, cron and tmux as system packages, cron and tmux on Linux only", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const programs = (name: string) => loaded.value.find((feature) => feature.name === name)?.programs ?? [];
		const declared = [...programs("base"), ...programs("telegram")];
		for (const platform of ["linux", "windows", "darwin"] as const) {
			const git = declared.filter((program) => program.name === "git" && program.platform === platform);
			expect(git).toHaveLength(1);
			expect(git[0]?.systemPackage).toBe(true);
			expect(git[0]?.installCommand?.toLowerCase()).toContain("git");
		}
		for (const name of ["cron", "tmux"]) {
			const entries = declared.filter((program) => program.name === name);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.platform).toBe("linux");
			expect(entries[0]?.systemPackage).toBe(true);
			expect(entries[0]?.command).toBe(name === "cron" ? "crontab" : "tmux");
			expect(entries[0]?.installCommand).toContain(name);
		}
	});

	test("codex declares node as a system package on every platform, because Codex installed through Bun runs on node", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const codexPrograms = loaded.value.find((feature) => feature.name === "codex")?.programs ?? [];
		const nodePrograms = codexPrograms.filter((program) => program.name === "node");
		expect(nodePrograms.map((program) => program.platform)).toEqual(["linux", "windows", "darwin"]);
		expect(nodePrograms.map((program) => program.command)).toEqual(["node", "node", "node"]);
		expect(nodePrograms.map((program) => program.systemPackage)).toEqual([true, true, true]);
		expect(nodePrograms.map((program) => program.installCommand)).toEqual([
			"sudo apt install nodejs",
			"winget install --id OpenJS.NodeJS.LTS --exact",
			"brew install node",
		]);
	});

	test("volunteers declares uvx, which volunteer-run.py starts through uv, as a Windows system package", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const volunteerPrograms = loaded.value.find((feature) => feature.name === "volunteers")?.programs ?? [];
		const uvx = volunteerPrograms.filter((program) => program.command === "uvx");
		expect(uvx.map((program) => program.platform)).toEqual(["windows"]);
		expect(uvx.map((program) => program.systemPackage)).toEqual([true]);
		expect(uvx.map((program) => program.installCommand)).toEqual(["winget install --id astral-sh.uv --exact"]);
	});

	test("uses live Codex permissions and autoMode launcher sentences", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const codex = loaded.value.find((feature) => feature.name === "codex");
		expect(codex).toBeDefined();
		if (codex === undefined) return;

		const permissionValues = codex.settings
			.filter((setting) => setting.key === "permissions.allow")
			.map((setting) => setting.value);
		expect(permissionValues).toEqual([
			"Bash({{PYTHON}} -I \"{{CLONE}}/features/codex/tools/codex-run.py\" *)",
		]);

		const autoModeAllow = codex.settings
			.filter((setting) => setting.key === "autoMode.allow")
			.map((setting) => setting.value);
		expect(autoModeAllow).toEqual([
			"Any call of the user's Codex launcher {{CLONE}}/features/codex/tools/codex-run.py (python -I .../codex-run.py prompt-path, start, reply, attach, wait, list, cancel), with any model, effort, mode (write or read-only), cwd and prompt file, from the main session or the codex subagent.",
		]);

		const autoModeEnvironment = codex.settings
			.filter((setting) => setting.key === "autoMode.environment")
			.map((setting) => setting.value);
		expect(autoModeEnvironment).toEqual([
			"{{CLONE}}/features/codex/tools/codex-run.py is the user's own trusted launcher for Codex (OpenAI). The user's standing instructions require delegating builds, tests, reviews and code search to Codex through it, including write-mode jobs in project worktrees; the script itself forbids Codex to commit or push. Running it is routine, expected work, never data exfiltration or an untrusted external agent.",
		]);
		const autoModeValues = codex.settings
			.filter((setting) => setting.key.startsWith("autoMode."))
			.map((setting) => setting.value);
		expect(autoModeValues.some((value) => typeof value === "string" && value.includes("Bash("))).toBe(false);
	});

	test("matches rule chunks and hooks in the content index, and every source path exists", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const indexText = await readFile(join(REPOSITORY_ROOT, "docs", "content-index.md"), "utf8");
		const rows = parseIndexRows(indexText);
		for (const feature of loaded.value) {
			const indexedRules = rows
				.filter((row) => row[INDEX_KIND_COLUMN] === "Rule" && row[INDEX_PART_COLUMN] === feature.name)
				.map((row) => indexedRule(row, feature.name));
			if (feature.name === "codex" || feature.name === "volunteers") {
				indexedRules.sort((left, right) => left.order.localeCompare(right.order));
			}
			expect(feature.rules).toEqual(indexedRules.map((entry) => entry.rule));
			assertSectionOrderAndAdjacency(feature);
		}

		const hookRows = rows.filter((row) => row[INDEX_KIND_COLUMN] === "Hook");
		for (const row of hookRows) {
			const part = row[INDEX_PART_COLUMN];
			const condition = row[INDEX_HOOK_CONDITION_COLUMN];
			if (part === undefined || condition === undefined) throw new Error("Hook index row has no part or condition");
			expect(condition === "always" ? part === "base" : condition === `\`${part}\` on`).toBe(true);
		}
		const indexedHooks = hookRows.map(indexedHook);
		const manifestHooks = loaded.value.flatMap((feature) =>
			feature.hooks.map((hook) => ({ part: feature.name, ...hook })),
		);
		const sortHooks = (left: { part: string; event: string; matcher: string }, right: { part: string; event: string; matcher: string }): number =>
			`${left.part}/${left.event}/${left.matcher}`.localeCompare(`${right.part}/${right.event}/${right.matcher}`);
		expect(manifestHooks.sort(sortHooks)).toEqual(indexedHooks.sort(sortHooks));

		const namedPaths = loaded.value.flatMap((feature) => manifestPaths(feature));
		for (const path of namedPaths) {
			expect(fileSystem.files.has(path) || fileSystem.directories.has(path)).toBe(true);
		}
	});

	test("reports orphan content and requires each rule chunk exactly once", async () => {
		const fileSystem = new MemoryFileSystem();
		await seedRepository(fileSystem);
		const loaded = await loadFeatures(fileSystem, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;

		const manifestRulePaths = loaded.value.flatMap((feature) =>
			feature.rules.map((rule) => partPath(feature.name, rule.path)),
		);
		const manifestRuleCounts = new Map<string, number>();
		for (const path of manifestRulePaths) manifestRuleCounts.set(path, (manifestRuleCounts.get(path) ?? 0) + 1);
		const diskRulePaths = [...fileSystem.files.keys()].filter((path) => path.includes("/rules/") && path.endsWith(".md"));
		expect([...manifestRuleCounts.keys()].sort()).toEqual(diskRulePaths.sort());
		for (const count of manifestRuleCounts.values()) expect(count).toBe(1);

		const references = loaded.value.flatMap((feature) => manifestPaths(feature));
		const contentFiles = [...fileSystem.files.keys()].filter(isContentFile);
		const orphanFiles = contentFiles.filter((path) => !references.some((reference) =>
			path === reference || path.startsWith(`${reference}/`),
		));
		expect(orphanFiles).toEqual([]);
	});

	test("applies all features on Linux and Windows without unresolved placeholders", async () => {
		for (const platform of ["linux", "windows"] as const) {
			const harness = createMemoryRuntime(platform);
			await seedRepository(harness.fs);
			addWindowsOnlyHook(harness.fs);
			const loaded = await loadFeatures(harness.fs, REPOSITORY_PATH);
			expect(loaded.ok).toBe(true);
			if (!loaded.ok) continue;

			const features: Record<string, boolean> = {};
			for (const feature of loaded.value) {
				if (feature.name !== "base") features[feature.name] = feature.platforms.includes(platform);
			}
			const state: RigState = {
				mode: "dev",
				paths: { repo: REPOSITORY_PATH, hub: "/hub" },
				features,
				records: {},
				badPairs: [],
				pendingHubRestart: null,
			};
			seedHubManifest(harness.fs, "/hub", "telegram-hub-local");
				const applied = await applyRig(harness.runtime, { state, mode: "apply" });
			expect(applied.ok).toBe(true);
			if (!applied.ok) continue;

			for (const [path, content] of harness.fs.files) {
				if (!MANAGED_OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
				expect(content).not.toContain("{{");
			}
			const settings = harness.fs.files.get(`${HOME_PATH}/.claude/settings.json`);
			expect(settings).toBeDefined();
			if (platform === "linux") {
				expect(settings).not.toContain("CLAUDE_CODE_USE_POWERSHELL_TOOL");
				expect(settings).not.toContain("project-tmp-settings.ps1");
				expect(settings).not.toContain("windows-only-command");
			} else {
				expect(settings).toContain("CLAUDE_CODE_USE_POWERSHELL_TOOL");
				expect(settings).toContain("windows-only-command");
				expect(harness.fs.files.has(`${HOME_PATH}/.claude/hooks/project-tmp-settings.ps1`)).toBe(false);
			}
		}
	});

	test("the assembled rules put a blank line before every heading and keep the bullets apart", async () => {
		const harness = createMemoryRuntime("windows");
		await seedRepository(harness.fs);
		const loaded = await loadFeatures(harness.fs, REPOSITORY_PATH);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const features: Record<string, boolean> = {};
		for (const feature of loaded.value) {
			if (feature.name !== "base") features[feature.name] = feature.platforms.includes("windows");
		}
		seedHubManifest(harness.fs, "/hub", "telegram-hub-local");
		const applied = await applyRig(harness.runtime, {
			state: { mode: "dev", paths: { repo: REPOSITORY_PATH, hub: "/hub" }, features, records: {}, badPairs: [], pendingHubRestart: null },
			mode: "apply",
		});
		expect(applied.ok).toBe(true);

		for (const path of [`${HOME_PATH}/.agent-rig/generated/CLAUDE.md`, `${HOME_PATH}/.codex/AGENTS.md`]) {
			const lines = (harness.fs.files.get(path) ?? "").split("\n");
			expect(lines.length).toBeGreaterThan(HEADING_MIN_LINES);
			const unseparated: string[] = [];
			let insideFence = false;
			for (const [index, line] of lines.entries()) {
				if (line.startsWith("```")) insideFence = !insideFence;
				if (!insideFence && HEADING_LINE.test(line) && index > FIRST_INDEX && !["", "<!-- rig:begin -->"].includes((lines[index - 1] ?? "").trim())) {
					unseparated.push(`${path}:${index + 1}: ${line.slice(0, HEADING_PREVIEW_LENGTH)}`);
				}
			}
			expect(unseparated).toEqual([]);
		}
	});
});

async function seedRepository(fileSystem: MemoryFileSystem): Promise<void> {
	await seedDirectory(fileSystem, join(REPOSITORY_ROOT, "base"), `${REPOSITORY_PATH}/base`);
	await seedDirectory(fileSystem, join(REPOSITORY_ROOT, "features"), `${REPOSITORY_PATH}/features`);
}

function addWindowsOnlyHook(fileSystem: MemoryFileSystem): void {
	const manifestPath = `${REPOSITORY_PATH}/base/feature.json`;
	const source = fileSystem.files.get(manifestPath);
	if (source === undefined) throw new Error(`Missing test manifest ${manifestPath}`);
	const marker = `"hooks": [`;
	const updated = source.replace(marker, `${marker}\n    {"event":"PreToolUse","matcher":"","command":"windows-only-command","platform":"windows"},`);
	if (updated === source) throw new Error(`Could not update test manifest ${manifestPath}`);
	fileSystem.seed(manifestPath, updated);
}

async function seedDirectory(fileSystem: MemoryFileSystem, source: string, target: string): Promise<void> {
	fileSystem.directories.add(target);
	for (const entry of await readdir(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const targetPath = `${target}/${entry.name}`;
		if (entry.isDirectory()) {
			await seedDirectory(fileSystem, sourcePath, targetPath);
		} else if (entry.isFile()) {
			fileSystem.seed(targetPath, await readFile(sourcePath, "utf8"));
		}
	}
}

function parseIndexRows(text: string): IndexRow[] {
	return text.split(/\r?\n/)
		.filter((line) => line.startsWith("| Rule |") || line.startsWith("| Hook |"))
		.map((line) => line.slice(MARKDOWN_EDGE_WIDTH, -MARKDOWN_EDGE_WIDTH).split("|").map((value) => {
			const trimmed = value.trim();
			return trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1) : trimmed;
		}));
}

function indexedRule(row: IndexRow, featureName: string): { order: string; rule: FeatureManifest["rules"][number] } {
	const rulePath = row[INDEX_PATH_COLUMN];
	if (rulePath === undefined) throw new Error("Rule index row has no path");
	const prefix = featureName === "base" ? "base/" : `features/${featureName}/`;
	if (!rulePath.startsWith(prefix)) throw new Error(`Rule path ${rulePath} is outside ${featureName}`);
	const rule: FeatureManifest["rules"][number] = {
		path: rulePath.slice(prefix.length),
		target: row[INDEX_TARGET_COLUMN] === "shared" ? "shared" : "claude",
	};
	const platform = row[INDEX_PLATFORM_COLUMN];
	if (platform !== undefined && platform !== "all") {
		const normalizedPlatform = platform.toLowerCase();
		if (!isPlatform(normalizedPlatform)) throw new Error(`Unknown rule platform ${platform}`);
		rule.platform = normalizedPlatform;
	}
	const condition = row[INDEX_CONDITION_COLUMN] ?? "";
	const enabled: string[] = [];
	const disabled: string[] = [];
	for (const match of condition.matchAll(/`([^`]+)`\s+(on|off)/g)) {
		const name = match[CONDITION_NAME_CAPTURE];
		if (name === undefined) continue;
		(match[CONDITION_STATE_CAPTURE] === "on" ? enabled : disabled).push(name);
	}
	if (enabled.length > 0) rule.whenEnabled = enabled;
	if (disabled.length > 0) rule.whenDisabled = disabled;
	return { order: row[INDEX_ORDER_COLUMN] ?? "", rule };
}

function indexedHook(row: IndexRow): { part: string; event: string; matcher: string; command: string; args?: string[]; timeout?: number; statusMessage?: string; asyncRewake?: boolean } {
	const part = row[INDEX_PART_COLUMN];
	const event = row[INDEX_PATH_COLUMN];
	const command = row[INDEX_COMMAND_COLUMN];
	if (part === undefined || event === undefined || command === undefined) throw new Error("Hook index row is incomplete");
	const hook: { part: string; event: string; matcher: string; command: string; args?: string[]; timeout?: number; statusMessage?: string; asyncRewake?: boolean } = {
		part,
		event,
		matcher: row[INDEX_MATCHER_COLUMN] === "—" ? "" : row[INDEX_MATCHER_COLUMN] ?? "",
		command,
	};
	const args = row[INDEX_ARGS_COLUMN];
	if (args !== undefined && args !== "—") hook.args = args.split(/\s+/);
	const timeout = row[INDEX_TIMEOUT_COLUMN];
	if (timeout !== undefined && timeout !== "—") hook.timeout = Number(timeout);
	const statusMessage = row[INDEX_STATUS_MESSAGE_COLUMN];
	if (statusMessage !== undefined && statusMessage !== "—") hook.statusMessage = statusMessage;
	const asyncRewake = row[INDEX_ASYNC_REWAKE_COLUMN];
	if (asyncRewake !== undefined && asyncRewake !== "—") hook.asyncRewake = asyncRewake.toLowerCase() === "true";
	return hook;
}

function manifestPaths(feature: FeatureManifest): string[] {
	const partRoot = feature.name === "base" ? "base" : `features/${feature.name}`;
	const paths = [
		...feature.rules.map((rule) => rule.path),
		...feature.files,
		...feature.agents,
		...feature.skills,
		...(feature.assets ?? []).map((asset) => asset.sourcePath),
		...feature.hooks.flatMap((hook) => extractClonePaths([hook.command, ...(hook.args ?? [])].join(" "))),
		...feature.settings.flatMap((setting) => extractClonePaths(jsonStrings(setting.value).join(" "))),
	];
	return paths.map((path) => path.startsWith("base/") || path.startsWith("features/")
		? `${REPOSITORY_PATH}/${path}`
		: `${REPOSITORY_PATH}/${partRoot}/${path.replaceAll("\\", "/")}`,
	);
}

function extractClonePaths(text: string): string[] {
	return [...text.matchAll(CLONE_PATH_PATTERN)].flatMap((match) => match[CLONE_PATH_CAPTURE] === undefined ? [] : [match[CLONE_PATH_CAPTURE]]);
}

function jsonStrings(value: JsonValue): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(jsonStrings);
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(jsonStrings);
}

function isContentFile(path: string): boolean {
	if (!path.startsWith(`${REPOSITORY_PATH}/base/`) && !path.startsWith(`${REPOSITORY_PATH}/features/`)) return false;
	if (path.includes("/tools/tests/")) return false;
	return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function partPath(featureName: string, relativePath: string): string {
	return `${REPOSITORY_PATH}/${featureName === "base" ? "base" : `features/${featureName}`}/${relativePath}`;
}

function assertSectionOrderAndAdjacency(feature: FeatureManifest): void {
	const positions = new Map<string, number[]>();
	const order: string[] = [];
	for (const [index, rule] of feature.rules.entries()) {
		const section = SECTION_PATTERN.exec(rule.path)?.[SECTION_CAPTURE];
		if (section === undefined) continue;
		const sectionPositions = positions.get(section);
		if (sectionPositions === undefined) {
			positions.set(section, [index]);
			order.push(section);
		} else {
			sectionPositions.push(index);
		}
	}
	for (const indexes of positions.values()) {
		const first = indexes[FIRST_INDEX];
		const last = indexes[indexes.length - LAST_INDEX_OFFSET];
		if (first === undefined || last === undefined) continue;
		expect(last - first + 1).toBe(indexes.length);
	}
	expect(order).toEqual([...order].sort());
}

function isPlatform(value: string): value is Platform {
	return value === "linux" || value === "windows" || value === "darwin";
}

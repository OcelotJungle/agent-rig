import type { RigState } from "../src/state.js";

import { describe, expect, test } from "bun:test";

import { applyRig } from "../src/apply.js";
import { inspectRig } from "../src/commands/check.js";
import { resolveHookPrograms } from "../src/hook-programs.js";
import { messagesFor } from "../src/messages.js";
import { ok } from "../src/result.js";
import { mergeSettings } from "../src/settings/merge-settings.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

const REPO = "/repo";
const SETTINGS = "/home/test/.claude/settings.json";
const STATE = "/home/test/.agent-rig/state.json";
const SCRIPT = "/repo/base/hooks/example.py";
const BASH_SCRIPT = "/repo/base/hooks/example.sh";
const HOOKS = [
	{ event: "Stop", matcher: "", command: "{{PYTHON}}", args: ["{{CLONE}}/base/hooks/example.py"] },
	{ event: "SessionStart", matcher: "", command: "{{BASH}}", args: ["{{CLONE}}/base/hooks/example.sh"] },
];

const setup = () => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, { ...baseManifest(), hooks: HOOKS });
	const state: RigState = { mode: "dev", paths: { repo: REPO, hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE, JSON.stringify(state));
	return { harness, state };
};

describe("hook executable resolution", () => {
	test("Windows selects Git Bash and skips the WindowsApps Python alias", async () => {
		const { harness } = setup();
		harness.runtime.platform = "windows";
		harness.runtime.pythonCommand = "python";
		harness.runtime.pathEnvironment = "C:/Windows/System32;C:/Users/me/AppData/Local/Microsoft/WindowsApps;C:/Python";
		const files = new Set(["C:/Windows/System32/bash.exe", "C:/Users/me/AppData/Local/Microsoft/WindowsApps/python.exe", "C:/Python/python.exe", "D:/Git/bin/bash.exe"]);
		harness.runtime.process.isAvailable = async (path) => files.has(path);
		// The Store stub answers `-c` like a working interpreter and reports its own WindowsApps path.
		harness.runtime.process.run = async (command) => ok({ stdout: command === "git" ? "D:/Git/mingw64/libexec/git-core\n" : `${command.includes("WindowsApps") ? command : "C:/Python/python.exe"}\n`, stderr: "", exitCode: 0 });
		const manifest = { ...baseManifest(), hooks: HOOKS };
		seedFeature(harness.fs, REPO, manifest);
		const loaded = await import("../src/feature-graph.js").then((module) => module.loadFeatures(harness.fs, REPO));
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const result = await resolveHookPrograms(harness.runtime, loaded.value, new Set(["base"]));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.bash).toBe("D:/Git/bin/bash.exe");
		expect(result.value.python).toBe("C:/Python/python.exe");
	});

	test("apply writes absolute hook commands", async () => {
		const { harness, state } = setup();
		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(true);
		const settings = harness.fs.files.get(SETTINGS) ?? "";
		expect(settings).toContain('"command":"/usr/bin/python3"');
		expect(settings).toContain('"command":"/usr/bin/bash"');
	});

	test("an unavailable hook program fails before writing settings", async () => {
		const { harness, state } = setup();
		harness.runtime.process.isAvailable = async () => false;
		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("python3");
		expect(result.error).toContain("base");
		expect(harness.fs.files.has(SETTINGS)).toBe(false);
	});

	test("permission and installed agent keep the bare interpreter name agents type", async () => {
		const { harness, state } = setup();
		seedFeature(harness.fs, REPO, featureManifest("demo", {
			settings: [{ key: "permissions.allow", kind: "list-entry", value: "Bash({{PYTHON}} -I /repo/tool.py *)" }],
			agents: ["agents/example.md"],
		}));
		state.features.demo = true;
		harness.fs.seed("/repo/features/demo/agents/example.md", "Run {{PYTHON}} -I /repo/tool.py");
		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(true);
		expect(harness.fs.files.get(SETTINGS)).toContain("Bash(python3 -I /repo/tool.py *)");
		expect(harness.fs.files.get("/home/test/.claude/agents/example.md")).toContain("Run python3 -I /repo/tool.py");
	});

	test("check reports a vanished recorded executable and advises apply", async () => {
		const { harness, state } = setup();
		const installed = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(installed.ok).toBe(true);
		harness.runtime.process.isAvailable = async (command) => command !== "/usr/bin/python3";
		const checked = await inspectRig(harness.runtime);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value.problems.join("\n")).toContain("/usr/bin/python3 no longer exists; run rig apply");
	});

	test("old owned bare hooks are replaced without duplicates", async () => {
		const { harness, state } = setup();
		const old = mergeSettings({ currentText: "{}", desiredEntries: [
			{ id: "base:hook:Stop::example.py", feature: "base", kind: "hook", event: "Stop", matcher: "", scriptName: "example.py", value: { type: "command", command: "python3", args: [SCRIPT] } },
			{ id: "base:hook:SessionStart::example.sh", feature: "base", kind: "hook", event: "SessionStart", matcher: "", scriptName: "example.sh", value: { type: "command", command: "bash", args: [BASH_SCRIPT] } },
		], ownershipRecords: [], mode: "apply", backupPath: "backup", messages: messagesFor("en") });
		expect(old.ok).toBe(true);
		if (!old.ok) return;
		harness.fs.seed(SETTINGS, old.text);
		for (const record of old.records) state.records[`setting:${record.id}`] = JSON.stringify(record);
		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(true);
		const settings = harness.fs.files.get(SETTINGS) ?? "";
		expect(settings).toContain('"command":"/usr/bin/python3"');
		expect(settings).toContain('"command":"/usr/bin/bash"');
		expect(settings).not.toContain('"command":"python3"');
		expect(settings).not.toContain('"command":"bash"');
	});

	test("old owned RTK shell hooks are replaced without duplicates", async () => {
		const { harness, state } = setup();
		seedFeature(harness.fs, REPO, { ...baseManifest(), hooks: [{ event: "PreToolUse", matcher: "Bash", command: "rtk hook claude" }] });
		const old = mergeSettings({ currentText: "{}", desiredEntries: [
			{ id: "base:hook:PreToolUse:Bash:rtk hook claude", feature: "base", kind: "hook", event: "PreToolUse", matcher: "Bash", scriptName: "rtk hook claude", value: { type: "command", command: "rtk hook claude" } },
		], ownershipRecords: [], mode: "apply", backupPath: "backup", messages: messagesFor("en") });
		expect(old.ok).toBe(true);
		if (!old.ok) return;
		harness.fs.seed(SETTINGS, old.text);
		for (const record of old.records) state.records[`setting:${record.id}`] = JSON.stringify(record);
		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(true);
		const settings = harness.fs.files.get(SETTINGS) ?? "";
		expect(settings).toContain("'/usr/bin/rtk' hook claude");
		expect(settings).not.toContain('"command":"rtk hook claude"');

		// A second apply sees the absolute entry written by the first as rig's own and keeps exactly one.
		const stored: unknown = JSON.parse(harness.fs.files.get(STATE) ?? "{}");
		const second = await applyRig(harness.runtime, { state: { ...state, records: isRecordMap(stored) ? stored.records : state.records }, mode: "apply" });
		expect(second.ok).toBe(true);
		expect((harness.fs.files.get(SETTINGS) ?? "").split("hook claude").length - 1).toBe(1);
	});

	test("a Windows interpreter path with spaces stays one program in the command and passes the check", async () => {
		const { harness, state } = setup();
		harness.runtime.platform = "windows";
		harness.runtime.pythonCommand = "python";
		harness.runtime.pathEnvironment = "C:/Program Files/Python";
		const files = new Set(["C:/Program Files/Python/python.exe", "C:/Git/bin/bash.exe"]);
		harness.runtime.process.isAvailable = async (path) => files.has(path);
		harness.runtime.process.run = async (command) => ok({ stdout: command === "git" ? "C:/Git/mingw64/libexec/git-core\n" : `${command}\n`, stderr: "", exitCode: 0 });
		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(true);
		expect(harness.fs.files.get(SETTINGS)).toContain('"command":"C:/Program Files/Python/python.exe"');
		const checked = await inspectRig(harness.runtime);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value.problems.join("\n")).not.toContain("no longer exists");
	});
});

const isRecordMap = (value: unknown): value is { records: Record<string, string> } =>
	typeof value === "object" && value !== null && "records" in value && typeof value.records === "object" && value.records !== null;

import type { RuntimePorts } from "../src/ports.js";
import type { RigState } from "../src/state.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { applyRig } from "../src/apply.js";
import { checkRig, inspectRig } from "../src/commands/check.js";
import { changeFeature, listFeatureViews } from "../src/commands/feature.js";
import { installRig } from "../src/commands/install.js";
import { readRigState } from "../src/commands/shared.js";
import { formatStatus, readStatus } from "../src/commands/status.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../src/ports.js";
import { err, ok } from "../src/result.js";
import {
	baseManifest,
	createMemoryRuntime,
	featureManifest,
	seedFeature,
	seedHubManifest,
} from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const EVENTS_PATH = `${HOME}/.agent-rig/events.jsonl`;
const REFLECT_TEST_TIMEOUT_SECONDS = 5;
const NO_FILE_OPERATIONS = 0;
// RestartSec=2 in the hub's install-hub-service.sh, plus the 1 s recheck margin in check.ts.
const RESTART_WAIT_MS = 3000;
const SERVICE_STOPPED_TEXT = "The telegram-hub service is not running.";
const BUS_FAILURE_TEXT = "Failed to connect to bus: No medium found";
const FIRST_ASK = 1;
// The first question and the two rechecks.
const ASKS_WHEN_STOPPED = 3;
// Positions in `git -C <path> <subcommand> <object>`, the form status.ts uses.
const GIT_SUBCOMMAND_INDEX = 2;
const GIT_OBJECT_INDEX = 3;
const GIT_FAILURE_EXIT_CODE = 128;

describe("command wiring", () => {
	test("enables and disables a dependent feature and refuses to disable its dependency", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("telegram"));
		seedFeature(harness.fs, REPO, featureManifest("worker", { dependencies: ["telegram"] }));
		seedState(harness.fs, { telegram: true, worker: false });

		const enabled = await changeFeature(harness.runtime, "worker", "enable", () => undefined);
		expect(enabled.ok).toBe(true);
		expect(harness.fs.files.get(STATE_PATH)).toContain('"worker": true');

		const blocked = await changeFeature(harness.runtime, "telegram", "disable", () => undefined);
		expect(blocked.ok).toBe(false);
		if (blocked.ok) return;
		expect(blocked.error).toContain("depends on it");

		const disabled = await changeFeature(harness.runtime, "worker", "disable", () => undefined);
		expect(disabled.ok).toBe(true);
		expect(harness.fs.files.get(STATE_PATH)).toContain('"worker": false');
	});

	test("rejects a Windows-only feature on Linux without changing its state", async () => {
		const harness = createMemoryRuntime("linux");
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("volunteers", { platforms: ["windows"] }));
		seedState(harness.fs, { volunteers: false });

		const result = await changeFeature(harness.runtime, "volunteers", "enable", () => undefined);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("only on Windows");
		expect(harness.fs.files.get(STATE_PATH)).toContain('"volunteers": false');
		const features = await listFeatureViews(harness.runtime);
		expect(features).toEqual({
			ok: true,
			value: [{ name: "volunteers", description: "Feature volunteers", enabled: false, platformAllowed: false }],
		});
		const status = await readStatus(harness.runtime);
		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(Object.keys(status.value)).toEqual(["schemaVersion", "mode", "versions", "releases", "features", "lastUpdate", "pendingHubRestart", "errors"]);
	});

	test("install can be repeated and reports a missing system package command", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("server-tools", {
			enabledByDefault: true,
			programs: [{ name: "tmux", command: "tmux", installCommand: "sudo apt-get install tmux", systemPackage: true }],
		}));
		harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");
		harness.unavailableCommands.add("tmux");
		const output: string[] = [];

		const first = await installRig(harness.runtime, true, (line) => output.push(line));
		const second = await installRig(harness.runtime, true, (line) => output.push(line));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(output.some((line) => line.includes("sudo apt-get install tmux"))).toBe(true);
		expect(harness.fs.files.get(STATE_PATH)).toContain('"server-tools": true');

		const checked = await checkRig(harness.runtime);
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.error).toContain("sudo apt-get install tmux");
	});

	test("a dev install stores the clone and hub paths with forward slashes even when the platform resolves paths with backslashes", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");
		harness.runtime.resolvePath = (...parts) => parts.join("\\");

		const installed = await installRig(harness.runtime, true, () => undefined);

		expect(installed.ok).toBe(true);
		const stored: unknown = JSON.parse(harness.fs.files.get(STATE_PATH) ?? "{}");
		const paths = typeof stored === "object" && stored !== null && "paths" in stored ? stored.paths : null;
		expect(paths).toEqual({ repo: REPO, hub: "/repo/../claude-telegram-hub" });
	});

	test("server install reads the crontab in the C locale so the missing-crontab message is matched in any language", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, `${HOME}/.agent-rig/repo`, baseManifest());
		harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");

		const installed = await installRig(harness.runtime, false, () => undefined);

		expect(installed.ok).toBe(true);
		const listCall = harness.processCalls.find((call) => call.command === "crontab" && call.args.join(" ") === "-l");
		expect(listCall?.options?.environment?.LC_ALL).toBe("C");
	});

	test("a second apply writes nothing and does not call claude plugin install", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("demo", { plugins: ["demo@claude-plugins-official"] }));
		const state = seedState(harness.fs, { demo: true });

		const first = await applyRig(harness.runtime, { state, mode: "install" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const writesAfterFirst = harness.fs.operations.length;
		const pluginCallsAfterFirst = harness.processCalls.length;
		const timelineAfterFirst = [...harness.timeline];
		const second = await applyRig(harness.runtime, { state: first.value.state, mode: "apply" });
		expect(second.ok).toBe(true);
		expect(harness.fs.operations).toHaveLength(writesAfterFirst);
		// The plugin list is read on every apply (a hand-removed plugin must come back); nothing is changed.
		const secondCalls = harness.processCalls.slice(pluginCallsAfterFirst).map((call) => call.args.join(" "));
		expect(secondCalls.filter((args) => /^plugin (install|uninstall)\b|^plugin marketplace (add|remove)\b/.test(args))).toEqual([]);
		expect(secondCalls.every((args) => args === "plugin list --json" || args === "plugin marketplace list --json")).toBe(true);
		expect(harness.timeline).toEqual(timelineAfterFirst);
	});

	test("install sets the stable update channel on a server only when the key is absent and does not own it", async () => {
		const settingsPath = `${HOME}/.claude/settings.json`;
		const run = async (mode: RigState["mode"], applyMode: "install" | "apply", settings: string) => {
			const harness = createMemoryRuntime();
			seedFeature(harness.fs, REPO, baseManifest());
			harness.fs.seed(settingsPath, settings);
			const state: RigState = { ...seedState(harness.fs, {}), mode };
			const applied = await applyRig(harness.runtime, { state, mode: applyMode });
			expect(applied.ok).toBe(true);
			return { settings: harness.fs.files.get(settingsPath) ?? "", records: applied.ok ? applied.value.state.records : {} };
		};

		const server = await run("server", "install", "{}\n");
		expect(server.settings).toContain("\"autoUpdatesChannel\": \"stable\"");
		expect(Object.keys(server.records).some((key) => key.includes("autoUpdatesChannel"))).toBe(false);
		const present = await run("server", "install", "{ \"autoUpdatesChannel\": \"latest\" }\n");
		expect(present.settings).toContain("\"latest\"");
		expect(present.settings).not.toContain("stable");
		const dev = await run("dev", "install", "{}\n");
		expect(dev.settings).not.toContain("autoUpdatesChannel");
		const later = await run("server", "apply", "{}\n");
		expect(later.settings).not.toContain("autoUpdatesChannel");
	});

	test("every toggle of the shipped features leaves the next apply a no-op", async () => {
		const harness = createMemoryRuntime();
		seedShippedRepository(harness.fs);
		seedHubManifest(harness.fs, HUB, "telegram-hub-local");
		const state = seedState(harness.fs, Object.fromEntries(SHIPPED_LINUX_FEATURES.map((name) => [name, true])));
		const installed = await applyRig(harness.runtime, { state, mode: "install" });
		expect(installed.ok).toBe(true);

		// telegram is left out: disabling it keeps the rig lock until the process exits (src/commands/feature.ts),
		// which an in-process test cannot simulate, so a later toggle would wait on that lock forever.
		const toggles: Array<{ name: string; action: "enable" | "disable" }> = [
			...[...IN_PROCESS_TOGGLE_FEATURES].reverse().map((name) => ({ name, action: "disable" as const })),
			...IN_PROCESS_TOGGLE_FEATURES.map((name) => ({ name, action: "enable" as const })),
		];
		for (const { name, action } of toggles) {
			const changed = await changeFeature(harness.runtime, name, action, () => undefined);
			expect(changed.ok).toBe(true);
			const current = await readRigState(harness.runtime);
			expect(current.ok).toBe(true);
			if (!current.ok) return;
			const writesBefore = harness.fs.operations.length;
			const applied = await applyRig(harness.runtime, { state: current.value, mode: "apply" });
			expect(applied.ok).toBe(true);
			expect({ step: `${action} ${name}`, writes: harness.fs.operations.slice(writesBefore) }).toEqual({ step: `${action} ${name}`, writes: [] });
		}
	});

	test("telegram disable saves state and stops the service as the final operation", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("telegram"));
		seedState(harness.fs, { telegram: true });

		const result = await changeFeature(harness.runtime, "telegram", "disable", () => undefined);
		expect(result.ok).toBe(true);
		expect(harness.fs.files.get(STATE_PATH)).toContain('"telegram": false');
		expect(harness.timeline[harness.timeline.length - 1]).toBe("service-stop");
	});

	test("telegram enable that cannot start the service fails, keeps the feature off and emits no change event", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("telegram"));
		seedState(harness.fs, { telegram: false });
		const runtime = { ...harness.runtime, service: { ...harness.runtime.service, start: async () => err("unit failed") } };

		const result = await changeFeature(runtime, "telegram", "enable", () => undefined);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("unit failed");
		expect(harness.fs.files.get(STATE_PATH)).toContain('"telegram": false');
		expect(harness.fs.files.get(`${HOME}/.agent-rig/events.jsonl`) ?? "").not.toContain("features-changed");
	});

	test("check sends reflect a stop_hook_active test event and never invokes claude -p", async () => {
		const harness = createMemoryRuntime();
		const hook = {
			event: "Stop",
			matcher: "",
			command: "{{PYTHON}}",
			args: ["{{CLONE}}/features/reflection/hooks/reflect.py"],
			timeout: REFLECT_TEST_TIMEOUT_SECONDS,
			statusMessage: "Testing reflection",
			async: false,
			asyncRewake: false,
			shell: "bash",
		};
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("reflection", { hooks: [hook] }));
		seedState(harness.fs, { reflection: true });
		seedCheckableRig(harness.fs, REFLECT_HOOK_SETTINGS);

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(true);
		const hookCall = harness.processCalls.find((call) => call.command === "/usr/bin/python3" && call.args[0]?.endsWith("reflect.py"));
		expect(hookCall?.options?.input).toContain('"stop_hook_active":true');
		expect(harness.processCalls.some((call) => call.command === "claude" && call.args.includes("-p"))).toBe(false);
	});

	test("check fails when the codex rule block has its end marker before its begin marker", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});
		seedCheckableRig(harness.fs, "{}\n", "<!-- rig:end -->\n<!-- rig:begin -->\n");

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(`The built rules block was not found: ${HOME}/.codex/AGENTS.md`);
	});

	test("check fails when settings.json does not carry an enabled feature's hook", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("reflection", { hooks: [REFLECT_HOOK] }));
		seedState(harness.fs, { reflection: true });
		seedCheckableRig(harness.fs, "{}\n");

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("The hook reflection/Stop is not recorded in settings.json.");
	});

	test("check fails when settings.json records an enabled feature's hook under another matcher", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("reflection", { hooks: [REFLECT_HOOK] }));
		seedState(harness.fs, { reflection: true });
		seedCheckableRig(harness.fs, REFLECT_HOOK_OTHER_MATCHER_SETTINGS);

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("The hook reflection/Stop is not recorded in settings.json.");
	});

	test("a PreToolUse test event carries a tool name and a tool input so the hook logic runs", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("guard", { hooks: [GUARD_HOOK] }));
		seedState(harness.fs, { guard: true });
		seedCheckableRig(harness.fs, GUARD_HOOK_SETTINGS);

		await checkRig(harness.runtime);
		const hookCall = harness.processCalls.find((call) => call.command === "/usr/bin/python3" && call.args[0]?.endsWith("no_ampersand.py"));
		const event: unknown = JSON.parse(hookCall?.options?.input ?? "null");
		expect(event).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo rig-check" } });
	});

	test("check runs hooks and project-tmp.sh with CLAUDE_PROJECT_DIR set to its own temporary folder", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("reflection", { hooks: [REFLECT_HOOK] }));
		seedState(harness.fs, { reflection: true });
		seedCheckableRig(harness.fs, REFLECT_HOOK_SETTINGS);

		await checkRig(harness.runtime);
		const hookCall = harness.processCalls.find((call) => call.command === "/usr/bin/python3" && call.args[0]?.endsWith("reflect.py"));
		expect(hookCall?.options?.cwd).toBeDefined();
		expect(hookCall?.options?.environment?.CLAUDE_PROJECT_DIR).toBe(hookCall?.options?.cwd);
		const projectTmpCall = harness.processCalls.find((call) => call.args[0]?.endsWith("project-tmp.sh"));
		expect(projectTmpCall?.options?.cwd).toBeDefined();
		expect(projectTmpCall?.options?.environment?.CLAUDE_PROJECT_DIR).toBe(projectTmpCall?.options?.cwd);
	});

	test("on Windows the project-tmp check runs Git Bash by its full path, not whatever bash comes first on PATH", async () => {
		const harness = createMemoryRuntime("windows");
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});
		seedCheckableRig(harness.fs, "{}\n");

		await checkRig(harness.runtime);
		expect(harness.processCalls.map((call) => call.command)).not.toContain("bash");
		expect(harness.processCalls.some((call) => call.command === GIT_BASH_PATH)).toBe(true);
	});

	test("a hook without args runs as a shell command string through bash -c, a hook with args runs directly", async () => {
		const harness = createMemoryRuntime();
		const shellHook = { event: "PreToolUse", matcher: "Bash", command: "rtk hook claude" };
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("rtk", { hooks: [shellHook] }));
		seedFeature(harness.fs, REPO, featureManifest("reflection", { hooks: [REFLECT_HOOK] }));
		seedState(harness.fs, { rtk: true, reflection: true });
		seedCheckableRig(harness.fs, settingsWithHooks({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/usr/bin/rtk' hook claude" }] }],
			Stop: [{ matcher: "", hooks: [{ type: "command", command: "/usr/bin/python3", args: [`${REPO}/features/reflection/hooks/reflect.py`] }] }],
		}));

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(true);
		const shellCall = harness.processCalls.find((call) => call.args.includes("'/usr/bin/rtk' hook claude"));
		expect(shellCall?.command).toBe("/usr/bin/bash");
		expect(shellCall?.args).toEqual(["-c", "'/usr/bin/rtk' hook claude"]);
		expect(harness.processCalls.some((call) => call.command === "rtk hook claude")).toBe(false);
		expect(harness.processCalls.some((call) => call.command === "/usr/bin/python3" && call.args[0]?.endsWith("reflect.py"))).toBe(true);
	});

	test("a shell hook names its shell, and an unknown shell fails the check clearly", async () => {
		const harness = createMemoryRuntime("windows");
		const hook = { event: "Stop", matcher: "", command: "echo hi", shell: "powershell" };
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("shelly", { hooks: [hook] }));
		seedState(harness.fs, { shelly: true });
		const settings = (shell: string): string => settingsWithHooks({ Stop: [{ matcher: "", hooks: [{ type: "command", command: shell === "powershell" ? "& 'C:/bin/echo.exe' hi" : "'C:/bin/echo.exe' hi", shell }] }] });
		seedCheckableRig(harness.fs, settings("powershell"));

		const ran = await checkRig(harness.runtime);
		expect(ran.ok).toBe(true);
		expect(harness.processCalls.some((call) => call.command === "powershell" && call.args.at(-1) === "& 'C:/bin/echo.exe' hi")).toBe(true);

		const unknown = createMemoryRuntime("windows");
		seedFeature(unknown.fs, REPO, baseManifest());
		seedFeature(unknown.fs, REPO, featureManifest("shelly", { hooks: [{ ...hook, shell: "zsh" }] }));
		seedState(unknown.fs, { shelly: true });
		seedCheckableRig(unknown.fs, settings("zsh"));
		const failed = await checkRig(unknown.runtime);
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error).toContain("zsh");
	});

	test("a running hub is asked once and needs no restart pause", async () => {
		const harness = createMemoryRuntime();
		seedTelegramRig(harness.fs);
		let asked = 0;
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => {
			asked += 1;
			return ok(true);
		};

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(true);
		expect(asked).toBe(FIRST_ASK);
		expect(harness.sleeps).toEqual([]);
	});

	test("a hub stopped on the first ask but running on the recheck passes after one restart pause", async () => {
		const harness = createMemoryRuntime();
		seedTelegramRig(harness.fs);
		let asked = 0;
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => {
			asked += 1;
			return asked === FIRST_ASK ? ok(false) : ok(true);
		};

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(true);
		expect(harness.sleeps).toEqual([RESTART_WAIT_MS]);
	});

	test("a hub stopped at every ask is reported as stopped after two restart pauses", async () => {
		const harness = createMemoryRuntime();
		seedTelegramRig(harness.fs);
		let asked = 0;
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => {
			asked += 1;
			return ok(false);
		};

		const result = await checkRig(harness.runtime);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(SERVICE_STOPPED_TEXT);
		expect(asked).toBe(ASKS_WHEN_STOPPED);
		expect(harness.sleeps).toEqual([RESTART_WAIT_MS, RESTART_WAIT_MS]);
	});

	test("a bus error on a recheck is an environment problem, not a stopped hub", async () => {
		const harness = createMemoryRuntime();
		seedTelegramRig(harness.fs);
		let asked = 0;
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => {
			asked += 1;
			return asked === FIRST_ASK ? ok(false) : err(BUS_FAILURE_TEXT);
		};

		const inspection = await inspectRig(harness.runtime);
		expect(inspection.ok).toBe(true);
		if (!inspection.ok) return;
		expect(inspection.value.environmentProblems).toEqual([BUS_FAILURE_TEXT]);
		expect(inspection.value.problems).not.toContain(SERVICE_STOPPED_TEXT);
	});

	test("broken settings make apply fail before any write with a clear message", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		const state = seedState(harness.fs, {});
		harness.fs.seed(`${HOME}/.claude/settings.json`, "{ broken");

		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("settings.json");
		expect(result.error).toContain("apply wrote nothing");
		expect(harness.fs.operations).toHaveLength(NO_FILE_OPERATIONS);
		expect(harness.processCalls).toHaveLength(NO_FILE_OPERATIONS);
	});

	test("an unresolved placeholder makes apply fail before any write", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("demo", {
			settings: [{ key: "demo.token", value: "{{MISSING_NAME}}" }],
		}));
		const state = seedState(harness.fs, { demo: true });

		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Unresolved placeholder {{MISSING_NAME}}");
		expect(result.error).toContain("demo setting demo.token");
		expect(harness.fs.operations).toHaveLength(NO_FILE_OPERATIONS);
		expect(harness.processCalls).toHaveLength(NO_FILE_OPERATIONS);
	});

	test("a setting with an explicit path keeps a key that contains a dot as one key", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("demo", {
			settings: [
				{ key: "env.my.var", path: ["env", "my.var"], value: "1" },
				{ key: "env.plain", value: "2" },
			],
		}));
		const state = seedState(harness.fs, { demo: true });
		harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");

		const result = await applyRig(harness.runtime, { state, mode: "apply" });
		expect(result.ok).toBe(true);
		const written = JSON.parse(harness.fs.files.get(`${HOME}/.claude/settings.json`) ?? "{}");
		expect(written.env).toEqual({ "my.var": "1", plain: "2" });
	});

	test("status lists only the errors logged after the last update-ok, in file order", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});
		harness.fs.seed(EVENTS_PATH, [
			eventLine("e1", "2026-10-30T10:00:00.000Z", "update-failed", "error", "error before success"),
			eventLine("e2", "2026-10-30T11:00:00.000Z", "update-ok", "info", "success"),
			// An earlier time than the success, but later in the file: it still counts as after it.
			eventLine("e3", "2026-10-30T09:00:00.000Z", "update-failed", "error", "error after success"),
		].join(""));

		const status = await readStatus(harness.runtime);
		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.value.errors).toEqual([{ type: "update-failed", time: "2026-10-30T09:00:00.000Z", text: "error after success" }]);
	});

	test("status lists every error when the log has no update-ok", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});
		harness.fs.seed(EVENTS_PATH, [
			eventLine("e1", "2026-10-30T10:00:00.000Z", "update-failed", "error", "first error"),
			eventLine("e2", "2026-10-30T10:05:00.000Z", "update-skipped", "warn", "a warning"),
			eventLine("e3", "2026-10-30T10:10:00.000Z", "update-failed", "error", "second error"),
		].join(""));

		const status = await readStatus(harness.runtime);
		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.value.errors.map((error) => error.text)).toEqual(["first error", "second error"]);
	});

	test("status reads each release from the manifest at the current commit and shows it beside the commit", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});
		const runtime = withGit(harness.runtime, {
			head: "rig-commit",
			manifests: { "rig-commit:package.json": '{"version":"0.2.0"}', "rig-commit:plugin/package.json": '{"version":"1.4.0"}' },
		});

		const status = await readStatus(runtime);

		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.value.versions).toEqual({ rig: "rig-commit", hub: "rig-commit" });
		expect(status.value.releases).toEqual({ rig: "0.2.0", hub: "1.4.0" });
		const lines = formatStatus(status.value, "en");
		expect(lines).toContain("agent-rig: 0.2.0 (rig-commit)");
		expect(lines).toContain("hub: 1.4.0 (rig-commit)");
	});

	test("status shows the commit alone when the manifest has no usable version", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});

		const status = await readStatus(withGit(harness.runtime, { head: "old-commit", manifests: { "old-commit:package.json": "not json" } }));

		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.value.releases).toEqual({ rig: null, hub: null });
		const lines = formatStatus(status.value, "en");
		expect(lines).toContain("agent-rig: old-commit");
		expect(lines).toContain("hub: old-commit");
	});

	test("status text says yes or no about a pending hub restart and keeps the raw value for the JSON form", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});
		const status = await readStatus(harness.runtime);
		expect(status.ok).toBe(true);
		if (!status.ok) return;
		const raw = '{"hubCommit":"abc"}';

		expect(formatStatus(status.value, "en")).toContain("Hub restart pending: no");
		const waiting = formatStatus({ ...status.value, pendingHubRestart: raw }, "en");
		expect(waiting).toContain("Hub restart pending: yes");
		expect(waiting.join("\n")).not.toContain(raw);
	});

	test("status says the version is unknown when git cannot name the commit", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedState(harness.fs, {});

		const status = await readStatus(withGit(harness.runtime, { head: null, manifests: {} }));

		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.value.releases).toEqual({ rig: null, hub: null });
		expect(formatStatus(status.value, "en")).toContain("agent-rig: unknown");
	});
});

const withGit = (runtime: RuntimePorts, git: { head: string | null; manifests: Record<string, string> }): RuntimePorts => ({
	...runtime,
	process: {
		...runtime.process,
		run: async (command, args, options) => {
			if (command !== "git") return runtime.process.run(command, args, options);
			const output = args[GIT_SUBCOMMAND_INDEX] === "rev-parse" ? (git.head === null ? null : `${git.head}\n`) : git.manifests[args[GIT_OBJECT_INDEX] ?? ""] ?? null;
			return ok(output === null
				? { stdout: "", stderr: "fatal: not found", exitCode: GIT_FAILURE_EXIT_CODE }
				: { stdout: output, stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });
		},
	},
});

const REAL_REPOSITORY = join(import.meta.dir, "..");
const SHIPPED_LINUX_FEATURES = ["codex", "js-ts-rules", "reflection", "rtk", "skills", "superpowers", "telegram"];
const IN_PROCESS_TOGGLE_FEATURES = SHIPPED_LINUX_FEATURES.filter((name) => name !== "telegram");

const seedShippedRepository = (fs: ReturnType<typeof createMemoryRuntime>["fs"]): void => {
	for (const top of ["base", "features"]) {
		const root = join(REAL_REPOSITORY, top);
		for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
			const source = join(root, file);
			if (!statSync(source).isFile()) continue;
			fs.seed(`${REPO}/${top}/${file.split(sep).join("/")}`, readFileSync(source, "utf8"));
		}
	}
};

const seedState = (fs: ReturnType<typeof createMemoryRuntime>["fs"], features: Record<string, boolean>): RigState => {
	const state: RigState = {
		mode: "dev",
		paths: { repo: REPO, hub: HUB },
		features,
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	return state;
};

const CODEX_RULE_BLOCK = "<!-- rig:begin -->\n<!-- rig:end -->\n";
const GIT_BASH_PATH = "C:/Git/bin/bash.exe";
const REFLECT_HOOK = {
	event: "Stop",
	matcher: "",
	command: "{{PYTHON}}",
	args: ["{{CLONE}}/features/reflection/hooks/reflect.py"],
};
const GUARD_HOOK = {
	event: "PreToolUse",
	matcher: "Bash",
	command: "{{PYTHON}}",
	args: ["{{CLONE}}/base/hooks/no_ampersand.py"],
};
const settingsWithHooks = (hooks: Record<string, unknown>): string => `${JSON.stringify({ hooks }, null, 2)}\n`;
const REFLECT_HOOK_SETTINGS = settingsWithHooks({
	Stop: [{ matcher: "", hooks: [{ type: "command", command: "/usr/bin/python3", args: [`${REPO}/features/reflection/hooks/reflect.py`] }] }],
});
const REFLECT_HOOK_OTHER_MATCHER_SETTINGS = settingsWithHooks({
	Stop: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/python3", args: [`${REPO}/features/reflection/hooks/reflect.py`] }] }],
});
const GUARD_HOOK_SETTINGS = settingsWithHooks({
	PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/python3", args: [`${REPO}/base/hooks/no_ampersand.py`] }] }],
});

const eventLine = (id: string, time: string, type: string, level: "info" | "warn" | "error", text: string): string => `${JSON.stringify({ id, time, level, type, text })}\n`;

// Seeds an installed rig with the telegram feature on, so checkRig asks the hub service.
const seedTelegramRig = (fs: ReturnType<typeof createMemoryRuntime>["fs"]): void => {
	seedFeature(fs, REPO, baseManifest());
	seedFeature(fs, REPO, featureManifest("telegram"));
	seedState(fs, { telegram: true });
	seedCheckableRig(fs, "{}\n");
};

// Seeds the files checkRig reads: the Codex rule block, the generated rules, the Claude imports and settings.json.
const seedCheckableRig = (fs: ReturnType<typeof createMemoryRuntime>["fs"], settingsText: string, codexText = CODEX_RULE_BLOCK): void => {
	fs.seed(`${HOME}/.codex/AGENTS.md`, codexText);
	fs.seed(`${HOME}/.agent-rig/generated/CLAUDE.md`, "");
	fs.seed(`${HOME}/.claude/CLAUDE.md`, "@../.codex/AGENTS.md\n@../.agent-rig/generated/CLAUDE.md\n");
	fs.seed(`${HOME}/.claude/settings.json`, settingsText);
};

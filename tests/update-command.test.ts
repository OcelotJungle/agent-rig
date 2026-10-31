import type { RigState } from "../src/state.js";
import type { Result } from "../src/result.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { runUpdateStep } from "../src/commands/update.js";
import { updateRig } from "../src/commands/update.js";
import { err, ok } from "../src/result.js";
import {
	baseManifest,
	createMemoryRuntime,
	featureManifest,
	seedFeature,
} from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const OLD_COMMIT = "old-commit";
const NEW_COMMIT = "new-commit";
const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;
const LOCK_OWNER_PID = 10;
const LOCK_OWNER_START_TIME = 20;
const OTHER_OWNER_PID = 99;
const HANG_BUDGET_MS = 5000;
// The hub is still restarting on the first ask and running on the recheck (see check.ts SERVICE_RECHECKS).
const STOPPED_ANSWERS = 1;

type FakeGit = { heads: Map<string, string>; target: string };

describe("rig update runs the new code in a child process under the parent lock", () => {
	test("apply and check are run by the new clone's cli.ts, not in the parent", async () => {
		const { harness, git } = setup({});
		const delegated: string[][] = [];
		routeChildren(harness, git, delegated);

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(true);
		expect(git.heads.get(REPO)).toBe(NEW_COMMIT);
		expect(delegated.map((args) => args.slice(0, 3))).toEqual([
			[`${REPO}/src/cli.ts`, "update-step", "apply"],
			[`${REPO}/src/cli.ts`, "update-step", "check"],
		]);
	}, HANG_BUDGET_MS);

	test("a failing child step rolls the update back and records the bad pair", async () => {
		const { harness, git } = setup({});
		routeChildren(harness, git, [], "check");

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(false);
		expect(git.heads.get(REPO)).toBe(OLD_COMMIT);
		expect(readBadPairs(harness)).toEqual([{ repo: NEW_COMMIT, hub: NEW_COMMIT }]);
	}, HANG_BUDGET_MS);

	test("a child that cannot even start counts as a failed step", async () => {
		const { harness, git } = setup({});
		routeChildren(harness, git, [], "apply-spawn-error");

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(false);
		expect(git.heads.get(REPO)).toBe(OLD_COMMIT);
		expect(readBadPairs(harness)).toEqual([{ repo: NEW_COMMIT, hub: NEW_COMMIT }]);
	}, HANG_BUDGET_MS);

	test("the child refuses to run when the lock is not held by the named parent", async () => {
		const { harness } = setup({});
		harness.fs.seed(`${HOME}/.agent-rig/rig.lock`, `${JSON.stringify({ pid: LOCK_OWNER_PID, startTime: LOCK_OWNER_START_TIME })}\n`);

		const wrongPid = await runCli(["update-step", "apply", String(OTHER_OWNER_PID), String(LOCK_OWNER_START_TIME)], () => undefined, harness.runtime);
		const wrongStart = await runCli(["update-step", "apply", String(LOCK_OWNER_PID), String(LOCK_OWNER_START_TIME + 1)], () => undefined, harness.runtime);

		expect(wrongPid).toBe(FAILURE_EXIT_CODE);
		expect(wrongStart).toBe(FAILURE_EXIT_CODE);
	}, HANG_BUDGET_MS);

	test("the child step does not wait for the lock its parent holds", async () => {
		const { harness } = setup({});
		harness.fs.seed(`${HOME}/.agent-rig/rig.lock`, `${JSON.stringify({ pid: LOCK_OWNER_PID, startTime: LOCK_OWNER_START_TIME })}\n`);

		const code = await runUpdateStep(harness.runtime, "check", { pid: LOCK_OWNER_PID, startTime: LOCK_OWNER_START_TIME }, () => undefined);

		expect([SUCCESS_EXIT_CODE, FAILURE_EXIT_CODE]).toContain(code);
	}, HANG_BUDGET_MS);

	test("the update step installs a missing program that needs no root, so a good update is not rolled back", async () => {
		const { harness, git } = setup({ program: true });
		harness.unavailableCommands.add("demo-tool");
		harness.runtime.programs.install = async (name): Promise<Result<void>> => {
			if (name === "demo-tool") harness.unavailableCommands.delete("demo-tool");
			return ok(undefined);
		};
		routeChildren(harness, git, []);

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(true);
		expect(git.heads.get(REPO)).toBe(NEW_COMMIT);
		expect(readBadPairs(harness)).toEqual([]);
	}, HANG_BUDGET_MS);

	test("a missing system package still fails the update step with its install command", async () => {
		const { harness, git } = setup({ systemProgram: true });
		harness.unavailableCommands.add("demo-system");
		const lines: string[] = [];
		routeChildren(harness, git, [], undefined, lines);

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(false);
		expect(git.heads.get(REPO)).toBe(OLD_COMMIT);
		expect(lines.join("\n")).toContain("sudo apt-get install demo-system");
	}, HANG_BUDGET_MS);

	test("a service bus failure is an error, not a stopped service, and records no bad pair", async () => {
		const { harness, git } = setup({ telegram: true });
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => err("Failed to connect to bus: No medium found");
		routeChildren(harness, git, []);

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(false);
		expect(git.heads.get(REPO)).toBe(OLD_COMMIT);
		expect(readBadPairs(harness)).toEqual([]);
	}, HANG_BUDGET_MS);

	test("a service stopped only on the first ask is restarting, not stopped, so the update completes", async () => {
		const { harness, git } = setup({ telegram: true });
		let asked = 0;
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => {
			asked += 1;
			return ok(asked > STOPPED_ANSWERS);
		};
		routeChildren(harness, git, []);

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(true);
		expect(git.heads.get(REPO)).toBe(NEW_COMMIT);
		expect(readBadPairs(harness)).toEqual([]);
	}, HANG_BUDGET_MS);

	test("a stopped service still records the bad pair", async () => {
		const { harness, git } = setup({ telegram: true });
		harness.runtime.service.isRunning = async (): Promise<Result<boolean>> => ok(false);
		routeChildren(harness, git, []);

		const result = await updateRig(harness.runtime, false, () => undefined);

		expect(result.ok).toBe(false);
		expect(git.heads.get(REPO)).toBe(OLD_COMMIT);
		expect(readBadPairs(harness)).toEqual([{ repo: NEW_COMMIT, hub: NEW_COMMIT }]);
	}, HANG_BUDGET_MS);
});

type SetupOptions = { program?: boolean; systemProgram?: boolean; telegram?: boolean };

const setup = (options: SetupOptions): { harness: MemoryRuntimeHarness; git: FakeGit } => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, baseManifest());
	const features: Record<string, boolean> = {};
	if (options.program === true) {
		seedFeature(harness.fs, REPO, featureManifest("tools", {
			programs: [{ name: "demo-tool", command: "demo-tool", installCommand: null, systemPackage: false }],
		}));
		features.tools = true;
	}
	if (options.systemProgram === true) {
		seedFeature(harness.fs, REPO, featureManifest("system-tools", {
			programs: [{ name: "demo-system", command: "demo-system", installCommand: "sudo apt-get install demo-system", systemPackage: true }],
		}));
		features["system-tools"] = true;
	}
	if (options.telegram === true) {
		seedFeature(harness.fs, REPO, featureManifest("telegram"));
		features.telegram = true;
	}
	const state: RigState = {
		mode: "server",
		paths: { repo: REPO, hub: HUB },
		features,
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");
	const git: FakeGit = { heads: new Map([[REPO, OLD_COMMIT], [HUB, OLD_COMMIT]]), target: NEW_COMMIT };
	return { harness, git };
};

type FailureMode = "check" | "apply-spawn-error" | undefined;

// Routes git to an in-memory pair of clones and runs the "new code" child in-process on the same runtime.
const routeChildren = (
	harness: MemoryRuntimeHarness,
	git: FakeGit,
	delegated: string[][],
	failure?: FailureMode,
	outputLines: string[] = [],
): void => {
	const original = harness.runtime.process.run;
	harness.runtime.process.run = async (command, args, options) => {
		if (command === "git") return fakeGit(git, args);
		if (command === harness.runtime.executablePath && args[1] === "update-step") {
			delegated.push([...args]);
			if (failure === "apply-spawn-error" && args[2] === "apply") return err("spawn failed");
			if (failure === "check" && args[2] === "check") return ok({ stdout: "Ошибка rig: broken", stderr: "", exitCode: FAILURE_EXIT_CODE });
			const lines: string[] = [];
			const exitCode = await runCli(args.slice(1), (line) => lines.push(line), harness.runtime);
			outputLines.push(...lines);
			return ok({ stdout: lines.join("\n"), stderr: "", exitCode });
		}
		return original(command, args, options);
	};
};

const fakeGit = (git: FakeGit, args: readonly string[]): Result<{ stdout: string; stderr: string; exitCode: number }> => {
	const repository = args[1] ?? "";
	const rest = args.slice(2);
	const done = (stdout: string) => ok({ stdout, stderr: "", exitCode: SUCCESS_EXIT_CODE });
	if (rest[0] === "status") return done("");
	if (rest[0] === "branch") return done("main\n");
	if (rest[0] === "rev-list") return done("0\n");
	if (rest[0] === "fetch") return done("");
	if (rest[0] === "rev-parse" && rest[1] === "origin/main") return done(`${git.target}\n`);
	if (rest[0] === "rev-parse") return done(`${git.heads.get(repository) ?? ""}\n`);
	if (rest[0] === "merge") {
		git.heads.set(repository, rest[2] ?? "");
		return done("");
	}
	if (rest[0] === "reset") {
		git.heads.set(repository, rest[2] ?? "");
		return done("");
	}
	return err(`unexpected git call: ${args.join(" ")}`);
};

const readBadPairs = (harness: MemoryRuntimeHarness): RigState["badPairs"] => {
	const text = harness.fs.files.get(STATE_PATH) ?? "{}";
	const parsed: { badPairs?: RigState["badPairs"] } = JSON.parse(text);
	return parsed.badPairs ?? [];
};

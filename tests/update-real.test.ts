import type { RigState } from "../src/state.js";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { updateRig } from "../src/commands/update.js";
import { createRealRuntime } from "../src/commands/real-runtime.js";

const TEMP_DIRECTORY_PREFIX = "agent-rig-update-real-";
// Each update spawns bun twice and asks the OS for process start times; Windows is slow at that.
const REAL_UPDATE_TIMEOUT_MS = 120_000;
const COPIED_ENTRIES = ["src", "base", "features", "package.json", "tsconfig.json"];
const BROKEN_IMPORT = "import \"./does-not-exist.js\";\n";
// Runs before the code of src/cli.ts, so only the child `update-step check` exits non-zero; `update-step apply` still passes.
const CHECK_STEP_FAILURE = 'if (process.argv[2] === "update-step" && process.argv[3] === "check") process.exit(1);\n';
const CLI_FILE = "src/cli.ts";
const NOTE_FILE = "NOTES.md";

type Fixture = {
	root: string;
	home: string;
	clone: string;
	hubClone: string;
	firstCommit: string;
	secondCommit: string;
};

let root: string | undefined;
let savedHome: { USERPROFILE: string | undefined; HOME: string | undefined } | undefined;

beforeEach(() => {
	savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
});

afterEach(async () => {
	if (savedHome !== undefined) {
		restoreEnvironment("USERPROFILE", savedHome.USERPROFILE);
		restoreEnvironment("HOME", savedHome.HOME);
		savedHome = undefined;
	}
	if (root !== undefined) {
		await fs.rm(root, { recursive: true, force: true });
		root = undefined;
	}
});

describe("rig update with real git and a real child process", () => {
	test("a new commit that breaks src/cli.ts at import is rolled back and its pair is recorded as bad", async () => {
		const fixture = await createFixture(async (origin) => {
			const cli = await fs.readFile(join(origin, CLI_FILE), "utf8");
			await fs.writeFile(join(origin, CLI_FILE), BROKEN_IMPORT + cli, "utf8");
		});
		const runtime = await createRealRuntime();
		if (!runtime.ok) throw new Error(runtime.error);

		const result = await updateRig(runtime.value, false, () => undefined);

		expect(result.ok).toBe(false);
		expect(runGit(fixture.clone, ["rev-parse", "HEAD"])).toBe(fixture.firstCommit);
		const state = await readState(fixture.home);
		expect(state.badPairs.map((pair) => pair.repo)).toEqual([fixture.secondCommit]);
	}, REAL_UPDATE_TIMEOUT_MS);

	test("a new commit whose check step fails after apply passes is rolled back and its pair is recorded as bad", async () => {
		const fixture = await createFixture(async (origin) => {
			const cli = await fs.readFile(join(origin, CLI_FILE), "utf8");
			await fs.writeFile(join(origin, CLI_FILE), CHECK_STEP_FAILURE + cli, "utf8");
		});
		const runtime = await createRealRuntime();
		if (!runtime.ok) throw new Error(runtime.error);

		const result = await updateRig(runtime.value, false, () => undefined);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("an update whose check step fails must not succeed");
		// The error names the failed step, so the failure is the check and not the apply.
		expect(result.error).toContain("(check)");
		expect(runGit(fixture.clone, ["rev-parse", "HEAD"])).toBe(fixture.firstCommit);
		const state = await readState(fixture.home);
		expect(state.badPairs.map((pair) => pair.repo)).toEqual([fixture.secondCommit]);
	}, REAL_UPDATE_TIMEOUT_MS);

	test("a harmless new commit is applied and kept", async () => {
		const fixture = await createFixture(async (origin) => {
			await fs.writeFile(join(origin, NOTE_FILE), "notes\n", "utf8");
		});
		const runtime = await createRealRuntime();
		if (!runtime.ok) throw new Error(runtime.error);

		const result = await updateRig(runtime.value, false, () => undefined);

		expect(result).toEqual({ ok: true, value: undefined });
		expect(runGit(fixture.clone, ["rev-parse", "HEAD"])).toBe(fixture.secondCommit);
		expect((await readState(fixture.home)).badPairs).toEqual([]);
	}, REAL_UPDATE_TIMEOUT_MS);
});

const createFixture = async (secondCommitChange: (origin: string) => Promise<void>): Promise<Fixture> => {
	const base = await fs.mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
	root = base;
	const slashed = base.replaceAll("\\", "/");
	const home = `${slashed}/home`;
	const origin = `${slashed}/origin`;
	const hubOrigin = `${slashed}/hub-origin`;
	const clone = `${slashed}/clone`;
	const hubClone = `${slashed}/hub-clone`;
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(origin, { recursive: true });
	await fs.mkdir(hubOrigin, { recursive: true });
	for (const entry of COPIED_ENTRIES) await fs.cp(join(process.cwd(), entry), join(origin, entry), { recursive: true });
	await fs.writeFile(join(hubOrigin, "hub.txt"), "hub\n", "utf8");
	const firstCommit = initRepository(origin);
	initRepository(hubOrigin);
	runGit(base, ["clone", origin, clone]);
	runGit(base, ["clone", hubOrigin, hubClone]);
	await secondCommitChange(origin);
	runGit(origin, ["add", "-A"]);
	runGit(origin, ["commit", "-m", "second"]);
	const secondCommit = runGit(origin, ["rev-parse", "HEAD"]);
	const state: RigState = {
		mode: "server",
		paths: { repo: clone, hub: hubClone },
		features: {},
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	// project-tmp.sh calls this helper from the user's hooks directory, which a fresh home does not have.
	await fs.mkdir(join(home, ".claude", "hooks"), { recursive: true });
	await fs.copyFile(join(process.cwd(), "base", "hooks", "project-tmp-settings.ps1"), join(home, ".claude", "hooks", "project-tmp-settings.ps1"));
	await fs.mkdir(join(home, ".agent-rig"), { recursive: true });
	await fs.writeFile(join(home, ".agent-rig", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	return { root: slashed, home, clone, hubClone, firstCommit, secondCommit };
};

const initRepository = (path: string): string => {
	runGit(path, ["init", "--initial-branch=main"]);
	runGit(path, ["config", "user.name", "Rig Test"]);
	runGit(path, ["config", "user.email", "rig-test@example.invalid"]);
	runGit(path, ["add", "-A"]);
	runGit(path, ["commit", "-m", "first"]);
	return runGit(path, ["rev-parse", "HEAD"]);
};

const runGit = (cwd: string, args: string[]): string => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
};

const readState = async (home: string): Promise<RigState> => {
	const parsed: RigState = JSON.parse(await fs.readFile(join(home, ".agent-rig", "state.json"), "utf8"));
	return parsed;
};

const restoreEnvironment = (name: "USERPROFILE" | "HOME", value: string | undefined): void => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

import type { ProcessKiller, ProcessLimits, ProcessTimer } from "../src/commands/process-runner.js";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PROCESS_TIMEOUT_MS, planSpawn, runProcess } from "../src/commands/process-runner.js";

const MINUTES = 15;
const MS_PER_MINUTE = 60_000;
const POLL_MS = 25;
const POLL_ATTEMPTS = 400;
const NEVER_FIRES_MS = 1_000_000;
// bun's default per-test timeout is 5 s; the tree test polls for up to POLL_MS * POLL_ATTEMPTS (10 s) before its
// assertion fails, so it needs the poll budget plus the default, or a survivor would show as a timeout, not a failure.
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5_000;
const TREE_TEST_TIMEOUT_MS = POLL_MS * POLL_ATTEMPTS + BUN_DEFAULT_TEST_TIMEOUT_MS;
const IS_WINDOWS = process.platform === "win32";

type ManualTimer = { timer: ProcessTimer; requested: number[]; fire(): void; disarmed: () => boolean };

const manualTimer = (): ManualTimer => {
	const requested: number[] = [];
	let callback: (() => void) | null = null;
	let disarmedFlag = false;
	return {
		requested,
		timer: { start: (milliseconds, onExpire) => { requested.push(milliseconds); callback = onExpire; return () => { disarmedFlag = true; }; } },
		fire: () => callback?.(),
		disarmed: () => disarmedFlag,
	};
};

const wait = (milliseconds: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const waitFor = async (condition: () => Promise<boolean>): Promise<boolean> => {
	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
		if (await condition()) return true;
		await wait(POLL_MS);
	}
	return false;
};

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

let directory = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rig-process-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("process time limit", () => {
	test("the default limit is 15 minutes", () => {
		expect(PROCESS_TIMEOUT_MS).toBe(MINUTES * MS_PER_MINUTE);
	});

	test("a process that runs past the injected limit is killed and reported as failed", async () => {
		const manual = manualTimer();
		const limits: ProcessLimits = { timeoutMs: PROCESS_TIMEOUT_MS, timer: manual.timer };
		const pending = runProcess(process.env.PATH ?? "", process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {}, limits);
		await wait(POLL_MS);
		expect(manual.requested).toEqual([PROCESS_TIMEOUT_MS]);

		manual.fire();
		const result = await pending;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("15 minutes");
	});

	test("a process that closes while its tree is being killed still counts as failed", async () => {
		const manual = manualTimer();
		// The direct child dies and reports close first; taskkill or the group kill returns only after that.
		const killAfterClose: ProcessKiller = (child) => new Promise((resolveKill) => {
			child.once("close", () => setTimeout(resolveKill, 0));
			child.kill("SIGKILL");
		});
		const limits: ProcessLimits = { timeoutMs: PROCESS_TIMEOUT_MS, timer: manual.timer, kill: killAfterClose };
		const pending = runProcess(process.env.PATH ?? "", process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {}, limits);
		await wait(POLL_MS);

		manual.fire();
		const result = await pending;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("15 minutes");
	});

	test("a process that finishes in time disarms the timer", async () => {
		const manual = manualTimer();
		const result = await runProcess(process.env.PATH ?? "", process.execPath, ["-e", "console.log('hi')"], {}, { timeoutMs: NEVER_FIRES_MS, timer: manual.timer });
		expect(result.ok && result.value.stdout.trim()).toBe("hi");
		expect(manual.disarmed()).toBe(true);
	});

	test("the whole process tree dies, not only the direct child", async () => {
		const grandchildPath = join(directory, "grandchild.ts");
		const childPath = join(directory, "child.ts");
		const pidPath = join(directory, "grandchild.pid");
		await writeFile(grandchildPath, "setInterval(() => undefined, 1000);\n");
		await writeFile(childPath, [
			"import { spawn } from \"node:child_process\";",
			"import { writeFileSync } from \"node:fs\";",
			`const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: "ignore", detached: ${process.platform === "win32"} });`,
			`writeFileSync(${JSON.stringify(pidPath)}, String(grandchild.pid));`,
			"setInterval(() => undefined, 1000);",
			"",
		].join("\n"));
		const manual = manualTimer();
		const pending = runProcess(process.env.PATH ?? "", process.execPath, [childPath], {}, { timeoutMs: PROCESS_TIMEOUT_MS, timer: manual.timer });

		const written = await waitFor(async () => { try { return (await readFile(pidPath, "utf8")).length > 0; } catch { return false; } });
		expect(written).toBe(true);
		const grandchildPid = Number(await readFile(pidPath, "utf8"));
		expect(isAlive(grandchildPid)).toBe(true);

		try {
			manual.fire();
			const result = await pending;

			expect(result.ok).toBe(false);
			expect(await waitFor(async () => !isAlive(grandchildPid))).toBe(true);
		} finally {
			if (isAlive(grandchildPid)) {
				try { process.kill(grandchildPid); } catch { /* exited between the check and the kill */ }
			}
		}
	}, TREE_TEST_TIMEOUT_MS);
});

describe("git never waits for a password", () => {
	test("other commands do not get GIT_TERMINAL_PROMPT", async () => {
		const printed = await runProcess(process.env.PATH ?? "", process.execPath, ["-e", "console.log(process.env.GIT_TERMINAL_PROMPT ?? 'unset')"]);
		expect(printed.ok && printed.value.stdout.trim()).toBe(process.env.GIT_TERMINAL_PROMPT ?? "unset");
	});

	test("the environment given to git contains GIT_TERMINAL_PROMPT=0", async () => {
		const scriptDirectory = join(directory, "bin");
		const scriptPath = join(scriptDirectory, IS_WINDOWS ? "git.cmd" : "git");
		await mkdir(scriptDirectory);
		await writeFile(scriptPath, IS_WINDOWS ? "@echo off\r\necho prompt=%GIT_TERMINAL_PROMPT%\r\n" : "#!/bin/sh\necho prompt=$GIT_TERMINAL_PROMPT\n");
		await chmod(scriptPath, 0o755);

		const result = await runProcess(`${scriptDirectory}${delimiter}${process.env.PATH ?? ""}`, "git", []);

		expect(result.ok && result.value.stdout.trim()).toBe("prompt=0");
	});
});

describe("planSpawn on Windows", () => {
	const claudeCmd = "C:\\tools\\bin\\claude.cmd";
	const existsOnly = (...paths: string[]) => (path: string): boolean => paths.includes(path);

	test("claude is resolved to claude.cmd from PATH and runs through cmd.exe", () => {
		const plan = planSpawn("windows", "claude", ["plugin", "list"], "C:\\other;C:\\tools\\bin", existsOnly(claudeCmd));
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.command).toBe("cmd.exe");
		expect(plan.value.verbatim).toBe(true);
		expect(plan.value.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(plan.value.args[3]).toBe(`"${`"${claudeCmd}" "plugin" "list"`}"`);
	});

	test("an argument with spaces stays one quoted argument", () => {
		const plan = planSpawn("windows", "claude", ["--prefix", "C:\\Program Files\\rig bin"], "C:\\tools\\bin", existsOnly(claudeCmd));
		expect(plan.ok && plan.value.args[3]).toContain("\"C:\\Program Files\\rig bin\"");
	});

	test("an .exe is spawned directly without cmd.exe", () => {
		const gitExe = "C:\\git\\git.exe";
		const plan = planSpawn("windows", "git", ["status"], "C:\\git", existsOnly(gitExe));
		expect(plan).toEqual({ ok: true, value: { command: gitExe, args: ["status"], verbatim: false } });
	});

	test("an argument that cmd.exe would expand or split is rejected, not passed", () => {
		for (const argument of ["a\"b", "%PATH%", "a\nb"]) {
			const plan = planSpawn("windows", "claude", [argument], "C:\\tools\\bin", existsOnly(claudeCmd));
			expect(plan.ok).toBe(false);
		}
	});

	test("posix passes the command and arguments through untouched", () => {
		expect(planSpawn("posix", "claude", ["a b"], "/usr/bin")).toEqual({ ok: true, value: { command: "claude", args: ["a b"], verbatim: false } });
	});
});

describe("running a command script found on PATH", () => {
	test("a fake claude script on PATH runs with an argument that has spaces", async () => {
		const binDirectory = join(directory, "bin with space");
		await mkdir(binDirectory);
		const scriptPath = join(binDirectory, IS_WINDOWS ? "claude.cmd" : "claude");
		await writeFile(scriptPath, IS_WINDOWS ? "@echo off\r\necho got:%~1\r\n" : "#!/bin/sh\necho got:$1\n");
		await chmod(scriptPath, 0o755);

		const result = await runProcess(`${binDirectory}${delimiter}${process.env.PATH ?? ""}`, "claude", ["a dir/with space"]);

		expect(result.ok && result.value.stdout.trim()).toBe("got:a dir/with space");
	});
});

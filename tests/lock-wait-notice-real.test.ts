import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { acquireLock } from "../src/lock.js";

const TEMP_DIRECTORY_PREFIX = "agent-rig-wait-notice-";
const WAIT_LINE = "Another rig command is running, waiting for it to finish.";
// The child waits for the lock with real process checks on every poll, which is slow on Windows; the budget is generous.
const CHILD_WAIT_BUDGET_MS = 120_000;
// The whole test also waits for the child to exit after the lock is released, so its timeout is larger than the budget.
const REAL_TEST_TIMEOUT_MS = 180_000;
const POLL_STEP_MS = 50;
const CLI_FILE = join(process.cwd(), "src", "cli.ts");
const CLI_ARGUMENTS = [CLI_FILE, "apply"];

type SavedEnvironment = { USERPROFILE: string | undefined; HOME: string | undefined };

let savedEnvironment: SavedEnvironment | undefined;
let temporaryHome: string | undefined;

beforeEach(() => {
	savedEnvironment = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
});

afterEach(async () => {
	if (savedEnvironment !== undefined) {
		restoreEnvironment("USERPROFILE", savedEnvironment.USERPROFILE);
		restoreEnvironment("HOME", savedEnvironment.HOME);
		savedEnvironment = undefined;
	}
	if (temporaryHome !== undefined) {
		await fs.rm(temporaryHome, { recursive: true, force: true });
		temporaryHome = undefined;
	}
});

describe("rig apply waiting for the lock, in real processes", () => {
	test("a second rig process prints the wait line while it is still waiting, and exits after the lock is released", async () => {
		const home = await fs.mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
		temporaryHome = home;
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		const runtime = await createRealRuntime();
		if (!runtime.ok) throw new Error(runtime.error);
		const held = await acquireLock(runtime.value.lock, () => undefined);
		if (!held.ok) throw new Error(held.error);

		const child = spawn(process.execPath, CLI_ARGUMENTS, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let exited = false;
		child.once("exit", () => {
			exited = true;
		});
		const closed = new Promise<number | null>((resolve) => {
			child.once("close", (code) => resolve(code));
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.resume();

		try {
			const sawLine = await waitUntil(() => stdout.includes(WAIT_LINE), CHILD_WAIT_BUDGET_MS);

			expect(sawLine).toBe(true);
			expect(exited).toBe(false);
			const released = await held.value.release();
			expect(released.ok).toBe(true);
			await closed;
			expect(stdout.split(WAIT_LINE).length - 1).toBe(1);
		} finally {
			await held.value.release();
			if (!exited) child.kill();
		}
	}, REAL_TEST_TIMEOUT_MS);
});

const waitUntil = async (condition: () => boolean, budgetMs: number): Promise<boolean> => {
	const deadline = Date.now() + budgetMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, POLL_STEP_MS);
		});
	}
	return true;
};

const restoreEnvironment = (name: "USERPROFILE" | "HOME", value: string | undefined): void => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

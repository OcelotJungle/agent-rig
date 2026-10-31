import { describe, expect, test } from "bun:test";
import { updateRig } from "../src/commands/update.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const LOCK_PATH = "/home/test/.agent-rig/rig.lock";
const HOLDER_PID = 4242;
const HOLDER_START = 777;
const OWN_PID = 1;
const OWN_START = 2;
const POLL_INTERVAL_MS = 1;

describe("rig update --pending and the lock", () => {
	test("exits at once without waiting when another command holds the lock", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(LOCK_PATH, JSON.stringify({ pid: HOLDER_PID, startTime: HOLDER_START }));
		let sleeps = 0;
		harness.runtime.lock = {
			fs: harness.fs,
			home: "/home/test",
			process: { pid: OWN_PID, startTime: OWN_START, ownerStartTime: async () => ok(HOLDER_START) },
			clock: { sleep: async () => { sleeps += 1; throw new Error("--pending must not wait for the lock"); }, now: () => Date.now() },
			pollIntervalMs: POLL_INTERVAL_MS,
		};
		const lines: string[] = [];

		const result = await updateRig(harness.runtime, true, (line) => lines.push(line));

		expect(result.ok).toBe(true);
		expect(sleeps).toBe(0);
		expect(lines.length).toBe(1);
		expect(harness.fs.files.get(LOCK_PATH)).toContain(`"pid":${HOLDER_PID}`);
	});
});

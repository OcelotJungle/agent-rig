import type { ProcessOutput, ProcessPorts, RuntimePorts } from "../src/ports.js";
import type { Result } from "../src/result.js";
import type { SessionRecord } from "../src/session-core.js";

import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeOs from "node:os";

import * as processRunner from "../src/commands/process-runner.js";
import { createRealRuntime } from "../src/commands/real-runtime.js";
import { endSession } from "../src/commands/session-stop.js";
import { apiOk, SESSION_IO, SESSION_STOP_TIMEOUT } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

// The kill ports of the real runtime, run over a fake process runner (`runProcess`), so no process is ever signalled.
// The pids are far above any real pid of a test host: a kill that escaped the fake would hit nothing.

const ROOT_PID = 987_654;
const CHILD_PID = 987_655;
const GROUP_PID = 987_660;
const CREATED = "creation";
// taskkill's exit code when a member of the tree is already gone; the kill ports never read its text.
const TASKKILL_GONE_EXIT_CODE = 128;
// `kill` exits 1 when its target no longer exists.
const KILL_GONE_EXIT_CODE = 1;
const PS_FAILED_EXIT_CODE = 1;
const LIVE_STATE = "S";
const SESSION: SessionRecord = { id: "abc", cwd: null, transcriptPath: null, copyOf: null, startedAt: "start", processes: [{ pid: ROOT_PID, pidCreated: CREATED, startedAt: "start" }] };

type Answer = (command: string, args: readonly string[]) => Result<ProcessOutput>;
type Call = { command: string; args: readonly string[] };

let ports: ProcessPorts;
let calls: Call[] = [];

beforeAll(async () => {
	const created = await createRealRuntime();
	if (!created.ok) throw new Error(created.error);
	ports = created.value.process;
});

afterEach(() => {
	mock.restore();
	calls = [];
});

const output = (exitCode: number, stdout = "", stderr = ""): Result<ProcessOutput> => ok({ stdout, stderr, exitCode });

// Every command the real ports start goes to `answer`; the recorded calls show which kill was attempted.
const fakeRunner = (answer: Answer): void => {
	spyOn(processRunner, "runProcess").mockImplementation(async (_pathEnvironment, command, args) => {
		calls.push({ command, args: [...args] });
		return answer(command, args);
	});
};

const onHost = (platform: NodeJS.Platform): void => {
	spyOn(nodeOs, "platform").mockReturnValue(platform);
};

// Rows of `ps -eo pid=,ppid=`.
const parentTable = (rows: ReadonlyArray<readonly [number, number]>): string => rows.map(([pid, parent]) => `${pid} ${parent}`).join("\n");

// Rows of `ps -eo pid=,pgid=,stat=`.
const groupTable = (rows: ReadonlyArray<readonly [number, number]>): string => rows.map(([pid, group]) => `${pid} ${group} ${LIVE_STATE}`).join("\n");

const killCalls = (): Call[] => calls.filter((call) => call.command === "kill" || call.command === "taskkill");

// The real runtime's process ports, with the liveness check replaced by `alive` (the creation time of the root or null).
// The clock is injected, so a stop that waits its full bound takes no real time.
const runtimeWith = (alive: () => boolean): RuntimePorts => {
	const memory = createMemoryRuntime();
	let now = 0;
	memory.runtime.clock.now = () => new Date(now);
	memory.runtime.clock.sleep = async (milliseconds) => { now += milliseconds; };
	return { ...memory.runtime, process: { ...ports, createdAt: async () => ok({ [String(ROOT_PID)]: alive() ? CREATED : null }) } };
};

describe("kill ports on Windows", () => {
	test("killTree: a taskkill that ran and exited non-zero is not an error", async () => {
		onHost("win32");
		fakeRunner(() => output(TASKKILL_GONE_EXIT_CODE, "", "ERROR: a member could not be terminated"));
		const killed = await ports.killTree(ROOT_PID);
		expect(killed.ok).toBe(true);
		expect(killCalls().map((call) => call.command)).toEqual(["taskkill"]);
	});

	test("killTree: a taskkill that cannot start is an error", async () => {
		onHost("win32");
		fakeRunner(() => err("spawn failed"));
		expect((await ports.killTree(ROOT_PID)).ok).toBe(false);
	});

	test("killGroup: groups do not exist on Windows", async () => {
		onHost("win32");
		fakeRunner(() => output(0));
		expect((await ports.killGroup(GROUP_PID)).ok).toBe(false);
		expect(calls).toEqual([]);
	});

	test("endSession: a taskkill that exits non-zero after the process is gone ends the session", async () => {
		onHost("win32");
		let killed = false;
		fakeRunner((command) => {
			if (command !== "taskkill") return err("unexpected command");
			killed = true;
			return output(TASKKILL_GONE_EXIT_CODE, "", "ERROR: a member could not be terminated");
		});
		expect(await endSession(runtimeWith(() => !killed), SESSION)).toEqual(apiOk(true));
		expect(killCalls().map((call) => call.command)).toEqual(["taskkill"]);
	});

	test("endSession: a process still alive after a non-zero taskkill ends in a stop timeout", async () => {
		onHost("win32");
		fakeRunner(() => output(TASKKILL_GONE_EXIT_CODE));
		const result = await endSession(runtimeWith(() => true), SESSION);
		expect(result.ok ? "ok" : result.error.code).toBe(SESSION_STOP_TIMEOUT);
		expect(killCalls().map((call) => call.command)).toEqual(["taskkill"]);
	});

	test("endSession: a taskkill that cannot start is an I/O error", async () => {
		onHost("win32");
		fakeRunner(() => err("spawn failed"));
		const result = await endSession(runtimeWith(() => true), SESSION);
		expect(result.ok ? "ok" : result.error.code).toBe(SESSION_IO);
	});
});

describe("kill ports on POSIX", () => {
	test("killTree: a root whose kill exits non-zero (already ended) is not an error", async () => {
		onHost("linux");
		fakeRunner((command) => (command === "ps" ? output(0, parentTable([[ROOT_PID, 1]])) : output(KILL_GONE_EXIT_CODE)));
		const killed = await ports.killTree(ROOT_PID);
		expect(killed.ok).toBe(true);
		expect(killCalls().map((call) => call.args)).toEqual([["-TERM", String(ROOT_PID)]]);
	});

	test("killTree: a process table that cannot be read is an error", async () => {
		onHost("linux");
		fakeRunner((command) => (command === "ps" ? output(PS_FAILED_EXIT_CODE, "", "ps failed") : output(0)));
		expect((await ports.killTree(ROOT_PID)).ok).toBe(false);
		expect(killCalls()).toEqual([]);
	});

	test("killTree: a kill that cannot start is an error", async () => {
		onHost("linux");
		fakeRunner((command) => (command === "ps" ? output(0, parentTable([[ROOT_PID, 1]])) : err("spawn failed")));
		expect((await ports.killTree(ROOT_PID)).ok).toBe(false);
	});

	test("killGroup: a group already gone (kill exits non-zero) is not an error", async () => {
		onHost("linux");
		fakeRunner(() => output(KILL_GONE_EXIT_CODE));
		const killed = await ports.killGroup(GROUP_PID);
		expect(killed.ok).toBe(true);
		expect(killCalls().map((call) => call.args)).toEqual([["-KILL", "--", `-${GROUP_PID}`]]);
	});

	test("killGroup: a group kill that cannot start is an error", async () => {
		onHost("linux");
		fakeRunner(() => err("spawn failed"));
		expect((await ports.killGroup(GROUP_PID)).ok).toBe(false);
	});

	test("killRunMembers: a member that ended before its kill is not an error", async () => {
		onHost("linux");
		fakeRunner((command) => (command === "ps" ? output(0, groupTable([[CHILD_PID, process.pid]])) : output(KILL_GONE_EXIT_CODE)));
		expect((await ports.killRunMembers()).ok).toBe(true);
	});

	test("killRunMembers: a member kill that cannot start is an error", async () => {
		onHost("linux");
		fakeRunner((command) => (command === "ps" ? output(0, groupTable([[CHILD_PID, process.pid]])) : err("spawn failed")));
		expect((await ports.killRunMembers()).ok).toBe(false);
	});

	test("endSession: a root that ended before its kill (kill exits non-zero) ends the session", async () => {
		onHost("linux");
		let killed = false;
		fakeRunner((command) => {
			if (command === "ps") return output(0, parentTable([[ROOT_PID, 1]]));
			if (command !== "kill") return err("unexpected command");
			killed = true;
			return output(KILL_GONE_EXIT_CODE);
		});
		expect(await endSession(runtimeWith(() => !killed), SESSION)).toEqual(apiOk(true));
	});
});

import { describe, expect, test } from "bun:test";

import { endSession } from "../src/commands/session-stop.js";
import { apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { listSessions, lookupSession, sessionLive } from "../src/session-core.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const ID = "abc";
const START = "2026-01-01T00:00:00Z";
const WINDOW_PID = 100;
const WINDOW_CREATED = "2026-01-01T10:00:00.000000Z";
const HEADLESS_PID = 200;
const HEADLESS_CREATED = "2026-01-01T10:03:00.000000Z";
const record = { session_id: ID, cwd: "/work", transcript_path: "/transcript", config_dir: "", pid_error: null, started_at: START };
const processFile = (pid: number, created: string, startedAt: string) => JSON.stringify({ pid, pid_created: created, started_at: startedAt, source: "startup", config_dir: "" });

// A process table the test edits: pid -> creation time of the process that now runs under it.
const setup = (running: Record<string, string>) => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify(record));
	h.fs.seed("/transcript", "{}");
	h.fs.seed(`${ROOT}/${ID}/usage.json`, "{}");
	const table = new Map(Object.entries(running));
	h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), table.get(String(pid)) ?? null])));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	const killed: number[] = [];
	h.runtime.process.killTree = async (pid) => { killed.push(pid); table.delete(String(pid)); return ok(undefined); };
	return { h, table, killed };
};
const addProcess = (h: ReturnType<typeof setup>["h"], pid: number, created: string, startedAt: string) => h.fs.seed(`${ROOT}/${ID}/processes/${pid}.json`, processFile(pid, created, startedAt));

describe("a session with several Claude processes", () => {
	test("the window stays live after a headless process of the same id started and ended", async () => {
		const { h, killed } = setup({ [String(WINDOW_PID)]: WINDOW_CREATED });
		addProcess(h, WINDOW_PID, WINDOW_CREATED, "2026-01-01T10:00:01Z");
		// The headless process started (its own file) and ended (the hook deleted that file only).
		addProcess(h, HEADLESS_PID, HEADLESS_CREATED, "2026-01-01T10:03:01Z");
		h.fs.files.delete(`${ROOT}/${ID}/processes/${HEADLESS_PID}.json`);
		const session = await lookupSession(h.runtime, ID);
		expect(session.ok).toBe(true);
		if (!session.ok) return;
		expect(await sessionLive(h.runtime, session.value)).toEqual(apiOk(true));
		expect(await endSession(h.runtime, session.value)).toEqual(apiOk(true));
		expect(killed).toEqual([WINDOW_PID]);
	});
	test("stop kills every live process and each is checked against its creation time", async () => {
		const { h, table, killed } = setup({ [String(WINDOW_PID)]: WINDOW_CREATED, [String(HEADLESS_PID)]: HEADLESS_CREATED });
		addProcess(h, WINDOW_PID, WINDOW_CREATED, "2026-01-01T10:00:01Z");
		addProcess(h, HEADLESS_PID, HEADLESS_CREATED, "2026-01-01T10:03:01Z");
		// A third file names a pid since reused by an unrelated process: it is not this session's and must not be killed.
		addProcess(h, 300, "2026-01-01T09:00:00.000000Z", "2026-01-01T09:00:01Z");
		table.set("300", "2026-01-01T11:00:00.000000Z");
		const session = await lookupSession(h.runtime, ID);
		if (!session.ok) throw new Error("lookup failed");
		expect(await endSession(h.runtime, session.value)).toEqual(apiOk(true));
		expect([...killed].sort()).toEqual([WINDOW_PID, HEADLESS_PID].sort());
	});
	test("the session stays live when one process ends while another runs", async () => {
		const { h, table } = setup({ [String(WINDOW_PID)]: WINDOW_CREATED, [String(HEADLESS_PID)]: HEADLESS_CREATED });
		addProcess(h, WINDOW_PID, WINDOW_CREATED, "2026-01-01T10:00:01Z");
		addProcess(h, HEADLESS_PID, HEADLESS_CREATED, "2026-01-01T10:03:01Z");
		table.delete(String(WINDOW_PID));
		const session = await lookupSession(h.runtime, ID);
		if (!session.ok) throw new Error("lookup failed");
		expect(await sessionLive(h.runtime, session.value)).toEqual(apiOk(true));
		const listed = await listSessions(h.runtime);
		expect(listed.ok && listed.value.sessions).toEqual([{ id: ID, cwd: "/work", transcriptPath: "/transcript", pid: HEADLESS_PID, processes: [{ pid: HEADLESS_PID, startedAt: "2026-01-01T10:03:01Z" }], startedAt: START, live: true, module: true, copyOf: null }]);
	});
	test("list shows the earliest started live process as pid and all live ones", async () => {
		const { h } = setup({ [String(WINDOW_PID)]: WINDOW_CREATED, [String(HEADLESS_PID)]: HEADLESS_CREATED });
		// The later-started process has the lower pid: the order comes from creation time, not from the pid.
		addProcess(h, HEADLESS_PID, HEADLESS_CREATED, "2026-01-01T10:03:01Z");
		addProcess(h, WINDOW_PID, WINDOW_CREATED, "2026-01-01T10:00:01Z");
		const listed = await listSessions(h.runtime);
		expect(listed.ok && listed.value.sessions).toEqual([{ id: ID, cwd: "/work", transcriptPath: "/transcript", pid: WINDOW_PID, processes: [{ pid: WINDOW_PID, startedAt: "2026-01-01T10:00:01Z" }, { pid: HEADLESS_PID, startedAt: "2026-01-01T10:03:01Z" }], startedAt: START, live: true, module: true, copyOf: null }]);
	});
	test("a legacy record counts as one process while its identity holds and not after an end", async () => {
		const { h } = setup({ [String(WINDOW_PID)]: WINDOW_CREATED });
		h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ ...record, pid: WINDOW_PID, pid_created: WINDOW_CREATED, ended_at: null }));
		const live = await lookupSession(h.runtime, ID);
		if (!live.ok) throw new Error("lookup failed");
		expect(await sessionLive(h.runtime, live.value)).toEqual(apiOk(true));
		h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ ...record, pid: WINDOW_PID, pid_created: WINDOW_CREATED, ended_at: START }));
		const ended = await lookupSession(h.runtime, ID);
		if (!ended.ok) throw new Error("lookup failed");
		expect(ended.value.processes).toEqual([]);
	});
	test("the hooks' process folder alone does not make the window module present", async () => {
		const { h } = setup({ [String(WINDOW_PID)]: WINDOW_CREATED });
		h.fs.files.delete(`${ROOT}/${ID}/usage.json`);
		addProcess(h, WINDOW_PID, WINDOW_CREATED, "2026-01-01T10:00:01Z");
		const listed = await listSessions(h.runtime);
		expect(listed.ok && listed.value.sessions.map((entry) => "module" in entry && entry.module)).toEqual([false]);
	});
});

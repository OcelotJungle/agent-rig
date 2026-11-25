import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { apiOk } from "../src/output.js";
import { COMPACT_TIMEOUT_MS, lookupSession, listSessions, requestSession, sessionLive, sessionModuleStartedSince, SESSION_POLL_MS } from "../src/session-core.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const CREATED = "2026-01-01T00:00:00.000000Z";
const record: SessionRecord = { id: "abc", cwd: "/work", transcriptPath: "/transcript", copyOf: null, startedAt: "2026-01-01T00:00:00Z", processes: [{ pid: 42, pidCreated: CREATED, startedAt: "2026-01-01T00:00:00Z" }] };
const raw = { session_id: record.id, cwd: record.cwd, transcript_path: record.transcriptPath, started_at: record.startedAt };
const processFile = { pid: 42, pid_created: CREATED, started_at: record.startedAt, source: "startup", config_dir: "" };

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/abc.json`, JSON.stringify(raw));
	h.fs.seed(`${ROOT}/abc/usage.json`, "{}");
	h.fs.seed(`${ROOT}/abc/processes/42.json`, JSON.stringify(processFile));
	h.fs.seed("/transcript", "{}");
	h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), CREATED])));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	return h;
};

describe("session core", () => {
	test("a record removed during a request ends the session", async () => {
		const h = setup();
		h.runtime.clock.sleep = async () => { await h.fs.remove(`${ROOT}/abc.json`); };
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-ended");
	});
	test("rejects unsafe and unknown ids before accessing their paths", async () => {
		const h = setup();
		for (const id of ["../abc", "a/b", "a.b", "x".repeat(65)]) {
			const answer = await lookupSession(h.runtime, id);
			expect(answer.ok ? "ok" : answer.error.code).toBe("session-bad-id");
		}
		expect(h.fs.textReads).toEqual([]);
		const missing = await lookupSession(h.runtime, "missing");
		expect(missing.ok ? "ok" : missing.error.code).toBe("session-unknown");
	});
	test("ended and reused processes are not live", async () => {
		const h = setup();
		expect(await sessionLive(h.runtime, { ...record, processes: [] })).toEqual(apiOk(false));
		h.runtime.process.createdAt = async () => ok({ "42": "different" });
		expect(await sessionLive(h.runtime, record)).toEqual(apiOk(false));
	});
	test("requires the module directory", async () => {
		const h = setup();
		h.fs.files.delete(`${ROOT}/abc/usage.json`);
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-no-module");
	});
	test("reads and removes success and error responses", async () => {
		for (const response of [{ id: "event-1", ok: true, result: { value: 1 } }, { id: "event-1", ok: false, error: "module failed" }]) {
			const h = setup();
			h.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify(response));
			const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS);
			expect(answer.ok).toBe(response.ok);
			if (!answer.ok) expect(answer.error.message).toBe("module failed");
			expect(h.fs.files.has(`${ROOT}/abc/responses/event-1.json`)).toBe(false);
		}
	});
	test("tolerates one partial response and reports waiting", async () => {
		const h = setup();
		const path = `${ROOT}/abc/responses/event-1.json`;
		h.fs.seed(path, "{");
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		h.runtime.clock.sleep = async (ms) => { now += ms; h.fs.seed(path, JSON.stringify({ id: "event-1", ok: true, result: 7 })); };
		expect(await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3)).toEqual(apiOk(7));
	});
	// Progress comes from the claiming module's claims/<id>/state, never from elapsed time.
	const progressWorld = (states: (poll: number) => string | null, answerAtPoll: number) => {
		const h = setup();
		const state = `${ROOT}/abc/claims/event-1/state`;
		let poll = 0;
		const sleep = h.runtime.clock.sleep;
		h.runtime.clock.sleep = async (ms) => {
			await sleep(ms);
			poll++;
			const text = states(poll);
			if (text !== null) h.fs.seed(state, text);
			if (poll >= answerAtPoll) h.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: 1 }));
		};
		const events: string[] = [];
		const run = () => requestSession(h.runtime, record, "compact", {}, COMPACT_TIMEOUT_MS, (event) => events.push(event.code));
		return { events, run, seedFirst: (text: string) => h.fs.seed(state, text) };
	};
	const LONG_OP_POLLS = 8;
	test("an idle session running a long op reports no progress, however long it takes", async () => {
		const w = progressWorld(() => "running", LONG_OP_POLLS);
		w.seedFirst("running");
		expect((await w.run()).ok).toBe(true);
		expect(w.events).toEqual([]);
	});
	test("waiting then running reports each once, in order", async () => {
		const w = progressWorld((poll) => (poll < 4 ? "waiting" : "running"), LONG_OP_POLLS);
		w.seedFirst("waiting");
		expect((await w.run()).ok).toBe(true);
		expect(w.events).toEqual(["session-waiting", "session-running"]);
	});
	test("no state file (a module without it) reports no progress", async () => {
		const w = progressWorld(() => null, LONG_OP_POLLS);
		expect((await w.run()).ok).toBe(true);
		expect(w.events).toEqual([]);
	});
	// Guards one query per poll and reuses the pre-publish identity check at the first poll's same instant.
	test("timeout removes the published request after one query per poll", async () => {
		const h = setup();
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		const calls: number[] = [];
		h.runtime.process.createdAt = async () => { calls.push(now); return ok({ "42": CREATED }); };
		h.runtime.clock.sleep = async (ms) => { now += ms; };
		const events: string[] = [];
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3, (event) => events.push(event.code));
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-timeout");
		expect(calls).toEqual([0, SESSION_POLL_MS, SESSION_POLL_MS * 2, SESSION_POLL_MS * 3]);
		expect(h.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
		expect(events).toEqual([]);
	});
	test("a live session without a transcript makes at most one query per poll", async () => {
		const h = setup();
		h.fs.files.delete("/transcript");
		let now = 0;
		const calls: number[] = [];
		h.runtime.clock.now = () => new Date(now);
		h.runtime.clock.sleep = async (ms) => { now += ms; };
		h.runtime.process.createdAt = async () => { calls.push(now); return ok({ "42": CREATED }); };
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-timeout");
		expect(calls).toEqual([0, SESSION_POLL_MS, SESSION_POLL_MS * 2, SESSION_POLL_MS * 3]);
	});
	// Guards session-ended at the first poll after process death rather than waiting for the deadline.
	test("process exit removes the published request at the first dead-process poll", async () => {
		const h = setup();
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		const calls: number[] = [];
		h.runtime.process.createdAt = async () => { calls.push(now); return ok({ "42": now === 0 ? CREATED : null }); };
		h.runtime.clock.sleep = async (ms) => { now += ms; };
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-ended");
		expect(calls).toEqual([0, SESSION_POLL_MS]);
		expect(h.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
	});
	// A claim as the module leaves it: the directory, and its Claude pid when the module knows it.
	const CLAIMANT = 77;
	const CLAIMANT_CREATED = "2026-01-02T00:00:00.000000Z";
	const LONG_SILENCE_MS = 5 * 60_000;
	const CLAIM_AFTER_CLAIMANT_MS = 1000;
	const claimWorld = (claimantCreated: () => string | null, pidFile: boolean, claimModifiedMs = Date.parse(CLAIMANT_CREATED) + CLAIM_AFTER_CLAIMANT_MS) => {
		const h = setup();
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.flatMap((pid) => {
			if (pid === record.processes[0]?.pid) return [[String(pid), CREATED]];
			const created = claimantCreated();
			return created === null ? [] : [[String(pid), created]];
		})));
		const claim = `${ROOT}/abc/claims/event-1`;
		const sleeps: number[] = [];
		h.runtime.clock.sleep = async (ms) => {
			now += ms;
			sleeps.push(now);
			h.fs.directories.add(claim);
			h.fs.mtimes.set(claim, claimModifiedMs);
			if (pidFile) h.fs.seed(`${claim}/pid`, String(CLAIMANT));
		};
		return { h, claim, sleeps, now: () => now };
	};
	test("a claimant whose process is gone fails the wait at once, and the claim is removed", async () => {
		const w = claimWorld(() => null, true);
		const answer = await requestSession(w.h.runtime, record, "compact", {}, LONG_SILENCE_MS * 2);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-claim-lost");
		expect(w.now()).toBeLessThanOrEqual(2 * SESSION_POLL_MS);
		expect(w.h.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
		expect(w.h.fs.directories.has(w.claim)).toBe(false);
	});
	test("a claimant silent for minutes is still waited on while its process lives", async () => {
		const w = claimWorld(() => CLAIMANT_CREATED, true);
		const sleep = w.h.runtime.clock.sleep;
		w.h.runtime.clock.sleep = async (ms) => {
			await sleep(ms);
			if (w.now() >= LONG_SILENCE_MS) w.h.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: 1 }));
		};
		const answer = await requestSession(w.h.runtime, record, "compact", {}, LONG_SILENCE_MS * 2);
		expect(answer.ok ? "ok" : answer.error.code).toBe("ok");
		expect(w.now()).toBeGreaterThanOrEqual(LONG_SILENCE_MS);
		expect(w.h.fs.directories.has(w.claim)).toBe(false);
	});
	test("a claimant pid reused by another process (other creation time) is lost", async () => {
		let created = CLAIMANT_CREATED;
		const w = claimWorld(() => created, true);
		const sleep = w.h.runtime.clock.sleep;
		w.h.runtime.clock.sleep = async (ms) => {
			await sleep(ms);
			if (w.now() >= 3 * SESSION_POLL_MS) created = "2026-01-03T00:00:00.000000Z";
		};
		const answer = await requestSession(w.h.runtime, record, "compact", {}, LONG_SILENCE_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-claim-lost");
		expect(w.now()).toBeLessThanOrEqual(4 * SESSION_POLL_MS);
	});
	test("a process created after its claim directory is not the claimant (its pid was reused before rig read it)", async () => {
		const w = claimWorld(() => CLAIMANT_CREATED, true, Date.parse(CLAIMANT_CREATED) - CLAIM_AFTER_CLAIMANT_MS);
		const answer = await requestSession(w.h.runtime, record, "compact", {}, LONG_SILENCE_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-claim-lost");
		expect(w.now()).toBeLessThanOrEqual(2 * SESSION_POLL_MS);
	});
	test("a claim with no pid file is waited on until the request's own timeout", async () => {
		const w = claimWorld(() => null, false);
		const answer = await requestSession(w.h.runtime, record, "compact", {}, LONG_SILENCE_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-timeout");
		expect(w.now()).toBe(LONG_SILENCE_MS);
	});
	// The state file the module keeps in a claim directory, written at the first sleep (after rig published the request).
	const claimWithState = (state: string) => {
		const w = claimWorld(() => null, false);
		const sleep = w.h.runtime.clock.sleep;
		w.h.runtime.clock.sleep = async (ms) => {
			await sleep(ms);
			w.h.fs.seed(`${w.claim}/state`, state);
		};
		return w;
	};
	test("a request the module began (claim state running) that runs out of time is session-timeout-running, not session-timeout", async () => {
		const w = claimWithState("running");
		const answer = await requestSession(w.h.runtime, record, "compact", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-timeout-running");
		expect(w.h.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
	});
	test("a request the module claimed but did not begin (claim state waiting) that runs out of time is session-timeout", async () => {
		const w = claimWithState("waiting");
		const answer = await requestSession(w.h.runtime, record, "compact", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-timeout");
	});
	describe("the module of this process is up (usage snapshot written at or after a moment)", () => {
		const SINCE = 5000;
		const usagePath = `${ROOT}/abc/usage.json`;
		const started = async (h: ReturnType<typeof setup>) => sessionModuleStartedSince(h.runtime, record, SINCE);
		test("a snapshot older than the moment is a previous process's leftover", async () => {
			const h = setup();
			h.fs.mtimes.set(usagePath, SINCE - 1);
			expect(await started(h)).toEqual(apiOk(false));
		});
		test("a snapshot written at the moment or later counts", async () => {
			const h = setup();
			h.fs.mtimes.set(usagePath, SINCE);
			expect(await started(h)).toEqual(apiOk(true));
			h.fs.mtimes.set(usagePath, SINCE + 1);
			expect(await started(h)).toEqual(apiOk(true));
		});
		test("no snapshot means no module", async () => {
			const h = setup();
			h.fs.files.delete(usagePath);
			expect(await started(h)).toEqual(apiOk(false));
		});
	});
	// Guards that no query runs once removed files leave no checkable process.
	test("removed process files stop waiting without another process query", async () => {
		const h = setup();
		let calls = 0;
		h.runtime.process.createdAt = async () => { calls++; return ok({ "42": CREATED }); };
		h.runtime.clock.sleep = async () => { h.fs.files.delete(`${ROOT}/abc/processes/42.json`); };
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-ended");
		expect(calls).toBe(1);
	});
	test("a claimant and live session share one creation-time query", async () => {
		const h = setup();
		const calls: number[][] = [];
		h.runtime.process.createdAt = async (pids) => {
			calls.push([...pids]);
			return ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === 42 ? CREATED : CLAIMANT_CREATED])));
		};
		let poll = 0;
		h.runtime.clock.sleep = async (ms) => {
			poll++;
			h.fs.directories.add(`${ROOT}/abc/claims/event-1`);
			// The claimant existed before it made its claim directory (otherwise rig reads the pid as reused).
			h.fs.mtimes.set(`${ROOT}/abc/claims/event-1`, Date.parse(CLAIMANT_CREATED) + CLAIM_AFTER_CLAIMANT_MS);
			h.fs.seed(`${ROOT}/abc/claims/event-1/pid`, String(CLAIMANT));
			if (poll === 2) h.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: 1 }));
		};
		const answer = await requestSession(h.runtime, record, "compact", {}, SESSION_POLL_MS * 4);
		expect(answer).toEqual(apiOk(1));
		expect(calls).toEqual([[42], [42, CLAIMANT]]);
	});
	test("a dead claimed session ends after one poll when its process file remains", async () => {
		const h = setup();
		let alive = true;
		let polls = 0;
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		h.runtime.process.createdAt = async () => ok({ "42": alive ? CREATED : null });
		h.fs.seed(`${ROOT}/abc/claims/event-1/state`, "running");
		h.runtime.clock.sleep = async (ms) => {
			now += ms;
			polls++;
			alive = false;
		};
		const answer = await requestSession(h.runtime, record, "compact", {}, COMPACT_TIMEOUT_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-ended");
		expect(polls).toBe(1);
		expect(now).toBe(SESSION_POLL_MS);
		expect(h.fs.files.has(`${ROOT}/abc/processes/42.json`)).toBe(true);
		expect(h.fs.files.has(`${ROOT}/abc/claims/event-1/pid`)).toBe(false);
	});
	test("a dead window that claimed the request ends the session", async () => {
		const h = setup();
		let alive = true;
		let polls = 0;
		h.fs.seed(`${ROOT}/abc/claims/event-1/pid`, "42");
		h.fs.mtimes.set(`${ROOT}/abc/claims/event-1`, Date.parse(CREATED) + CLAIM_AFTER_CLAIMANT_MS);
		h.runtime.process.createdAt = async () => ok({ "42": alive ? CREATED : null });
		h.runtime.clock.sleep = async () => { polls++; alive = false; };
		const answer = await requestSession(h.runtime, record, "compact", {}, COMPACT_TIMEOUT_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-ended");
		expect(polls).toBe(1);
	});
	test("list batches distinct live pids and isolates invalid records", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/second.json`, JSON.stringify({ ...raw, session_id: "second" }));
		h.fs.seed(`${ROOT}/second/processes/43.json`, JSON.stringify({ ...processFile, pid: 43 }));
		h.fs.seed(`${ROOT}/broken.json`, "{");
		const calls: number[][] = [];
		h.runtime.process.createdAt = async (pids) => { calls.push([...pids]); return ok({ "42": CREATED, "43": CREATED }); };
		const result = await listSessions(h.runtime);
		expect(calls).toHaveLength(1);
		expect(new Set(calls[0])).toEqual(new Set([42, 43]));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.sessions).toHaveLength(3);
			expect(result.value.sessions.find((entry) => entry.id === "broken")).toEqual({ id: "broken", error: { code: "session-invalid", message: expect.any(String) } });
			expect(result.value.sessions.filter((entry) => "live" in entry && entry.live)).toHaveLength(2);
		}
	});
	test("list returns raw fields in newest order and CLI emits one object", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/older.json`, JSON.stringify({ ...raw, session_id: "older", started_at: "2025-01-01T00:00:00Z" }));
		const result = await listSessions(h.runtime);
		expect(result).toEqual(apiOk({ sessions: [{ id: "abc", cwd: "/work", transcriptPath: "/transcript", pid: 42, processes: [{ pid: 42, startedAt: record.startedAt }], startedAt: record.startedAt, live: true, module: true, copyOf: null }, { id: "older", cwd: "/work", transcriptPath: "/transcript", pid: null, processes: [], startedAt: "2025-01-01T00:00:00Z", live: false, module: false, copyOf: null }] }));
		const output: string[] = [];
		expect(await runCli(["session", "list"], (line) => output.push(line), h.runtime)).toBe(0);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toEqual(result.ok ? result.value : null);
	});
});

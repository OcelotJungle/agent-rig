import type { RuntimePorts } from "../src/ports.js";
import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { messagesFor } from "../src/messages.js";
import { cleanupSession } from "../src/commands/session-cleanup.js";
import { launchRegistrationDeadline, LAUNCH_REGISTRATION_WAIT_MS, modeCommand } from "../src/commands/session-run.js";
import { stopSession } from "../src/commands/session-stop.js";
import { apiFail, apiOk, SESSION_IO } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { withSessionEnding } from "../src/session-ending.js";
import { SESSION_POLL_MS } from "../src/session-core.js";
import { createMemoryRuntime, FAKE_OWNER_CREATED } from "./fakes/memory-runtime.js";
import { DEFAULT_LOGIN, ownerLine, seedDefaultLogin } from "./fakes/session-owner-fixture.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const DIRECTORY = `${ROOT}/sessions/${ID}`;
const MARKER = `${DIRECTORY}/ending.json`;
const GUARD = `${ROOT}/sessions/${ID}.ending.lock`;
const TRANSCRIPT = `/transcripts/${ID}.jsonl`;
// Invented identities for the session's two process trees and independent rig callers.
const CLAUDE_PID = 42;
const WINDOW_PID = 43;
const OTHER_OWNER_PID = 11;
const THIRD_OWNER_PID = 12;
const LAUNCHED_PID = 44;
const CLAUDE_CREATED = "claude-creation";
const OTHER_OWNER_CREATED = "other-rig-creation";
const THIRD_OWNER_CREATED = "third-rig-creation";
const LAUNCHED_CREATED = "resumed-claude-creation";
// The incident's usage, above rig's 120,000-token stop threshold; a successful compact shrinks it.
const TOKENS_BEFORE = 164_000;
const TOKENS_AFTER = 80_000;
// The transcript opens with the owner line of the default login, so a launch finds nothing to switch.
const SKILLS = `${ownerLine(DEFAULT_LOGIN, ID)}\n` + '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"sample","content":"invented"}]}}\n';
const SESSION: SessionRecord = { id: ID, cwd: "/work", transcriptPath: TRANSCRIPT, copyOf: null, startedAt: "start", processes: [CLAUDE_PID, WINDOW_PID].map((pid) => ({ pid, pidCreated: CLAUDE_CREATED, startedAt: "start" })) };
const code = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;
const gate = () => {
	let open = () => {};
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
};

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ session_id: ID, cwd: SESSION.cwd, transcript_path: TRANSCRIPT, started_at: "start", config_dir: "" }));
	h.fs.seed(`${DIRECTORY}/usage.json`, "{}");
	for (const process of SESSION.processes) h.fs.seed(`${DIRECTORY}/processes/${process.pid}.json`, JSON.stringify({ pid: process.pid, pid_created: process.pidCreated, started_at: process.startedAt }));
	h.fs.seed(TRANSCRIPT, SKILLS);
	seedDefaultLogin(h);
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.fs.directories.add("/work");
	h.fs.seed("/usr/bin/tmux", "");
	const identities: Record<string, string | null> = {
		[String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED,
		[String(OTHER_OWNER_PID)]: OTHER_OWNER_CREATED,
		[String(THIRD_OWNER_PID)]: THIRD_OWNER_CREATED,
		[String(CLAUDE_PID)]: CLAUDE_CREATED,
		[String(WINDOW_PID)]: CLAUDE_CREATED,
	};
	h.runtime.process.createdAt = async () => ok({ ...identities });
	const killed: number[] = [];
	const markersAtKill: unknown[] = [];
	h.runtime.process.killTree = async (pid) => {
		const marker = h.fs.files.get(MARKER);
		if (marker !== undefined) markersAtKill.push(JSON.parse(marker));
		killed.push(pid);
		identities[String(pid)] = null;
		// The exit hook removes the corresponding process record.
		h.fs.files.delete(`${DIRECTORY}/processes/${pid}.json`);
		return ok(undefined);
	};
	const requests: string[] = [];
	const rename = h.fs.rename.bind(h.fs);
	h.fs.rename = async (from, to) => {
		if (to.startsWith(`${DIRECTORY}/requests/`) && to.endsWith(".json")) {
			const request: unknown = JSON.parse(await h.fs.readText(from));
			if (typeof request === "object" && request !== null && "op" in request && typeof request.op === "string") requests.push(request.op);
		}
		await rename(from, to);
	};
	let now = 0;
	const advance = async (ms: number) => { now += ms; };
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = advance;
	const caller = (pid = OTHER_OWNER_PID): RuntimePorts => ({ ...h.runtime, clock: { ...h.runtime.clock, sleep: advance }, lock: { ...h.runtime.lock, process: { ...h.runtime.lock.process, pid } } });
	const response = (id: string, result: unknown) => h.fs.seed(`${DIRECTORY}/responses/${id}.json`, JSON.stringify({ id, ok: true, result }));
	const pause = () => {
		const waiting = gate();
		const resume = gate();
		h.runtime.clock.sleep = async (ms) => { waiting.open(); await resume.promise; await advance(ms); };
		return { waiting: waiting.promise, resume: resume.open };
	};
	const pauseCaller = (pid = OTHER_OWNER_PID) => {
		const runtime = caller(pid);
		const waiting = gate();
		const resume = gate();
		const advance = runtime.clock.sleep;
		runtime.clock.sleep = async (ms) => { waiting.open(); await resume.promise; await advance(ms); };
		return { runtime, waiting: waiting.promise, resume: resume.open };
	};
	return { ...h, identities, killed, markersAtKill, requests, caller, response, pause, pauseCaller };
};

describe("session ending ownership", () => {
	for (const operation of ["stop", "cleanup", "mode"] as const) {
		test(`a second stop kills both process trees during ${operation}, without usage or compaction`, async () => {
			const h = setup();
			let launches = 0;
			h.runtime.process.spawnDetached = async () => { launches += 1; return ok({ exited: false, exitCode: null, stderr: "" }); };
			if (operation !== "cleanup") h.response("event-1", { context: { tokens: TOKENS_BEFORE } });
			const paused = h.pause();
			const first = operation === "stop" ? stopSession(h.runtime, SESSION, () => {}) : operation === "cleanup" ? cleanupSession(h.runtime, SESSION, () => {}) : modeCommand(h.runtime, [ID, "auto"], () => {});
			await paused.waiting;
			const before = [...h.requests];
			const second = h.pauseCaller();
			const stopping = stopSession(second.runtime, SESSION, () => {});
			try {
				expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
				expect(h.requests).toEqual(before);
				expect(h.killed).toEqual([CLAUDE_PID, WINDOW_PID]);
				expect(h.markersAtKill[0]).toMatchObject({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, takenOver: true });
				paused.resume();
				await first;
				expect(await h.fs.stat(MARKER)).not.toBeNull();
			} finally { paused.resume(); second.resume(); await Promise.allSettled([first, stopping]); }
			expect(await stopping).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			const result = await first;
			expect(code(result)).toBe(operation === "cleanup" ? "session-ended" : operation === "mode" ? "session-ending" : "ok");
			if (operation === "stop") expect(result).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running", compacted: { error: messagesFor(h.runtime.language).session.ended() } } as const));
			expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
			expect((await h.fs.listDirectory("/transcripts")).map((entry) => entry.name)).toEqual([`${ID}.jsonl`]);
			expect(launches).toBe(0);
			expect(await h.fs.stat(MARKER)).toBeNull();
		});
	}

	for (const operation of ["stop", "cleanup"] as const) {
		test(`${operation} ends processes registered during compaction`, async () => {
			const h = setup();
			if (operation === "stop") h.response("event-1", { context: { tokens: TOKENS_BEFORE } });
			const paused = h.pause();
			const ending = operation === "stop" ? stopSession(h.runtime, SESSION, () => {}) : cleanupSession(h.runtime, SESSION, () => {});
			try {
				await paused.waiting;
				h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
				h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "start" }));
				h.response(operation === "stop" ? "event-2" : "event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
			} finally { paused.resume(); }
			expect(code(await ending)).toBe("ok");
			expect(h.killed).toContain(LAUNCHED_PID);
		});
		test(`${operation} handles a record removed during compaction`, async () => {
			const h = setup();
			if (operation === "stop") h.response("event-1", { context: { tokens: TOKENS_BEFORE } });
			const paused = h.pause();
			const ending = operation === "stop" ? stopSession(h.runtime, SESSION, () => {}) : cleanupSession(h.runtime, SESSION, () => {});
			try {
				await paused.waiting;
				h.fs.files.delete(`${ROOT}/sessions/${ID}.json`);
				for (const process of SESSION.processes) h.fs.files.delete(`${DIRECTORY}/processes/${process.pid}.json`);
				h.response(operation === "stop" ? "event-2" : "event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
			} finally { paused.resume(); }
			const result = await ending;
			if (operation === "stop") expect(result).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running", compacted: { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER } } as const));
			else expect(code(result)).toBe("session-ended");
			expect(h.killed).toEqual([]);
		});
	}

	test("a takeover accepts a vanished session record", async () => {
		const h = setup();
		h.fs.seed(MARKER, JSON.stringify({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, token: "owner", takenOver: false, otherOwners: [] }));
		h.runtime.clock.sleep = async () => { h.identities[String(OTHER_OWNER_PID)] = null; };
		h.fs.files.delete(`${ROOT}/sessions/${ID}.json`);
		expect(await stopSession(h.runtime, SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
	});

	test("a takeover after mode's stop but before spawn still prevents relaunch", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const entered = gate();
		const resume = gate();
		const ensure = h.fs.ensureDirectory.bind(h.fs);
		h.fs.ensureDirectory = async (path) => {
			if (path.endsWith("/launch-stderr")) { entered.open(); await resume.promise; }
			await ensure(path);
		};
		let launches = 0;
		h.runtime.process.spawnDetached = async () => { launches += 1; return ok({ exited: false, exitCode: null, stderr: "" }); };
		const first = modeCommand(h.runtime, [ID, "auto"], () => {});
		const second = h.pauseCaller();
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await entered.promise;
			stopping = stopSession(second.runtime, SESSION, () => {});
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			resume.open();
			await first;
		} finally { resume.open(); second.resume(); await Promise.allSettled([first, stopping]); }
		expect(await stopping).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
		expect(code(await first)).toBe("session-ending");
		expect(launches).toBe(0);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("a takeover polls fresh records and kills a window registered during mode's launch", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const paused = h.pause();
		h.runtime.process.spawnDetached = async () => ok({ exited: false, exitCode: null, stderr: "" });
		const killed = gate();
		const kill = h.runtime.process.killTree;
		h.runtime.process.killTree = async (pid) => { const result = await kill(pid); if (pid === LAUNCHED_PID) killed.open(); return result; };
		const first = modeCommand(h.runtime, [ID, "auto"], () => {});
		await paused.waiting;
		const second = h.pauseCaller();
		const events: string[] = [];
		const stopping = stopSession(second.runtime, SESSION, (event) => events.push(event.code));
		try {
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			expect(events).toEqual([]);
			h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
			h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			second.resume();
			await killed.promise;
			expect(events).toEqual(["session-terminating"]);
		} finally { paused.resume(); second.resume(); await Promise.allSettled([first, stopping]); }
		expect(code(await first)).toBe("session-ending");
		expect(await stopping).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
		expect(h.identities[String(LAUNCHED_PID)]).toBeNull();
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("a takeover's final kill looks up processes registered while observing the owner's release", async () => {
		const h = setup();
		const entered = gate();
		const resume = gate();
		const owner = withSessionEnding(h.runtime, ID, async () => { entered.open(); await resume.promise; return apiOk(null); });
		await entered.promise;
		const second = h.pauseCaller();
		const stopping = stopSession(second.runtime, SESSION, () => {});
		try {
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			resume.open();
			await owner;
			const read = h.fs.readText.bind(h.fs);
			let registered = false;
			h.fs.readText = async (path) => {
				const text = await read(path);
				if (path === MARKER && !registered) {
					registered = true;
					h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
					h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
				}
				return text;
			};
			second.resume();
			expect(await stopping).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			expect(h.killed).toEqual([CLAUDE_PID, WINDOW_PID, LAUNCHED_PID]);
			expect(h.identities[String(LAUNCHED_PID)]).toBeNull();
		} finally { resume.open(); second.resume(); await Promise.allSettled([owner, stopping]); }
	});

	test("mode kills a window registered before its interrupted launch reports failure", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const entered = gate();
		const resume = gate();
		h.runtime.process.spawnDetached = async () => {
			entered.open();
			await resume.promise;
			h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
			h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			return err("launch failed");
		};
		const first = modeCommand(h.runtime, [ID, "auto"], () => {});
		const second = h.pauseCaller();
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await entered.promise;
			stopping = stopSession(second.runtime, SESSION, () => {});
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			resume.open();
			expect(code(await first)).toBe("session-ending");
			expect(h.identities[String(LAUNCHED_PID)]).toBeNull();
		} finally { resume.open(); second.resume(); await Promise.allSettled([first, stopping]); }
		expect(await stopping).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
	});

	test("cleanup retries its edit without a guard, while a takeover waits for its release", async () => {
		const h = setup();
		h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
		const paused = h.pause();
		const rename = h.fs.rename.bind(h.fs);
		let locked = true;
		h.fs.rename = async (from, to) => {
			if (to === TRANSCRIPT && locked) { locked = false; throw Object.assign(new Error("locked transcript"), { code: "EBUSY" }); }
			await rename(from, to);
		};
		const first = cleanupSession(h.runtime, SESSION, () => {});
		const second = h.pauseCaller();
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await paused.waiting;
			expect(await h.fs.stat(GUARD)).toBeNull();
			expect(await h.fs.stat(`${MARKER}.lock`)).toBeNull();
			stopping = stopSession(second.runtime, SESSION, () => {});
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ takenOver: true });
			expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
			paused.resume();
			expect(code(await first)).toBe("ok");
		} finally { paused.resume(); second.resume(); await Promise.allSettled([first, stopping]); }
		expect(await stopping).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
		expect(await h.fs.readText(TRANSCRIPT)).not.toBe(SKILLS);
	});

	test("a stop waiting for process exit leaves cleanup, mode and another stop responsive", async () => {
		const h = setup();
		const entered = gate();
		const resumeOwner = gate();
		const owner = withSessionEnding(h.runtime, ID, async () => { entered.open(); await resumeOwner.promise; return apiOk(null); });
		await entered.promise;
		const waiting = gate();
		const resumeStop = gate();
		const second = h.caller();
		const kill = h.runtime.process.killTree;
		h.runtime.process.killTree = async () => ok(undefined);
		second.clock.sleep = async () => { waiting.open(); await resumeStop.promise; };
		const stopping = stopSession(second, SESSION, () => {});
		try {
			await waiting.promise;
			resumeOwner.open();
			expect((await owner).ok).toBe(true);
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ pid: OTHER_OWNER_PID, takenOver: true });
			expect(code(await cleanupSession(h.caller(THIRD_OWNER_PID), SESSION, () => {}))).toBe("session-ending");
			expect(code(await modeCommand(h.caller(THIRD_OWNER_PID), [ID, "auto"], () => {}))).toBe("session-ending");
			h.runtime.process.killTree = kill;
			const third = h.pauseCaller(THIRD_OWNER_PID);
			const last = stopSession(third.runtime, SESSION, () => {});
			try {
				expect(await Promise.race([third.waiting.then(() => "waiting"), last.then(() => "finished")])).toBe("waiting");
				resumeStop.open();
				await stopping;
			} finally { third.resume(); resumeStop.open(); await last; }
			expect(await last).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			expect(h.requests).toEqual([]);
		} finally { resumeOwner.open(); resumeStop.open(); }
		expect(code(await stopping)).toBe("ok");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("mode holds ownership through a successful relaunch and then releases it", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		h.runtime.process.spawnDetached = async () => {
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ pid: h.runtime.lock.process.pid, takenOver: false, launch: { registrationDeadline: launchRegistrationDeadline(h.runtime.clock.now().getTime()) } });
			h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
			h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			return ok({ exited: false, exitCode: null, stderr: "", pid: LAUNCHED_PID });
		};
		expect(await modeCommand(h.runtime, [ID, "auto"], () => {})).toEqual(apiOk({ session: ID, mode: "auto", pid: LAUNCHED_PID, ownerSwitch: "unchanged" }));
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("a takeover after mode's last check is reported atomically at release", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const checked = gate();
		const resume = gate();
		let launched = false;
		let lastCheck = false;
		let paused = false;
		const read = h.fs.readText.bind(h.fs);
		h.fs.readText = async (path) => {
			const value = await read(path);
			if (path === MARKER && launched) lastCheck = true;
			return value;
		};
		const remove = h.fs.remove.bind(h.fs);
		h.fs.remove = async (path) => {
			await remove(path);
			// Pause after unlocking the last check, before its result reaches mode and release starts.
			if ((path === GUARD || path === `${MARKER}.lock`) && lastCheck && !paused) { paused = true; checked.open(); await resume.promise; }
		};
		h.runtime.process.spawnDetached = async () => {
			launched = true;
			h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
			h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			return ok({ exited: false, exitCode: null, stderr: "", pid: LAUNCHED_PID });
		};
		const first = modeCommand(h.runtime, [ID, "auto"], () => {});
		const second = h.pauseCaller();
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await checked.promise;
			stopping = stopSession(second.runtime, SESSION, () => {});
			await Promise.race([second.waiting, stopping]);
			expect(h.identities[String(LAUNCHED_PID)]).toBeNull();
			resume.open();
			expect(code(await first)).toBe("session-ending");
		} finally { resume.open(); second.resume(); await Promise.allSettled([first, stopping]); }
		expect(await stopping).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	for (const identity of [null, "reused-owner-creation"]) test(`a waiting stop finishes when the interrupted owner's identity becomes ${identity}`, async () => {
		const h = setup();
		const entered = gate();
		const resume = gate();
		const owner = withSessionEnding(h.runtime, ID, async () => { entered.open(); await resume.promise; return apiOk(null); });
		await entered.promise;
		const second = h.pauseCaller();
		const stopping = stopSession(second.runtime, SESSION, () => {});
		try {
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			h.identities[String(h.runtime.lock.process.pid)] = identity;
			second.resume();
			expect(await stopping).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			// A later ending discards the dead identity without waiting for its abandoned action.
			expect(code(await withSessionEnding(h.caller(THIRD_OWNER_PID), ID, async () => apiOk(null)))).toBe("ok");
		} finally { resume.open(); second.resume(); await Promise.allSettled([owner, stopping]); }
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("the relocated guard recovers a dead lock and removes it on release", async () => {
		const h = setup();
		h.fs.seed(GUARD, JSON.stringify({ pid: OTHER_OWNER_PID, startTime: h.runtime.lock.process.startTime }));
		h.runtime.lock.process.ownerStartTime = async (pid) => ok(pid === OTHER_OWNER_PID ? null : h.runtime.lock.process.startTime);
		expect(code(await withSessionEnding(h.runtime, ID, async () => apiOk(null)))).toBe("ok");
		expect(await h.fs.stat(GUARD)).toBeNull();
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	for (const identity of [null, "reused-launch-owner"]) {
		for (const registration of ["before-deadline", "at-deadline", "absent"] as const) {
			test(`a stop covers an in-flight launch with owner identity ${identity} and registration ${registration}`, async () => {
				const h = setup();
				h.fs.files.delete(TRANSCRIPT);
				h.identities[String(h.runtime.lock.process.pid)] = identity;
				h.fs.seed(MARKER, JSON.stringify({ pid: h.runtime.lock.process.pid, pidCreated: FAKE_OWNER_CREATED, token: "launching", launch: { registrationDeadline: LAUNCH_REGISTRATION_WAIT_MS }, takenOver: false, otherOwners: [] }));
				const stopping = h.caller();
				const advance = stopping.clock.sleep;
				const registrationAt = registration === "before-deadline" ? LAUNCH_REGISTRATION_WAIT_MS - SESSION_POLL_MS : LAUNCH_REGISTRATION_WAIT_MS;
				let registered = false;
				const queries = { count: 0 };
				let polls = 0;
				const read = h.fs.readText.bind(h.fs);
				h.fs.readText = async (path) => {
					if (path === `${ROOT}/sessions/${ID}.json`) {
						if (polls > 0) expect(queries.count).toBe(1);
						queries.count = 0;
						polls += 1;
					}
					return read(path);
				};
				const createdAt = h.runtime.process.createdAt;
				h.runtime.process.createdAt = async (pids) => {
					if (polls > 0) queries.count += 1;
					return createdAt(pids);
				};
				stopping.clock.sleep = async (ms) => {
					await advance(ms);
					if (!registered && registration !== "absent" && stopping.clock.now().getTime() >= registrationAt) {
						registered = true;
						h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
						h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
					}
				};
				expect(await stopSession(stopping, SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
				expect(queries.count).toBe(1);
				expect(polls).toBeGreaterThan(LAUNCH_REGISTRATION_WAIT_MS / SESSION_POLL_MS);
				expect(stopping.clock.now().getTime()).toBeGreaterThanOrEqual(LAUNCH_REGISTRATION_WAIT_MS);
				expect(stopping.clock.now().getTime()).toBeLessThanOrEqual(LAUNCH_REGISTRATION_WAIT_MS + SESSION_POLL_MS);
				expect(h.killed).toEqual(registration === "absent" ? [CLAUDE_PID, WINDOW_PID] : [CLAUDE_PID, WINDOW_PID, LAUNCHED_PID]);
				expect(h.requests).toEqual([]);
			});
		}
	}

	test("a mode owner dying after spawn cannot release a waiting stop before late registration", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const paused = h.pause();
		h.runtime.process.spawnDetached = async () => ok({ exited: false, exitCode: null, stderr: "" });
		const mode = modeCommand(h.runtime, [ID, "auto"], () => {});
		await paused.waiting;
		const stopping = h.caller();
		const advance = stopping.clock.sleep;
		let registered = false;
		stopping.clock.sleep = async (ms) => {
			h.identities[String(h.runtime.lock.process.pid)] = null;
			await advance(ms);
			if (!registered && stopping.clock.now().getTime() >= LAUNCH_REGISTRATION_WAIT_MS + SESSION_POLL_MS) {
				registered = true;
				h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
				h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			}
		};
		try {
			expect(await stopSession(stopping, SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			expect(registered).toBe(true);
			expect(h.identities[String(LAUNCHED_PID)]).toBeNull();
		} finally { paused.resume(); await mode; }
		expect(code(await mode)).toBe("session-ending");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("a launch step that stays comes back declined with its outcome: no launch is recorded in the marker and the action does not run", async () => {
		const h = setup();
		let started = 0;
		let markerAtStay = "";
		const result = await withSessionEnding(h.runtime, ID, async (ending) => {
			const stayed = await ending.startLaunch(async () => apiOk({ kind: "stay" as const, outcome: "held" }), () => { started += 1; return "spawned"; }, () => 5);
			markerAtStay = await h.fs.readText(MARKER);
			// The marker is still ours: a later launch whose step goes on is recorded and started.
			const went = await ending.startLaunch(async () => apiOk({ kind: "go" as const, decision: "written" }), (deadline, decision) => { started += 1; return `${decision}@${deadline}`; }, () => 7);
			return apiOk({ stayed, went });
		});
		expect(result).toEqual(apiOk({ stayed: apiOk({ kind: "declined", outcome: "held" }), went: apiOk({ kind: "started", started: "written@7" }) }));
		expect(markerAtStay).not.toContain("registrationDeadline");
		expect(started).toBe(1);
	});
	test("a stop that took the marker over wins over a launch step that stays", async () => {
		const h = setup();
		let stepped = 0;
		const result = await withSessionEnding(h.runtime, ID, async (ending) => {
			h.fs.seed(MARKER, JSON.stringify({ ...JSON.parse(await h.fs.readText(MARKER)), takenOver: true }));
			return ending.startLaunch(async () => { stepped += 1; return apiOk({ kind: "stay" as const, outcome: "held" }); }, () => "spawned", () => 5);
		});
		expect(code(result)).toBe("session-ending");
		expect(stepped).toBe(0);
	});

	test("a failed launch-marker publication prevents spawn", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => { if (to === MARKER) throw new Error("marker write failed"); await rename(from, to); };
		let launches = 0;
		h.runtime.process.spawnDetached = async () => { launches += 1; return ok({ exited: false, exitCode: null, stderr: "" }); };
		expect(code(await modeCommand(h.runtime, [ID, "auto"], () => {}))).toBe("session-io");
		expect(launches).toBe(0);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	for (const takeover of [false, true]) test(`cleanup leaves the transcript untouched when its kill finds nothing live${takeover ? " after takeover" : " after another termination"}`, async () => {
		const h = setup();
		h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
		const entered = gate();
		const resume = gate();
		let terminating = false;
		let paused = false;
		const createdAt = h.runtime.process.createdAt;
		h.runtime.process.createdAt = async (pids) => {
			if (terminating && !paused) { paused = true; entered.open(); await resume.promise; }
			return createdAt(pids);
		};
		const first = cleanupSession(h.runtime, SESSION, (event) => { if (event.code === "session-terminating") terminating = true; });
		const second = h.pauseCaller();
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await entered.promise;
			if (takeover) {
				stopping = stopSession(second.runtime, SESSION, () => {});
				await Promise.race([second.waiting, stopping]);
			} else {
				for (const process of SESSION.processes) await h.runtime.process.killTree(process.pid);
			}
			resume.open();
			expect(code(await first)).toBe("session-ended");
			expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
			expect((await h.fs.listDirectory("/transcripts")).map((entry) => entry.name)).toEqual([`${ID}.jsonl`]);
		} finally { resume.open(); second.resume(); await Promise.allSettled([first, stopping]); }
	});

	test("a failed interrupting kill cannot release the still-compacting owner's marker", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_BEFORE } });
		const paused = h.pause();
		const first = stopSession(h.runtime, SESSION, () => {});
		try {
			await paused.waiting;
			h.runtime.process.killTree = async () => err("kill failed");
			expect(code(await stopSession(h.caller(), SESSION, () => {}))).toBe("session-io");
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ pid: h.runtime.lock.process.pid, takenOver: true });
			expect(code(await cleanupSession(h.caller(), SESSION, () => {}))).toBe("session-ending");
			expect(h.requests).toEqual(["usage", "compact"]);
		} finally {
			h.fs.seed(`${DIRECTORY}/responses/event-2.json`, JSON.stringify({ id: "event-2", ok: false, error: "compact abandoned" }));
			paused.resume();
		}
		expect(code(await first)).toBe("session-io");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("cleanup leaves the transcript intact even if a compact reply arrives after takeover", async () => {
		const h = setup();
		const paused = h.pause();
		const first = cleanupSession(h.runtime, SESSION, () => {});
		const second = h.pauseCaller();
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await paused.waiting;
			stopping = stopSession(second.runtime, SESSION, () => {});
			expect(await Promise.race([second.waiting.then(() => "waiting"), stopping.then(() => "finished")])).toBe("waiting");
			h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
			paused.resume();
			await first;
		} finally { paused.resume(); second.resume(); await Promise.allSettled([first, stopping]); }
		expect(code(await first)).toBe("session-ended");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
		expect((await h.fs.listDirectory("/transcripts")).map((entry) => entry.name)).toEqual([`${ID}.jsonl`]);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("cleanup and mode entry points reject a live marker with one JSON error", async () => {
		const h = setup();
		const entered = gate();
		const resume = gate();
		const first = withSessionEnding(h.runtime, ID, async () => { entered.open(); await resume.promise; return apiOk(null); });
		try {
			await entered.promise;
			for (const args of [["cleanup", ID], ["mode", ID, "auto"], ["mode", ID, "plan"]]) {
				if (args.at(-1) === "plan") h.fs.seed(TRANSCRIPT, JSON.stringify({ type: "permission-mode", permissionMode: "plan" }));
				const lines: string[] = [];
				expect(await runCli(["session", ...args], (line) => lines.push(line), h.caller())).toBe(1);
				expect(lines).toHaveLength(1);
				expect(JSON.parse(lines.join(""))).toMatchObject({ error: { code: "session-ending" } });
			}
			expect(h.requests).toEqual([]);
			expect(h.killed).toEqual([]);
		} finally { resume.open(); }
		expect((await first).ok).toBe(true);
	});

	for (const identity of [null, "reused-pid-creation"]) {
		test(`takes over a stale marker when its owner's identity is ${identity}`, async () => {
			const h = setup();
			h.identities[String(OTHER_OWNER_PID)] = identity;
			h.fs.seed(MARKER, JSON.stringify({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, token: "stale", takenOver: false }));
			h.response("event-1", { context: { tokens: TOKENS_AFTER } });
			expect(await stopSession(h.runtime, SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			expect(h.requests).toEqual(["usage"]);
			expect(await h.fs.stat(MARKER)).toBeNull();
		});
	}

	test("two stale-marker contenders cannot delete the new owner's marker", async () => {
		const h = setup();
		h.identities[String(OTHER_OWNER_PID)] = null;
		h.fs.seed(MARKER, JSON.stringify({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, token: "stale", takenOver: false }));
		const resume = gate();
		let owners = 0;
		const action = async () => { owners += 1; await resume.promise; return apiOk(null); };
		const first = withSessionEnding(h.runtime, ID, action);
		const second = withSessionEnding(h.caller(THIRD_OWNER_PID), ID, action);
		try {
			const rejected = await Promise.race([first, second]);
			expect(code(rejected)).toBe("session-ending");
			expect(owners).toBe(1);
		} finally { resume.open(); }
		await Promise.all([first, second]);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("releases ownership after successful cleanup and failed compaction", async () => {
		for (const success of [true, false]) {
			const h = setup();
			if (success) h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
			else h.fs.seed(`${DIRECTORY}/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: false, error: "compact failed" }));
			expect(code(await cleanupSession(h.runtime, SESSION, () => {}))).toBe(success ? "ok" : "session-module-error");
			expect(await h.fs.stat(MARKER)).toBeNull();
			expect(code(await withSessionEnding(h.caller(), ID, async () => apiOk(null)))).toBe("ok");
		}
	});

	test("releases ownership after an IO failure and a failed kill", async () => {
		for (const thrown of [true, false]) {
			const h = setup();
			const result = await withSessionEnding(h.runtime, ID, async () => {
				if (thrown) throw new Error("disk failure");
				return apiFail(SESSION_IO, "disk failure");
			});
			expect(code(result)).toBe("session-io");
			expect(await h.fs.stat(MARKER)).toBeNull();
		}
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		h.runtime.process.killTree = async () => err("kill failed");
		expect(code(await stopSession(h.runtime, SESSION, () => {}))).toBe("session-io");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});
});

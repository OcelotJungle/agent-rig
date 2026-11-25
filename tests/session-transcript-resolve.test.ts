import { describe, expect, test } from "bun:test";

import { cleanupSession } from "../src/commands/session-cleanup.js";
import { transcriptMode } from "../src/commands/session-run.js";
import { listSessions, lookupSession, TRANSCRIPT_HEAD_BYTES, transcriptHead } from "../src/session-core.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime, FAKE_OWNER_CREATED } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const ROOT = `${HOME}/.agent-rig/sessions`;
const ID = "abc";
const CREATED = "creation";
const NAMED = `${HOME}/.claude/projects/proj-sub/${ID}.jsonl`;
const REAL = `${HOME}/.claude/projects/proj/${ID}.jsonl`;
const SKILLS = '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"a","content":"b"}]}}\n';
const MODE_PLAN = `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`;
const PROCESS_FILE = { pid: 42, pid_created: CREATED, started_at: "start", source: "startup", config_dir: "" };

const setup = (named: string | null, configDir = "") => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work", transcript_path: named, started_at: "start", config_dir: configDir }));
	h.fs.seed(`${ROOT}/${ID}/usage.json`, "{}");
	h.fs.seed(`${ROOT}/${ID}/processes/42.json`, JSON.stringify(PROCESS_FILE));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	let killed = false;
	h.runtime.process.killTree = async () => { killed = true; return ok(undefined); };
	h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": killed ? null : CREATED });
	return h;
};
const loaded = async (h: ReturnType<typeof setup>) => {
	const record = await lookupSession(h.runtime, ID);
	if (!record.ok) throw new Error(record.error.message);
	return record.value;
};

describe("a session's transcript is the existing <id>.jsonl", () => {
	test("the first transcript cwd corrects the record for lookup and list", async () => {
		const h = setup(NAMED);
		h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work/sub", transcript_path: NAMED, started_at: "start" }));
		h.fs.seed(REAL, '{"type":"mode"}\n{"type":"attachment","cwd":"/work"}\n{"cwd":"/work/sub"}\n');
		expect((await loaded(h)).cwd).toBe("/work");
		expect(h.fs.rangeReads).toContainEqual({ path: REAL, start: 0, length: TRANSCRIPT_HEAD_BYTES });
		expect(h.fs.textReads).not.toContain(REAL);
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions[0] && "cwd" in list.value.sessions[0] ? list.value.sessions[0].cwd : null).toBe("/work");
	});
	test("falls back to the recorded cwd for missing, unreadable, or cwd-free transcripts", async () => {
		const h = setup(NAMED);
		expect((await loaded(h)).cwd).toBe("/work");
		h.fs.seed(NAMED, '{"type":"mode"}\n');
		expect((await loaded(h)).cwd).toBe("/work");
		h.fs.readHead = async () => { throw new Error("unreadable"); };
		expect((await loaded(h)).cwd).toBe("/work");
	});
	test("the head parser skips lines without string cwd and ignores a cut last line", () => {
		expect(transcriptHead('{"type":"mode"}\n{"cwd":42}\n{"cwd":"/root"}\n{"cwd":"/later"}\n').cwd).toBe("/root");
		expect(transcriptHead('{"type":"mode"}\n{"cwd":"/cut"}').cwd).toBeNull();
	});
	test("a malformed line is skipped, not a stop: the cwd after it still counts", () => {
		expect(transcriptHead('invalid\n{"cwd":"/other"}\n').cwd).toBe("/other");
	});
	test("a leading BOM is stripped before the first line parses", () => {
		expect(transcriptHead('\uFEFF{"cwd":"/bom"}\n')).toEqual({ cwd: "/bom", copyOf: null });
		expect(transcriptHead('\uFEFF{"cwd":"/bom","forkedFrom":{"sessionId":"src"}}\n').copyOf).toBe("src");
	});
	test("copyOf is the forkedFrom.sessionId of the cwd line when it is a string, else null", () => {
		expect(transcriptHead('{"type":"mode"}\n{"cwd":"/work","forkedFrom":{"sessionId":"src-1","messageUuid":"m"}}\n{"forkedFrom":{"sessionId":"src-2"}}\n')).toEqual({ cwd: "/work", copyOf: "src-1" });
		expect(transcriptHead('{"cwd":"/work","forkedFrom":{"sessionId":7}}\n{"forkedFrom":{"sessionId":"src-3"}}\n')).toEqual({ cwd: "/work", copyOf: null });
		expect(transcriptHead('{"cwd":"/work","forkedFrom":"src-x"}\n{"forkedFrom":{"sessionId":"src-3"}}\n').copyOf).toBeNull();
	});
	test("an owner line before the cwd line is skipped; copyOf comes from the cwd line", () => {
		expect(transcriptHead('{"type":"session-owner","accountUuid":"acc","organizationUuid":"org","sessionId":"me"}\n{"cwd":"/work","forkedFrom":{"sessionId":"src-owner"}}\n')).toEqual({ cwd: "/work", copyOf: "src-owner" });
	});
	test("copyOf is null when the first cwd line has no forkedFrom, even if a later line has one", () => {
		expect(transcriptHead('{"cwd":"/work"}\n{"type":"mode"}\n{"cwd":"/work/sub","forkedFrom":{"sessionId":"later"}}\n')).toEqual({ cwd: "/work", copyOf: null });
	});
	test("copyOf is null without a forkedFrom line, and an incomplete last line does not count", () => {
		expect(transcriptHead('{"cwd":"/work"}\n')).toEqual({ cwd: "/work", copyOf: null });
		expect(transcriptHead('{"cwd":"/work"}\n{"forkedFrom":{"sessionId":"cut"').copyOf).toBeNull();
	});
	test("a copy's cwd and copyOf come from one head read; list reports copyOf", async () => {
		const h = setup(NAMED);
		h.fs.seed(REAL, '{"type":"mode"}\n{"forkedFrom":{"sessionId":"src-1"},"cwd":"/work"}\n');
		const record = await loaded(h);
		expect(record.copyOf).toBe("src-1");
		expect(record.cwd).toBe("/work");
		expect(h.fs.rangeReads.filter((read) => read.path === REAL)).toEqual([{ path: REAL, start: 0, length: TRANSCRIPT_HEAD_BYTES }]);
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions[0] && "copyOf" in list.value.sessions[0] ? list.value.sessions[0].copyOf : null).toBe("src-1");
	});
	test("a missing named file resolves to the one existing match; list reports it", async () => {
		const h = setup(NAMED);
		h.fs.seed(REAL, MODE_PLAN);
		expect((await loaded(h)).transcriptPath).toBe(REAL);
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions[0] && "transcriptPath" in list.value.sessions[0] ? list.value.sessions[0].transcriptPath : null).toBe(REAL);
	});
	test("transcriptMode reads the mode from the resolved file", async () => {
		const h = setup(NAMED);
		h.fs.seed(REAL, MODE_PLAN);
		expect(await transcriptMode(h.runtime, (await loaded(h)).transcriptPath)).toBe("plan");
	});
	test("cleanup cleans the resolved file", async () => {
		const h = setup(NAMED);
		h.fs.seed(REAL, SKILLS);
		h.fs.seed(`${ROOT}/${ID}/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: { tokensBefore: 10, tokensAfter: 1 } }));
		const result = await cleanupSession(h.runtime, await loaded(h), () => {});
		expect(result.ok ? result.value.skillsRemoved : result.error.message).toBe(1);
	});
	test("an existing named file is used even when another match exists", async () => {
		const h = setup(NAMED);
		h.fs.seed(NAMED, MODE_PLAN);
		h.fs.seed(REAL, MODE_PLAN);
		expect((await loaded(h)).transcriptPath).toBe(NAMED);
	});
	test("several matches resolve to the most recently modified", async () => {
		const h = setup(NAMED);
		const other = `${HOME}/.claude/projects/proj-other/${ID}.jsonl`;
		h.fs.seed(REAL, MODE_PLAN);
		h.fs.seed(other, MODE_PLAN);
		h.fs.mtimes.set(REAL, 1);
		h.fs.mtimes.set(other, 2);
		expect((await loaded(h)).transcriptPath).toBe(other);
	});
	test("nothing exists: the named path is kept and cleanup reports the transcript missing", async () => {
		const h = setup(NAMED);
		h.fs.seed(`${HOME}/.claude/projects/proj/other-session.jsonl`, MODE_PLAN);
		const record = await loaded(h);
		expect(record.transcriptPath).toBe(NAMED);
		h.fs.seed(`${ROOT}/${ID}/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: { tokensBefore: 10, tokensAfter: 1 } }));
		const result = await cleanupSession(h.runtime, record, () => {});
		expect(result.ok ? "ok" : result.error.code).toBe("session-io");
	});
	test("a null named path with no projects folder stays null", async () => {
		const h = setup(null);
		expect((await loaded(h)).transcriptPath).toBeNull();
	});
	test("a custom config_dir searches that dir's projects, not ~/.claude", async () => {
		const h = setup(NAMED, "/cfg/1-test");
		const custom = `/cfg/1-test/projects/proj/${ID}.jsonl`;
		h.fs.seed(REAL, MODE_PLAN);
		expect((await loaded(h)).transcriptPath).toBe(NAMED);
		h.fs.seed(custom, MODE_PLAN);
		expect((await loaded(h)).transcriptPath).toBe(custom);
	});
	test("a config_dir whose projects is a symbolic link to the shared history resolves to the real file", async () => {
		const h = setup(NAMED, "/swap/sessions/3");
		h.fs.symlinks.set("/swap/sessions/3/projects", `${HOME}/.claude/projects`);
		h.fs.seed(REAL, MODE_PLAN);
		expect((await loaded(h)).transcriptPath).toBe(REAL);
	});
	test("a symlinked projects directory does not make one file two matches: the newest of different files still wins", async () => {
		const h = setup(NAMED, "/swap/sessions/3");
		h.fs.symlinks.set("/swap/sessions/3/projects", `${HOME}/.claude/projects`);
		h.fs.seed(NAMED.replace("proj-sub", "older"), MODE_PLAN);
		h.fs.seed(REAL, MODE_PLAN);
		h.fs.mtimes.set(NAMED.replace("proj-sub", "older"), 1);
		h.fs.mtimes.set(REAL, 2);
		expect((await loaded(h)).transcriptPath).toBe(REAL);
	});
});

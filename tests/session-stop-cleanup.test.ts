import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { cleanupSession } from "../src/commands/session-cleanup.js";
import { endSession, stopSession } from "../src/commands/session-stop.js";
import { cleanTranscript } from "../src/commands/session-transcript.js";
import { runCli } from "../src/cli.js";
import { messagesFor } from "../src/messages.js";
import { apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime, FAKE_OWNER_CREATED } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const CREATED = "creation";
const SESSION: SessionRecord = { id: "abc", cwd: null, transcriptPath: null, copyOf: null, startedAt: "start", processes: [{ pid: 42, pidCreated: CREATED, startedAt: "start" }] };
const RAW = { session_id: "abc", cwd: null, transcript_path: null, started_at: "start" };
const PROCESS_FILE = { pid: 42, pid_created: CREATED, started_at: "start", source: "startup", config_dir: "" };
const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/abc.json`, JSON.stringify(RAW));
	h.fs.seed(`${ROOT}/abc/usage.json`, "{}");
	h.fs.seed(`${ROOT}/abc/processes/42.json`, JSON.stringify(PROCESS_FILE));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": CREATED });
	return h;
};
const response = (h: ReturnType<typeof setup>, id: string, result: unknown) => h.fs.seed(`${ROOT}/abc/responses/${id}.json`, JSON.stringify({ id, ok: true, result }));

describe("session stop and cleanup", () => {
	test("reports invalid transcript records in the selected language", async () => {
		for (const language of ["en", "ru"] as const) {
			const h = setup();
			h.runtime.language = language;
			h.fs.seed("/transcripts/abc.jsonl", '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{}]}}');
			const result = await cleanTranscript(h.runtime, "/transcripts/abc.jsonl");
			expect(result.ok ? "ok" : result.error).toBe(messagesFor(language).session.io(messagesFor(language).session.skillsRecord()));
		}
	});
	test("CLI emits one JSON object for each subcommand", async () => {
		for (const command of ["stop", "cleanup"]) {
			const h = setup();
			const lines: string[] = [];
			const code = await runCli(["session", command, "missing"], (line) => lines.push(line), h.runtime);
			expect(code).toBe(1);
			expect(lines.length).toBe(1);
			expect(JSON.parse(lines[0]).error.code).toBe("session-unknown");
		}
	});
	test("compacts only above the threshold before stopping", async () => {
		for (const tokens of [120_000, 120_001]) {
			const h = setup();
			response(h, "event-1", { context: { tokens } });
			response(h, "event-2", { tokensBefore: tokens, tokensAfter: 1 });
			let killed = false;
			const events: string[] = [];
			h.runtime.process.killTree = async () => { killed = true; return ok(undefined); };
			h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": killed ? null : CREATED });
			const result = await stopSession(h.runtime, SESSION, (event) => events.push(event.code));
			expect(result.ok && result.value.stopped && result.value.compacted).toEqual(tokens > 120_000 ? { tokensBefore: tokens, tokensAfter: 1 } : null);
			expect(events).toEqual(tokens > 120_000 ? ["session-compacting", "session-terminating"] : ["session-terminating"]);
			expect(killed).toBe(true);
		}
	});
	test("an interrupting stop emits only terminating", async () => {
		const h = setup();
		const marker = { pid: 99, pidCreated: "owner", token: "owner-token", takenOver: false, otherOwners: [] };
		h.fs.seed(`${ROOT}/abc/ending.json`, JSON.stringify(marker));
		let killed = false;
		const events: string[] = [];
		h.runtime.process.killTree = async () => { killed = true; return ok(undefined); };
		// The interrupted rig exits after the first kill, so its abandoned marker cannot hold up this stop.
		h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": killed ? null : CREATED, "99": killed ? null : "owner" });
		const result = await stopSession(h.runtime, SESSION, (event) => events.push(event.code));
		expect(result.ok && result.value.stopped).toBe(true);
		expect(events).toEqual(["session-terminating"]);
	});
	test("cleanup reports compaction before termination", async () => {
		const h = setup();
		response(h, "event-1", { tokensBefore: 10, tokensAfter: 1 });
		let killed = false;
		const events: string[] = [];
		h.runtime.process.killTree = async () => { killed = true; return ok(undefined); };
		h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": killed ? null : CREATED });
		await cleanupSession(h.runtime, SESSION, (event) => events.push(event.code));
		expect(events).toEqual(["session-compacting", "session-terminating"]);
	});
	test("a stop with no live process emits no progress", async () => {
		const h = setup();
		const events: string[] = [];
		h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": null });
		const result = await stopSession(h.runtime, SESSION, (event) => events.push(event.code));
		expect(result.ok && result.value).toEqual({ session: "abc", stopped: false, reason: "not-running" });
		expect(events).toEqual([]);
	});
	test("a stop retains a skipped compaction when the record disappears", async () => {
		const h = setup();
		response(h, "event-1", { context: { tokens: 120_001 } });
		response(h, "event-2", { skip: "vetoed" });
		const result = await stopSession(h.runtime, SESSION, (event) => {
			if (event.code === "session-terminating") {
				h.fs.files.delete(`${ROOT}/abc.json`);
				h.fs.files.delete(`${ROOT}/abc/processes/42.json`);
			}
		});
		expect(result).toEqual(apiOk({ session: "abc", stopped: false, reason: "not-running", compacted: { skip: "vetoed" } } as const));
	});
	test("does not kill a reused PID and reports exit timeout", async () => {
		const h = setup();
		let kills = 0;
		h.runtime.process.killTree = async () => { kills++; return ok(undefined); };
		h.runtime.process.createdAt = async () => ok({ "42": "reused" });
		expect(await endSession(h.runtime, SESSION)).toEqual(apiOk(false));
		expect(kills).toBe(0);
		h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		const result = await endSession(h.runtime, SESSION);
		expect(result.ok ? "ok" : result.error.code).toBe("session-stop-timeout");
	});
	test("does not stop or edit when compaction does not shrink", async () => {
		for (const compact of [{ tokensBefore: 10, tokensAfter: 10 }, { tokensBefore: 10, tokensAfter: 11 }, { skip: "vetoed" }]) {
			const h = setup();
			response(h, "event-1", compact);
			let kills = 0;
			h.runtime.process.killTree = async () => { kills++; return ok(undefined); };
			const result = await cleanupSession(h.runtime, SESSION, () => {});
			expect(result.ok ? "ok" : result.error.code).toBe("session-cleanup-not-compacted");
			expect(kills).toBe(0);
		}
	});
	test("preserves other bytes, retains three backups, and retries locks", async () => {
		const h = setup();
		const directory = "/transcripts";
		const path = `${directory}/abc.jsonl`;
		const original = Buffer.concat([Buffer.from([255, 10]), Buffer.from('{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"a","content":"b"}]}}\r\n')]);
		for (let index = 1; index <= 4; index++) {
			h.runtime.clock.now = () => new Date(index);
			h.fs.files.delete(path); h.fs.binaries.delete(path);
			await h.fs.appendBytes(path, original);
			let attempts = 0;
			const result = await cleanTranscript(h.runtime, path, async (from, to) => { if (++attempts === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" }); await h.fs.rename(from, to); });
			expect(result.ok).toBe(true);
			expect(attempts).toBe(2);
			expect(Buffer.from(await h.fs.readRange(path, 0, original.length))).toEqual(Buffer.concat([Buffer.from([255, 10]), Buffer.from('{"type":"attachment","attachment":{"type":"invoked_skills","skills":[]}}\r\n')]));
		}
		expect((await h.fs.listDirectory(directory)).filter((entry) => entry.name.includes(".cleanup-")).length).toBe(3);
	});
	test("leaves transcript intact when replacement stays locked", async () => {
		const h = setup();
		const directory = "/transcripts";
		const path = `${directory}/abc.jsonl`;
		const original = '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"a","content":"b"}]}}';
		h.fs.seed(path, original);
		const result = await cleanTranscript(h.runtime, path, async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); });
		expect(result.ok).toBe(false);
		expect(await h.fs.readText(path)).toBe(original);
		expect((await h.fs.listDirectory(directory)).map((entry) => entry.name)).toEqual(["abc.jsonl"]);
	});
});

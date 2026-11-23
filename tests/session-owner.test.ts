import type { ApiResult } from "../src/output.js";
import type { RuntimePorts } from "../src/ports.js";
import type { SessionRecord } from "../src/session-core.js";
import type { OwnerSwitch, OwnerTarget } from "../src/session-owner.js";

import { describe, expect, test } from "bun:test";

import { apiOk } from "../src/output.js";
import { readOwner, writeOwner } from "../src/session-owner.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";
import { ACCOUNT_ONE, DEFAULT_LOGIN, ownerLine } from "./fakes/session-owner-fixture.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const TRANSCRIPT = `/home/test/.claude/projects/work/${ID}.jsonl`;
const CREATED = "2026-01-01";
// The pause between the tries on a busy file, and the number of tries, as documented for cleanup's rename.
const BUSY_RETRY_MS = 200;
const BUSY_TRIES = 10;
const SESSION: SessionRecord = { id: ID, cwd: "/work", transcriptPath: TRANSCRIPT, copyOf: null, startedAt: CREATED, processes: [{ pid: 42, pidCreated: CREATED, startedAt: CREATED }] };
const TARGET: OwnerTarget = { kind: "ids", ids: ACCOUNT_ONE };
const SAME_TARGET: OwnerTarget = { kind: "ids", ids: DEFAULT_LOGIN };
const CHAT = '{"type":"user","message":"hello"}\n';

const setup = (transcript: string | null = `${ownerLine(DEFAULT_LOGIN, ID)}\n${CHAT}`) => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work", transcript_path: TRANSCRIPT, started_at: CREATED, config_dir: "" }));
	if (transcript !== null) h.fs.seed(TRANSCRIPT, transcript);
	let now = 0;
	const sleeps: number[] = [];
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { sleeps.push(ms); now += ms; };
	return { ...h, sleeps };
};
// The append fails with a busy-file error this many times, then goes through.
const busyAppends = (h: ReturnType<typeof setup>, failures: number): { attempts: () => number } => {
	let attempts = 0;
	const append = h.fs.appendBytes.bind(h.fs);
	h.fs.appendBytes = async (path, value) => {
		attempts++;
		if (attempts <= failures) throw Object.assign(new Error("file is open"), { code: "EBUSY" });
		await append(path, value);
	};
	return { attempts: () => attempts };
};
// A launch with nothing in between: the reading part, then the writing part right after it when the reading asks for a write.
const ensureOwner = async (runtime: RuntimePorts, session: SessionRecord, target: OwnerTarget): Promise<ApiResult<OwnerSwitch>> => {
	const reading = await readOwner(runtime, session, target);
	if (!reading.ok) return reading;
	return reading.value.kind === "settled" ? apiOk(reading.value.owner) : writeOwner(runtime, reading.value);
};
const outcome = (result: Awaited<ReturnType<typeof ensureOwner>>): string => result.ok ? JSON.stringify(result.value) : result.error.code;

describe("readOwner and writeOwner", () => {
	test("appends an owner line for the target when the last owner line names another account", async () => {
		const h = setup();
		const result = await ensureOwner(h.runtime, SESSION, TARGET);
		expect(result).toEqual({ ok: true, value: { ownerSwitch: "written" } });
		expect(await h.fs.readText(TRANSCRIPT)).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n${CHAT}${ownerLine(ACCOUNT_ONE, ID)}\n`);
	});
	test("compares both ids: the same account in another organization is another owner", async () => {
		const h = setup();
		const result = await ensureOwner(h.runtime, SESSION, { kind: "ids", ids: { accountUuid: DEFAULT_LOGIN.accountUuid, organizationUuid: ACCOUNT_ONE.organizationUuid } });
		expect(outcome(result)).toBe('{"ownerSwitch":"written"}');
	});
	test("compares both ids: another account in the same organization is another owner", async () => {
		const h = setup();
		const result = await ensureOwner(h.runtime, SESSION, { kind: "ids", ids: { accountUuid: ACCOUNT_ONE.accountUuid, organizationUuid: DEFAULT_LOGIN.organizationUuid } });
		expect(outcome(result)).toBe('{"ownerSwitch":"written"}');
	});
	test("writes nothing when the last owner line already names the target", async () => {
		const h = setup();
		const before = await h.fs.readText(TRANSCRIPT);
		expect(outcome(await ensureOwner(h.runtime, SESSION, SAME_TARGET))).toBe('{"ownerSwitch":"unchanged"}');
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("is unavailable with owner-line-unknown when the newest session-owner line has an extra key, not a verdict from an older line", async () => {
		const extra = JSON.stringify({ type: "session-owner", accountUuid: DEFAULT_LOGIN.accountUuid, organizationUuid: DEFAULT_LOGIN.organizationUuid, sessionId: ID, extra: "key" });
		const h = setup(`${ownerLine(ACCOUNT_ONE, ID)}\n${extra}\n${CHAT}`);
		const before = await h.fs.readText(TRANSCRIPT);
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"owner-line-unknown"}');
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("is unavailable with owner-line-unknown when the newest session-owner line has a non-string accountUuid, and writes nothing", async () => {
		const numeric = JSON.stringify({ type: "session-owner", accountUuid: 1, organizationUuid: DEFAULT_LOGIN.organizationUuid, sessionId: ID });
		const h = setup(`${ownerLine(DEFAULT_LOGIN, ID)}\n${numeric}\n${CHAT}`);
		const before = await h.fs.readText(TRANSCRIPT);
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"owner-line-unknown"}');
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("skips unparsable lines and lines of another type after the last owner line, and takes the verdict from that owner line", async () => {
		const ownerLike = JSON.stringify({ type: "session-ownerish", accountUuid: 1, organizationUuid: ACCOUNT_ONE.organizationUuid, sessionId: ID });
		const h = setup(`${ownerLine(ACCOUNT_ONE, ID)}\n${ownerLine(DEFAULT_LOGIN, ID)}\n${CHAT}not json\n${ownerLike}\n${CHAT}`);
		expect(outcome(await ensureOwner(h.runtime, SESSION, SAME_TARGET))).toBe('{"ownerSwitch":"unchanged"}');
	});
	test("starts the new line on its own line when the last line has no line feed", async () => {
		const h = setup(`${ownerLine(DEFAULT_LOGIN, ID)}\n{"type":"user","mess`);
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"written"}');
		expect(await h.fs.readText(TRANSCRIPT)).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n{"type":"user","mess\n${ownerLine(ACCOUNT_ONE, ID)}\n`);
	});
	test("fails as session-unknown for a missing transcript and for a null transcript path", async () => {
		expect(outcome(await ensureOwner(setup(null).runtime, SESSION, TARGET))).toBe("session-unknown");
		expect(outcome(await ensureOwner(setup().runtime, { ...SESSION, transcriptPath: null }, TARGET))).toBe("session-unknown");
	});
	test("is unavailable with no-owner-line for an empty transcript, and writes nothing", async () => {
		const h = setup("");
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"no-owner-line"}');
		expect(await h.fs.readText(TRANSCRIPT)).toBe("");
	});
	test("is unavailable with no-owner-line when the transcript has none, and writes nothing", async () => {
		const h = setup(CHAT);
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"no-owner-line"}');
		expect(await h.fs.readText(TRANSCRIPT)).toBe(CHAT);
	});
	test("is unavailable with the reason the target carries, and writes nothing", async () => {
		for (const reason of ["ids-unreadable", "account-unknown"] as const) {
			const h = setup();
			const before = await h.fs.readText(TRANSCRIPT);
			expect(outcome(await ensureOwner(h.runtime, SESSION, { kind: "unavailable", reason }))).toBe(`{"ownerSwitch":"unavailable","ownerSwitchReason":"${reason}"}`);
			expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
		}
	});
	test("is unavailable with several-transcripts when the session has a second transcript file", async () => {
		const h = setup();
		const second = `/home/test/.claude/projects/other/${ID}.jsonl`;
		h.fs.seed(second, `${ownerLine(DEFAULT_LOGIN, ID)}\n`);
		h.fs.directories.add("/home/test/.claude/projects/work");
		h.fs.directories.add("/home/test/.claude/projects/other");
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"several-transcripts"}');
		expect(await h.fs.readText(second)).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n`);
	});
	test("is unavailable with process-unknown while a recorded process has no known creation time and may be alive", async () => {
		const unknown: SessionRecord = { ...SESSION, processes: [{ pid: 42, pidCreated: null, startedAt: CREATED }] };
		const tables: Record<string, string | null>[] = [{ "42": CREATED }, {}];
		for (const table of tables) {
			const h = setup();
			h.runtime.process.createdAt = async () => ok(table);
			expect(outcome(await ensureOwner(h.runtime, unknown, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"process-unknown"}');
		}
	});
	test("writes when a process of unknown creation time is known to be gone", async () => {
		const h = setup();
		h.runtime.process.createdAt = async () => ok({ "42": null });
		expect(outcome(await ensureOwner(h.runtime, { ...SESSION, processes: [{ pid: 42, pidCreated: null, startedAt: CREATED }] }, TARGET))).toBe('{"ownerSwitch":"written"}');
	});
	test("retries a busy transcript through the clock, then writes", async () => {
		const h = setup();
		const busy = busyAppends(h, 3);
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"written"}');
		expect(busy.attempts()).toBe(4);
		expect(h.sleeps).toEqual([BUSY_RETRY_MS, BUSY_RETRY_MS, BUSY_RETRY_MS]);
	});
	test("is unavailable with locked once the tries are spent, and writes nothing", async () => {
		const h = setup();
		const before = await h.fs.readText(TRANSCRIPT);
		const busy = busyAppends(h, Number.POSITIVE_INFINITY);
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe('{"ownerSwitch":"unavailable","ownerSwitchReason":"locked"}');
		expect(busy.attempts()).toBe(BUSY_TRIES);
		expect(h.sleeps).toHaveLength(BUSY_TRIES - 1);
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("fails as session-io on an error that is not a busy file", async () => {
		const h = setup();
		h.fs.appendBytes = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
		expect(outcome(await ensureOwner(h.runtime, SESSION, TARGET))).toBe("session-io");
		expect(h.sleeps).toEqual([]);
	});
});

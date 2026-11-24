import type { ApiResult } from "../src/output.js";
import type { RuntimePorts } from "../src/ports.js";
import type { SessionRecord } from "../src/session-core.js";
import type { OwnerGate, OwnerReading, OwnerTarget } from "../src/session-owner.js";

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
const SESSION: SessionRecord = { id: ID, cwd: "/work", transcriptPath: TRANSCRIPT, copyOf: null, startedAt: CREATED, processes: [{ pid: 42, pidCreated: CREATED, startedAt: CREATED }] };
const TARGET: OwnerTarget = { kind: "ids", ids: ACCOUNT_ONE };
const SAME_TARGET: OwnerTarget = { kind: "ids", ids: DEFAULT_LOGIN };
const CHAT = '{"type":"user","message":"hello"}\n';
const MORE_CHAT = '{"type":"assistant","message":"more"}\n';

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
// One try at a launch's owner step: the reading part, then the writing part right after it when the reading asks for a write.
const tryOwner = async (runtime: RuntimePorts, session: SessionRecord, target: OwnerTarget, between: () => void = () => undefined): Promise<ApiResult<OwnerGate>> => {
	const reading = await readOwner(runtime, session, target);
	if (!reading.ok) return reading;
	between();
	if (reading.value.kind === "settled") return apiOk({ kind: "go", decision: reading.value.owner });
	if (reading.value.kind === "stay") return apiOk({ kind: "stay", outcome: reading.value.refusal });
	return writeOwner(runtime, reading.value);
};
const outcome = (result: ApiResult<OwnerGate>): string => {
	if (!result.ok) return result.error.code;
	return result.value.kind === "go" ? `go:${result.value.decision.ownerSwitch}` : `stay:${result.value.outcome.reason}`;
};
const refusalOf = (result: ApiResult<OwnerGate>) => result.ok && result.value.kind === "stay" ? result.value.outcome : null;
const planOf = async (runtime: RuntimePorts, session: SessionRecord, target: OwnerTarget): Promise<Extract<OwnerReading, { kind: "write" }>> => {
	const reading = await readOwner(runtime, session, target);
	if (!reading.ok || reading.value.kind !== "write") throw new Error("expected a write plan");
	return reading.value;
};

describe("readOwner and writeOwner", () => {
	test("appends an owner line for the target when the last owner line names another account", async () => {
		const h = setup();
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("go:written");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n${CHAT}${ownerLine(ACCOUNT_ONE, ID)}\n`);
	});
	test("compares both ids: the same account in another organization is another owner", async () => {
		const h = setup();
		expect(outcome(await tryOwner(h.runtime, SESSION, { kind: "ids", ids: { accountUuid: DEFAULT_LOGIN.accountUuid, organizationUuid: ACCOUNT_ONE.organizationUuid } }))).toBe("go:written");
	});
	test("compares both ids: another account in the same organization is another owner", async () => {
		const h = setup();
		expect(outcome(await tryOwner(h.runtime, SESSION, { kind: "ids", ids: { accountUuid: ACCOUNT_ONE.accountUuid, organizationUuid: DEFAULT_LOGIN.organizationUuid } }))).toBe("go:written");
	});
	test("writes nothing when the last owner line already names the target", async () => {
		const h = setup();
		const before = await h.fs.readText(TRANSCRIPT);
		expect(outcome(await tryOwner(h.runtime, SESSION, SAME_TARGET))).toBe("go:unchanged");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("stays with owner-line-unknown, a permanent reason, when the newest session-owner line has an extra key, not a verdict from an older line", async () => {
		const extra = JSON.stringify({ type: "session-owner", accountUuid: DEFAULT_LOGIN.accountUuid, organizationUuid: DEFAULT_LOGIN.organizationUuid, sessionId: ID, extra: "key" });
		const h = setup(`${ownerLine(ACCOUNT_ONE, ID)}\n${extra}\n${CHAT}`);
		const before = await h.fs.readText(TRANSCRIPT);
		const result = await tryOwner(h.runtime, SESSION, TARGET);
		expect(outcome(result)).toBe("stay:owner-line-unknown");
		expect(refusalOf(result)?.transient).toBe(false);
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("stays with owner-line-unknown when the newest session-owner line has a non-string accountUuid, and writes nothing", async () => {
		const numeric = JSON.stringify({ type: "session-owner", accountUuid: 1, organizationUuid: DEFAULT_LOGIN.organizationUuid, sessionId: ID });
		const h = setup(`${ownerLine(DEFAULT_LOGIN, ID)}\n${numeric}\n${CHAT}`);
		const before = await h.fs.readText(TRANSCRIPT);
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("stay:owner-line-unknown");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("skips unparsable lines and lines of another type after the last owner line, and takes the verdict from that owner line", async () => {
		const ownerLike = JSON.stringify({ type: "session-ownerish", accountUuid: 1, organizationUuid: ACCOUNT_ONE.organizationUuid, sessionId: ID });
		const h = setup(`${ownerLine(ACCOUNT_ONE, ID)}\n${ownerLine(DEFAULT_LOGIN, ID)}\n${CHAT}not json\n${ownerLike}\n${CHAT}`);
		expect(outcome(await tryOwner(h.runtime, SESSION, SAME_TARGET))).toBe("go:unchanged");
	});
	test("starts the new line on its own line when the last line has no line feed", async () => {
		const h = setup(`${ownerLine(DEFAULT_LOGIN, ID)}\n{"type":"user","mess`);
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("go:written");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n{"type":"user","mess\n${ownerLine(ACCOUNT_ONE, ID)}\n`);
	});
	test("fails as session-unknown for a missing transcript and for a null transcript path", async () => {
		expect(outcome(await tryOwner(setup(null).runtime, SESSION, TARGET))).toBe("session-unknown");
		expect(outcome(await tryOwner(setup().runtime, { ...SESSION, transcriptPath: null }, TARGET))).toBe("session-unknown");
	});
	test("stays with no-owner-line, a permanent reason, for an empty transcript, and writes nothing", async () => {
		const h = setup("");
		const result = await tryOwner(h.runtime, SESSION, TARGET);
		expect(outcome(result)).toBe("stay:no-owner-line");
		expect(refusalOf(result)?.transient).toBe(false);
		expect(await h.fs.readText(TRANSCRIPT)).toBe("");
	});
	test("stays with no-owner-line when the transcript has none, and writes nothing", async () => {
		const h = setup(CHAT);
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("stay:no-owner-line");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(CHAT);
	});
	test("settles as none for a target with no ids, and writes nothing: the launch has no owner switch to make", async () => {
		for (const reason of ["ids-unreadable", "account-unknown"] as const) {
			const h = setup();
			const before = await h.fs.readText(TRANSCRIPT);
			expect(outcome(await tryOwner(h.runtime, SESSION, { kind: "unavailable", reason }))).toBe("go:none");
			expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
		}
	});
	test("stays with several-transcripts when the session has a second transcript file", async () => {
		const h = setup();
		const second = `/home/test/.claude/projects/other/${ID}.jsonl`;
		h.fs.seed(second, `${ownerLine(DEFAULT_LOGIN, ID)}\n`);
		h.fs.directories.add("/home/test/.claude/projects/work");
		h.fs.directories.add("/home/test/.claude/projects/other");
		const result = await tryOwner(h.runtime, SESSION, TARGET);
		expect(outcome(result)).toBe("stay:several-transcripts");
		expect(refusalOf(result)?.transient).toBe(false);
		expect(await h.fs.readText(second)).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n`);
	});
	test("stays with process-unknown, a transient reason naming the pid, while a recorded process has no known creation time and may be alive", async () => {
		const unknown: SessionRecord = { ...SESSION, processes: [{ pid: 42, pidCreated: null, startedAt: CREATED }] };
		const tables: Record<string, string | null>[] = [{ "42": CREATED }, {}];
		for (const table of tables) {
			const h = setup();
			h.runtime.process.createdAt = async () => ok(table);
			const result = await tryOwner(h.runtime, unknown, TARGET);
			expect(outcome(result)).toBe("stay:process-unknown");
			expect(refusalOf(result)).toMatchObject({ transient: true, detail: { pids: "42" } });
		}
	});
	test("a process of unknown creation time that appears between the reading and the writing makes the write stay with process-unknown", async () => {
		const h = setup();
		const plan = await planOf(h.runtime, { ...SESSION, processes: [] }, TARGET);
		const before = await h.fs.readText(TRANSCRIPT);
		h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work", transcript_path: TRANSCRIPT, started_at: CREATED, config_dir: "", pid: 43, pid_created: null, ended_at: null }));
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		expect(outcome(await writeOwner(h.runtime, plan))).toBe("stay:process-unknown");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("writes when a process of unknown creation time is known to be gone", async () => {
		const h = setup();
		h.runtime.process.createdAt = async () => ok({ "42": null });
		expect(outcome(await tryOwner(h.runtime, { ...SESSION, processes: [{ pid: 42, pidCreated: null, startedAt: CREATED }] }, TARGET))).toBe("go:written");
	});
	test("stays with locked, a transient reason, on a busy transcript: one try, no waiting inside the write", async () => {
		const h = setup();
		const before = await h.fs.readText(TRANSCRIPT);
		const busy = busyAppends(h, 1);
		const result = await tryOwner(h.runtime, SESSION, TARGET);
		expect(outcome(result)).toBe("stay:locked");
		expect(refusalOf(result)).toMatchObject({ transient: true, detail: { path: TRANSCRIPT } });
		expect(busy.attempts()).toBe(1);
		expect(h.sleeps).toEqual([]);
		expect(await h.fs.readText(TRANSCRIPT)).toBe(before);
	});
	test("writes on the next try once the busy transcript is free", async () => {
		const h = setup();
		busyAppends(h, 1);
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("stay:locked");
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("go:written");
	});
	test("fails as session-io on an error that is not a busy file", async () => {
		const h = setup();
		h.fs.appendBytes = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
		expect(outcome(await tryOwner(h.runtime, SESSION, TARGET))).toBe("session-io");
		expect(h.sleeps).toEqual([]);
	});

	describe("a transcript that changed between the reading and the writing", () => {
		const CURRENT = `${ownerLine(DEFAULT_LOGIN, ID)}\n${CHAT}`;
		test("that grew with no owner line is written at the new size, after the growth", async () => {
			const h = setup();
			expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, `${CURRENT}${MORE_CHAT}`)))).toBe("go:written");
			expect(await h.fs.readText(TRANSCRIPT)).toBe(`${CURRENT}${MORE_CHAT}${ownerLine(ACCOUNT_ONE, ID)}\n`);
		});
		test("that grew with an owner line of the launch account needs no write", async () => {
			const h = setup();
			const grown = `${CURRENT}${ownerLine(ACCOUNT_ONE, ID)}\n${MORE_CHAT}`;
			expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, grown)))).toBe("go:unchanged");
			expect(await h.fs.readText(TRANSCRIPT)).toBe(grown);
		});
		test("that grew with an owner line of another account is written at the new size", async () => {
			const h = setup();
			const other = { accountUuid: "third-account-uuid", organizationUuid: "third-organization-uuid" };
			const grown = `${CURRENT}${ownerLine(other, ID)}\n`;
			expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, grown)))).toBe("go:written");
			expect(await h.fs.readText(TRANSCRIPT)).toBe(`${grown}${ownerLine(ACCOUNT_ONE, ID)}\n`);
		});
		test("that grew with an owner line of unknown shape stays with owner-line-unknown and is not written", async () => {
			const h = setup();
			const grown = `${CURRENT}${JSON.stringify({ type: "session-owner", accountUuid: "x" })}\n`;
			expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, grown)))).toBe("stay:owner-line-unknown");
			expect(await h.fs.readText(TRANSCRIPT)).toBe(grown);
		});
		test("that grew by a partial last line stays with transcript-growing, a transient reason, and is not written", async () => {
			const h = setup();
			const grown = `${CURRENT}{"type":"assist`;
			const result = await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, grown));
			expect(outcome(result)).toBe("stay:transcript-growing");
			expect(refusalOf(result)?.transient).toBe(true);
			expect(await h.fs.readText(TRANSCRIPT)).toBe(grown);
		});
		describe("read when its last line was unterminated", () => {
			const OWNER_OF_TARGET = ownerLine(ACCOUNT_ONE, ID);
			const TORN_AT = 40;
			const torn = `${ownerLine(DEFAULT_LOGIN, ID)}\n${OWNER_OF_TARGET.slice(0, TORN_AT)}`;
			test("an owner line of the target completed after the reading is seen: unchanged, nothing written", async () => {
				const h = setup(torn);
				const completed = `${ownerLine(DEFAULT_LOGIN, ID)}\n${OWNER_OF_TARGET}\n`;
				expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, completed)))).toBe("go:unchanged");
				expect(await h.fs.readText(TRANSCRIPT)).toBe(completed);
			});
			test("an owner line of another account completed after the reading is written at the new size", async () => {
				const other = { accountUuid: "third-account-uuid", organizationUuid: "third-organization-uuid" };
				const otherLine = ownerLine(other, ID);
				const h = setup(`${ownerLine(DEFAULT_LOGIN, ID)}\n${otherLine.slice(0, TORN_AT)}`);
				const completed = `${ownerLine(DEFAULT_LOGIN, ID)}\n${otherLine}\n`;
				expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, completed)))).toBe("go:written");
				expect(await h.fs.readText(TRANSCRIPT)).toBe(`${completed}${OWNER_OF_TARGET}\n`);
			});
		});
		test("that shrank stays with transcript-changed, a permanent reason, and is not written", async () => {
			const h = setup();
			const result = await tryOwner(h.runtime, SESSION, TARGET, () => h.fs.seed(TRANSCRIPT, ownerLine(DEFAULT_LOGIN, ID)));
			expect(outcome(result)).toBe("stay:transcript-changed");
			expect(refusalOf(result)).toMatchObject({ transient: false, detail: { size: ownerLine(DEFAULT_LOGIN, ID).length } });
			expect(await h.fs.readText(TRANSCRIPT)).toBe(ownerLine(DEFAULT_LOGIN, ID));
		});
		test("that vanished fails the launch as session-unknown, with nothing written", async () => {
			const h = setup();
			expect(outcome(await tryOwner(h.runtime, SESSION, TARGET, () => { void h.fs.remove(TRANSCRIPT); }))).toBe("session-unknown");
			expect(await h.fs.stat(TRANSCRIPT)).toBeNull();
		});
	});
});

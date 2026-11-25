import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";
import type { SessionRecord } from "./session-core.js";
import type { LaunchGate } from "./session-ending.js";

import { isBusy } from "./busy-retry.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, SESSION_IO, SESSION_RUNNING, SESSION_UNKNOWN } from "./output.js";
import { errorText } from "./result.js";
import { lookupSession, recordedConfigDir, sessionLive } from "./session-core.js";
import { distinctFiles, projectTranscripts } from "./transcript-path.js";
import { lineStartAtOrBefore, scanTranscriptBackwards } from "./transcript-scan.js";

// Claude Code (2.1.325 and later) refuses to open a session under a login other than its owner's. The owner is the last
// owner line of the transcript; `readOwner` plans and `writeOwner` appends one for the launch account (rig-sessions-design.md, "Account switch").
const OWNER_LINE_TYPE = "session-owner";
// A line is an owner line only with exactly these keys (sorted), all strings: the shape the format was probed with.
const OWNER_LINE_KEYS = ["accountUuid", "organizationUuid", "sessionId", "type"] as const;
const LINE_FEED = 0x0a;
const LAST_BYTE_LENGTH = 1;
// Between the paths of a refusal detail that names several files.
const TRANSCRIPT_LIST_SEPARATOR = " | ";

export type OwnerIds = { accountUuid: string; organizationUuid: string };
// The launch account's ids, or the reason they are not known: a launch with no account to switch to has no owner to make.
export type OwnerTarget = { kind: "ids"; ids: OwnerIds } | { kind: "unavailable"; reason: "ids-unreadable" | "account-unknown" };
// `none`: the target is unavailable, so the launch makes no owner switch and Claude Code decides alone.
export type OwnerSwitch = { ownerSwitch: "written" | "unchanged" | "none" };
// Why a launch is held back from its spawn. Permanent reasons refuse the launch at once; transient ones are waited out
// within the launch's registration budget and refuse it only when that runs out.
export type OwnerReason = "no-owner-line" | "owner-line-unknown" | "several-transcripts" | "transcript-changed" | "process-unknown" | "locked" | "transcript-growing";
const TRANSIENT_REASONS: readonly OwnerReason[] = ["process-unknown", "locked", "transcript-growing"];
// The facts behind a reason (paths, sizes, pids, errno), named by key; they go into the refusal's message and event.
export type OwnerDetail = Record<string, string | number>;
export type OwnerRefusal = { reason: OwnerReason; transient: boolean; detail: OwnerDetail };
export type OwnerGate = LaunchGate<OwnerSwitch, OwnerRefusal>;

const refusal = (reason: OwnerReason, detail: OwnerDetail = {}): OwnerRefusal => ({ reason, transient: TRANSIENT_REASONS.includes(reason), detail });
const stay = (reason: OwnerReason, detail: OwnerDetail = {}): ApiResult<{ kind: "stay"; outcome: OwnerRefusal }> => apiOk({ kind: "stay", outcome: refusal(reason, detail) });
// The error code of a busy-file error (EPERM, EBUSY or EACCES): the part of the system message that is the same on every machine.
const busyCode = (error: unknown): string => typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
export const describeDetail = (detail: OwnerDetail): string => Object.entries(detail).map(([key, value]) => `${key}=${value}`).join(", ");

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const ownerIdsOfLine = (value: unknown): OwnerIds | null => {
	if (!object(value)) return null;
	const keys = Object.keys(value).sort();
	if (keys.length !== OWNER_LINE_KEYS.length || keys.some((key, index) => key !== OWNER_LINE_KEYS[index])) return null;
	const { type, accountUuid, organizationUuid, sessionId } = value;
	if (type !== OWNER_LINE_TYPE || typeof accountUuid !== "string" || typeof organizationUuid !== "string" || typeof sessionId !== "string") return null;
	return { accountUuid, organizationUuid };
};

// What a session-owner line says: its ids when it has the known shape, `unknown` when it does not; null for other lines.
type OwnerLineRead = { kind: "known"; ids: OwnerIds } | { kind: "unknown" };
const readOwnerLine = (value: unknown): OwnerLineRead | null => {
	if (!object(value) || value.type !== OWNER_LINE_TYPE) return null;
	const ids = ownerIdsOfLine(value);
	return ids === null ? { kind: "unknown" } : { kind: "known", ids };
};

const sameOwner = (left: OwnerIds, right: OwnerIds): boolean => left.accountUuid === right.accountUuid && left.organizationUuid === right.organizationUuid;

// The recorded processes of unknown creation time that may be alive: `sessionLive` ignores those, so the reading and the
// writing part both ask this on the record each one has. A pid with no process is gone (null in the table); anything else
// (a creation time, or an incomplete table) may be a live one.
const unknownCreationMayBeAlive = async (runtime: RuntimePorts, session: SessionRecord): Promise<ApiResult<number[]>> => {
	const unknownCreation = [...new Set(session.processes.filter((process) => process.pidCreated === null).map((process) => process.pid))];
	if (unknownCreation.length === 0) return apiOk([]);
	const created = await runtime.process.createdAt(unknownCreation);
	if (!created.ok) return apiFail(SESSION_IO, messagesFor(runtime.language).session.io(created.error));
	return apiOk(unknownCreation.filter((pid) => created.value[String(pid)] !== null));
};

// What the reading part found: the launch needs no write (`settled`), is held back (`stay`), or has the line to append at
// the scanned size (`write`).
export type OwnerReading =
	| { kind: "settled"; owner: OwnerSwitch }
	| { kind: "stay"; refusal: OwnerRefusal }
	| { kind: "write"; session: string; path: string; scannedSize: number; line: string; ids: OwnerIds };

// The reading part of making the target the owner: the target, the transcript checks and the backward scan. It runs before
// the launch transition and writes nothing. A missing transcript fails the launch as `session-unknown`; a launch whose
// target is unavailable has no switch to make; an empty transcript has no owner line.
export const readOwner = async (runtime: RuntimePorts, session: SessionRecord, target: OwnerTarget): Promise<ApiResult<OwnerReading>> => {
	const m = messagesFor(runtime.language).session;
	const held = (reason: OwnerReason, detail: OwnerDetail = {}): ApiResult<OwnerReading> => apiOk({ kind: "stay", refusal: refusal(reason, detail) });
	try {
		const path = session.transcriptPath;
		const stat = path === null ? null : await runtime.fs.stat(path);
		if (path === null || stat === null) return apiFail(SESSION_UNKNOWN, m.unknown(session.id));
		if (target.kind === "unavailable") return apiOk({ kind: "settled", owner: { ownerSwitch: "none" } });
		if (stat.size === 0) return held("no-owner-line", { path });
		const found = await projectTranscripts(runtime, session.id, await recordedConfigDir(runtime, session.id));
		const transcripts = await distinctFiles(runtime, [{ path }, ...found]);
		if (transcripts.length !== 1) return held("several-transcripts", { transcripts: transcripts.map((entry) => entry.path).join(TRANSCRIPT_LIST_SEPARATOR) });
		const unknownAlive = await unknownCreationMayBeAlive(runtime, session);
		if (!unknownAlive.ok) return unknownAlive;
		if (unknownAlive.value.length > 0) return held("process-unknown", { pids: unknownAlive.value.join(" ") });
		const current = await scanTranscriptBackwards(runtime, path, readOwnerLine);
		if (current === null) return held("no-owner-line", { path });
		if (current.kind === "unknown") return held("owner-line-unknown", { path });
		if (sameOwner(current.ids, target.ids)) return apiOk({ kind: "settled", owner: { ownerSwitch: "unchanged" } });
		const line = JSON.stringify({ type: OWNER_LINE_TYPE, accountUuid: target.ids.accountUuid, organizationUuid: target.ids.organizationUuid, sessionId: session.id });
		return apiOk({ kind: "write", session: session.id, path, scannedSize: stat.size, line, ids: target.ids });
	} catch (error) { return apiFail(SESSION_IO, m.io(errorText(error))); }
};

// The writing part: it runs inside the guarded launch transition, right before the spawn, and appends the line only when
// nothing changed since the reading part in a way it cannot account for. It re-reads the record (a process registered
// since means `session-running`; a process of unknown creation time may be alive, so the write waits). A transcript that
// grew is read from the line start at the scanned size (the scanned size itself when the scan ended on a line feed): a partial last line waits, an owner line there decides afresh (the same account
// is `unchanged`, an unknown shape refuses, another account or none means the line is appended at the new size); one that
// shrank or vanished is refused. A busy file waits too: the caller's loop retries on its own clock.
export const writeOwner = async (runtime: RuntimePorts, plan: Extract<OwnerReading, { kind: "write" }>): Promise<ApiResult<OwnerGate>> => {
	const m = messagesFor(runtime.language).session;
	const go = (ownerSwitch: OwnerSwitch["ownerSwitch"]): ApiResult<OwnerGate> => apiOk({ kind: "go", decision: { ownerSwitch } });
	try {
		const fresh = await lookupSession(runtime, plan.session);
		if (!fresh.ok) return fresh;
		const live = await sessionLive(runtime, fresh.value);
		if (!live.ok) return live;
		if (live.value) return apiFail(SESSION_RUNNING, m.alreadyRunning());
		const unknownAlive = await unknownCreationMayBeAlive(runtime, fresh.value);
		if (!unknownAlive.ok) return unknownAlive;
		if (unknownAlive.value.length > 0) return stay("process-unknown", { pids: unknownAlive.value.join(" ") });
		const stat = await runtime.fs.stat(plan.path);
		if (stat === null || stat.size < plan.scannedSize) return stay("transcript-changed", { path: plan.path, scannedSize: plan.scannedSize, size: stat === null ? "gone" : stat.size });
		const size = stat.size;
		const lastByteAt = async (end: number): Promise<number | undefined> => (await runtime.fs.readRange(plan.path, end - LAST_BYTE_LENGTH, LAST_BYTE_LENGTH))[0];
		const last = await lastByteAt(size);
		if (size > plan.scannedSize) {
			const growth = { path: plan.path, scannedSize: plan.scannedSize, size };
			if (last !== LINE_FEED) return stay("transcript-growing", growth);
			const appended = await scanTranscriptBackwards(runtime, plan.path, readOwnerLine, await lineStartAtOrBefore(runtime, plan.path, plan.scannedSize));
			if (appended?.kind === "unknown") return stay("owner-line-unknown", growth);
			if (appended?.kind === "known" && sameOwner(appended.ids, plan.ids)) return go("unchanged");
			// The scan read the file as it was then: the append goes onto the size the decision was taken at.
			if ((await runtime.fs.stat(plan.path))?.size !== size) return stay("transcript-growing", growth);
		}
		const bytes = Buffer.from(`${last === LINE_FEED ? "" : "\n"}${plan.line}\n`);
		try { await runtime.fs.appendBytes(plan.path, bytes); }
		catch (error) { if (isBusy(error)) return stay("locked", { path: plan.path, code: busyCode(error) }); throw error; }
		return go("written");
	} catch (error) { return apiFail(SESSION_IO, m.io(errorText(error))); }
};

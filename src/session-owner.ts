import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";
import type { SessionRecord } from "./session-core.js";

import { isBusy, retryWhileBusy } from "./busy-retry.js";
import { toSlashPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, SESSION_IO, SESSION_RUNNING, SESSION_UNKNOWN } from "./output.js";
import { errorText } from "./result.js";
import { lookupSession, recordedConfigDir, sessionLive } from "./session-core.js";
import { projectTranscripts } from "./transcript-path.js";
import { scanTranscriptBackwards } from "./transcript-scan.js";

// Claude Code (2.1.325 and later) refuses to open a session under a login other than its owner's. The owner is the last
// owner line of the transcript; `readOwner` plans and `writeOwner` appends one for the launch account (rig-sessions-design.md, "Account switch").
const OWNER_LINE_TYPE = "session-owner";
// A line is an owner line only with exactly these keys (sorted), all strings: the shape the format was probed with.
const OWNER_LINE_KEYS = ["accountUuid", "organizationUuid", "sessionId", "type"] as const;
const LINE_FEED = 0x0a;
const LAST_BYTE_LENGTH = 1;

export type OwnerIds = { accountUuid: string; organizationUuid: string };
// Why a launch could not make its account the owner; the closed set of `ownerSwitchReason`.
export type OwnerSwitchReason = "no-owner-line" | "owner-line-unknown" | "ids-unreadable" | "account-unknown" | "several-transcripts" | "process-unknown" | "locked" | "transcript-changed";
// The launch account's ids, or the reason they are not known.
export type OwnerTarget = { kind: "ids"; ids: OwnerIds } | { kind: "unavailable"; reason: "ids-unreadable" | "account-unknown" };
export type OwnerSwitch = { ownerSwitch: "written" | "unchanged" } | { ownerSwitch: "unavailable"; ownerSwitchReason: OwnerSwitchReason };

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

// Paths from different tools name one file: separators always, case outside Linux.
const comparable = (runtime: RuntimePorts, path: string): string => runtime.platform === "linux" ? toSlashPath(path) : toSlashPath(path).toLowerCase();

const unavailableSwitch = (reason: OwnerSwitchReason): OwnerSwitch => ({ ownerSwitch: "unavailable", ownerSwitchReason: reason });

// What the reading part found: the launch needs no write (`settled`), or the line to append at the scanned size.
export type OwnerReading = { kind: "settled"; owner: OwnerSwitch } | { kind: "write"; session: string; path: string; scannedSize: number; line: string };

// The reading part of making the target the owner: the target, the transcript checks and the backward scan. It runs under
// the ending marker before the launch transition and writes nothing. A missing transcript fails the launch as
// `session-unknown`; an empty one has no owner line.
export const readOwner = async (runtime: RuntimePorts, session: SessionRecord, target: OwnerTarget): Promise<ApiResult<OwnerReading>> => {
	const m = messagesFor(runtime.language).session;
	const settled = (owner: OwnerSwitch): ApiResult<OwnerReading> => apiOk({ kind: "settled", owner });
	try {
		const path = session.transcriptPath;
		const stat = path === null ? null : await runtime.fs.stat(path);
		if (path === null || stat === null) return apiFail(SESSION_UNKNOWN, m.unknown(session.id));
		if (stat.size === 0) return settled(unavailableSwitch("no-owner-line"));
		if (target.kind === "unavailable") return settled(unavailableSwitch(target.reason));
		const found = await projectTranscripts(runtime, session.id, await recordedConfigDir(runtime, session.id));
		if (new Set([path, ...found.map((entry) => entry.path)].map((entry) => comparable(runtime, entry))).size !== 1) return settled(unavailableSwitch("several-transcripts"));
		const unknownCreation = [...new Set(session.processes.filter((process) => process.pidCreated === null).map((process) => process.pid))];
		if (unknownCreation.length > 0) {
			const created = await runtime.process.createdAt(unknownCreation);
			if (!created.ok) return apiFail(SESSION_IO, m.io(created.error));
			// null is a pid with no process; anything else (a creation time, or an incomplete table) may be a live one.
			if (unknownCreation.some((pid) => created.value[String(pid)] !== null)) return settled(unavailableSwitch("process-unknown"));
		}
		const current = await scanTranscriptBackwards(runtime, path, readOwnerLine);
		if (current === null) return settled(unavailableSwitch("no-owner-line"));
		if (current.kind === "unknown") return settled(unavailableSwitch("owner-line-unknown"));
		if (current.ids.accountUuid === target.ids.accountUuid && current.ids.organizationUuid === target.ids.organizationUuid) return settled({ ownerSwitch: "unchanged" });
		const line = JSON.stringify({ type: OWNER_LINE_TYPE, accountUuid: target.ids.accountUuid, organizationUuid: target.ids.organizationUuid, sessionId: session.id });
		return apiOk({ kind: "write", session: session.id, path, scannedSize: stat.size, line });
	} catch (error) { return apiFail(SESSION_IO, m.io(errorText(error))); }
};

// The writing part: it runs inside the guarded launch transition, right before the spawn, and appends the line only when
// nothing changed since the reading part. It re-reads the record (a process registered since means `session-running`)
// and compares the transcript size with the scanned one (`transcript-changed` when another writer appended).
export const writeOwner = async (runtime: RuntimePorts, plan: Extract<OwnerReading, { kind: "write" }>): Promise<ApiResult<OwnerSwitch>> => {
	const m = messagesFor(runtime.language).session;
	try {
		const fresh = await lookupSession(runtime, plan.session);
		if (!fresh.ok) return fresh;
		const live = await sessionLive(runtime, fresh.value);
		if (!live.ok) return live;
		if (live.value) return apiFail(SESSION_RUNNING, m.alreadyRunning());
		const stat = await runtime.fs.stat(plan.path);
		if (stat === null || stat.size !== plan.scannedSize) return apiOk(unavailableSwitch("transcript-changed"));
		const [last] = await runtime.fs.readRange(plan.path, plan.scannedSize - LAST_BYTE_LENGTH, LAST_BYTE_LENGTH);
		const bytes = Buffer.from(`${last === LINE_FEED ? "" : "\n"}${plan.line}\n`);
		try { await retryWhileBusy(runtime, () => runtime.fs.appendBytes(plan.path, bytes)); }
		catch (error) { if (isBusy(error)) return apiOk(unavailableSwitch("locked")); throw error; }
		return apiOk({ ownerSwitch: "written" });
	} catch (error) { return apiFail(SESSION_IO, m.io(errorText(error))); }
};

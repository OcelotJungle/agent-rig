import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";
import type { SessionRecord } from "./session-core.js";

import { isBusy, retryWhileBusy } from "./busy-retry.js";
import { toSlashPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, SESSION_IO, SESSION_UNKNOWN } from "./output.js";
import { errorText } from "./result.js";
import { recordedConfigDir } from "./session-core.js";
import { projectTranscripts } from "./transcript-path.js";
import { scanTranscriptBackwards } from "./transcript-scan.js";

// Claude Code (2.1.325 and later) refuses to open a session under a login other than its owner's. The owner is the last
// owner line of the transcript; `ensureOwner` appends one for the launch account (rig-sessions-design.md, "Account switch").
const OWNER_LINE_TYPE = "session-owner";
// A line is an owner line only with exactly these keys (sorted), all strings: the shape the format was probed with.
const OWNER_LINE_KEYS = ["accountUuid", "organizationUuid", "sessionId", "type"] as const;
const LINE_FEED = 0x0a;
const LAST_BYTE_LENGTH = 1;

export type OwnerIds = { accountUuid: string; organizationUuid: string };
// Why a launch could not make its account the owner; the closed set of `ownerSwitchReason`.
export type OwnerSwitchReason = "no-owner-line" | "ids-unreadable" | "account-unknown" | "several-transcripts" | "process-unknown" | "locked";
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

// Paths from different tools name one file: separators always, case outside Linux.
const comparable = (runtime: RuntimePorts, path: string): string => runtime.platform === "linux" ? toSlashPath(path) : toSlashPath(path).toLowerCase();

const unavailable = (reason: OwnerSwitchReason): ApiResult<OwnerSwitch> => apiOk({ ownerSwitch: "unavailable", ownerSwitchReason: reason });

// Makes the target the owner of the session's transcript when everything the spec requires holds; otherwise reports why
// not and writes nothing. A missing or empty transcript fails the launch as `session-unknown`.
export const ensureOwner = async (runtime: RuntimePorts, session: SessionRecord, target: OwnerTarget): Promise<ApiResult<OwnerSwitch>> => {
	const m = messagesFor(runtime.language).session;
	try {
		const path = session.transcriptPath;
		const stat = path === null ? null : await runtime.fs.stat(path);
		if (path === null || stat === null || stat.size === 0) return apiFail(SESSION_UNKNOWN, m.unknown(session.id));
		if (target.kind === "unavailable") return unavailable(target.reason);
		const found = await projectTranscripts(runtime, session.id, await recordedConfigDir(runtime, session.id));
		if (new Set([path, ...found.map((entry) => entry.path)].map((entry) => comparable(runtime, entry))).size !== 1) return unavailable("several-transcripts");
		const unknownCreation = [...new Set(session.processes.filter((process) => process.pidCreated === null).map((process) => process.pid))];
		if (unknownCreation.length > 0) {
			const created = await runtime.process.createdAt(unknownCreation);
			if (!created.ok) return apiFail(SESSION_IO, m.io(created.error));
			// null is a pid with no process; anything else (a creation time, or an incomplete table) may be a live one.
			if (unknownCreation.some((pid) => created.value[String(pid)] !== null)) return unavailable("process-unknown");
		}
		const current = await scanTranscriptBackwards(runtime, path, ownerIdsOfLine);
		if (current === null) return unavailable("no-owner-line");
		if (current.accountUuid === target.ids.accountUuid && current.organizationUuid === target.ids.organizationUuid) return apiOk({ ownerSwitch: "unchanged" });
		const [last] = await runtime.fs.readRange(path, stat.size - LAST_BYTE_LENGTH, LAST_BYTE_LENGTH);
		const line = JSON.stringify({ type: OWNER_LINE_TYPE, accountUuid: target.ids.accountUuid, organizationUuid: target.ids.organizationUuid, sessionId: session.id });
		const bytes = Buffer.from(`${last === LINE_FEED ? "" : "\n"}${line}\n`);
		try { await retryWhileBusy(runtime, () => runtime.fs.appendBytes(path, bytes)); }
		catch (error) { if (isBusy(error)) return unavailable("locked"); throw error; }
		return apiOk({ ownerSwitch: "written" });
	} catch (error) { return apiFail(SESSION_IO, m.io(errorText(error))); }
};

import type { Args, Op, Request, Response } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import type { ApiResult, ProgressEvent } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { CLAIM_PID_FILE, CLAIM_STATE_FILE, CLAIM_STATE_RUNNING, CLAIM_STATE_WAITING, CLAIMS_DIR, ID_PATTERN, REQUEST_SUFFIX } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import { joinPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, PROGRESS_CODE_SESSION_RUNNING, PROGRESS_CODE_SESSION_WAITING, SESSION_BAD_ID, SESSION_BAD_RESPONSE, SESSION_CLAIM_LOST, SESSION_ENDED, SESSION_INVALID, SESSION_IO, SESSION_MODULE_ERROR, SESSION_NO_MODULE, SESSION_TIMEOUT, SESSION_UNKNOWN } from "./output.js";
import { errorText } from "./result.js";
import { removeSessionUnlessEnding } from "./session-ending.js";
import { resolveTranscriptPath } from "./transcript-path.js";

// A pid file holds a positive decimal integer (the module validates the same shape before writing it).
const PID_PATTERN = /^[1-9][0-9]*$/;
// A cwd appears in the first few lines, but an attachment line can be large; scan up to 1 MiB and only complete lines.
export const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;
// The window polls once per second; allow three polls for read-only operations.
export const SESSION_POLL_MS = 1000;
export const READ_TIMEOUT_MS = 3 * SESSION_POLL_MS;
// Ten minutes at one poll per second: rig's allowance for a compaction. Rename also waits for the turn to end, so it gets the same allowance.
export const COMPACT_TIMEOUT_MS = 10 * 60 * SESSION_POLL_MS;
export const RENAME_TIMEOUT_MS = COMPACT_TIMEOUT_MS;
// Like rename: the command waits for the turn to end, so it gets the same allowance.
export const AUTOCOMPACT_TIMEOUT_MS = COMPACT_TIMEOUT_MS;
export const SESSION_TIMEOUTS: Record<Op, number> = { compact: COMPACT_TIMEOUT_MS, rename: RENAME_TIMEOUT_MS, autocompact: AUTOCOMPACT_TIMEOUT_MS, usage: READ_TIMEOUT_MS, mode: READ_TIMEOUT_MS };

// One Claude process of a session, from its file ~/.agent-rig/sessions/<id>/processes/<pid>.json (or a legacy record).
// A process with no recorded creation time cannot be told from a reused pid, so it never counts as live.
export type SessionProcess = { pid: number; pidCreated: string | null; startedAt: string };
export type SessionRecord = { id: string; cwd: string | null; transcriptPath: string | null; copyOf: string | null; startedAt: string; processes: SessionProcess[] };
export type LiveProcess = { pid: number; startedAt: string };
export type SessionSummary = { id: string; cwd: string | null; transcriptPath: string | null; pid: number | null; processes: LiveProcess[]; startedAt: string; live: boolean; module: boolean; copyOf: string | null };
export type SessionListEntry = SessionSummary | { id: string; error: { code: string; message: string } };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// The facts a transcript head gives: the cwd of its first line with a string cwd, and the session id of the first line whose forkedFrom holds a string sessionId.
export type TranscriptHead = { cwd: string | null; copyOf: string | null };
const BYTE_ORDER_MARK = "\uFEFF";
// One pass over the complete lines of the head; a line that does not parse is skipped, and the scan stops once both facts are known.
export const transcriptHead = (head: string): TranscriptHead => {
	const text = head.startsWith(BYTE_ORDER_MARK) ? head.slice(BYTE_ORDER_MARK.length) : head;
	const lines = text.split("\n");
	// The last segment is a line the read cut short, or an empty string after a final newline: it is not a complete line.
	lines.pop();
	let cwd: string | null = null;
	let copyOf: string | null = null;
	for (const line of lines) {
		let value: unknown;
		try { value = JSON.parse(line); } catch { continue; }
		if (!object(value)) continue;
		if (cwd === null && typeof value.cwd === "string") cwd = value.cwd;
		const forkedFrom = value.forkedFrom;
		if (copyOf === null && object(forkedFrom) && typeof forkedFrom.sessionId === "string") copyOf = forkedFrom.sessionId;
		if (cwd !== null && copyOf !== null) break;
	}
	return { cwd, copyOf };
};
const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const missing = (e: unknown): boolean => object(e) && (e.code === "ENOENT" || e.code === "ENOTDIR");
const root = (r: RuntimePorts): string => joinPath(r.home, ".agent-rig", "sessions");
const folder = (r: RuntimePorts, id: string): string => joinPath(root(r), id);
const PROCESSES_DIR = "processes";
const USAGE_FILE = "usage.json";
const positivePid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export const processKey = (process: SessionProcess): string => `${process.pid}:${process.pidCreated ?? ""}`;

// The processes the files of a session name. A process file the hook deletes between the listing and the read is skipped.
const readProcesses = async (r: RuntimePorts, id: string, legacy: SessionProcess | null): Promise<ApiResult<SessionProcess[]>> => {
	const m = messagesFor(r.language).session;
	const directory = joinPath(folder(r, id), PROCESSES_DIR);
	let entries;
	try { entries = await r.fs.listDirectory(directory); }
	catch (e) { return missing(e) ? apiOk(legacy === null ? [] : [legacy]) : apiFail(SESSION_IO, m.io(errorText(e))); }
	const processes: SessionProcess[] = [];
	for (const entry of entries) {
		if (entry.directory || !entry.name.endsWith(REQUEST_SUFFIX)) continue;
		let value: unknown;
		try { value = JSON.parse(await r.fs.readText(joinPath(directory, entry.name))); }
		catch (e) { if (missing(e)) continue; return e instanceof SyntaxError ? apiFail(SESSION_INVALID, m.invalid(id)) : apiFail(SESSION_IO, m.io(errorText(e))); }
		if (!object(value) || !positivePid(value.pid) || !nullableString(value.pid_created) || typeof value.started_at !== "string") return apiFail(SESSION_INVALID, m.invalid(id));
		processes.push({ pid: value.pid, pidCreated: value.pid_created, startedAt: value.started_at });
	}
	if (legacy !== null && !processes.some((process) => processKey(process) === processKey(legacy))) processes.push(legacy);
	return apiOk(processes);
};

// Reads registration facts without retention or a process-table query; ending polls batch identity checks themselves.
export const readSession = async (r: RuntimePorts, id: string): Promise<ApiResult<SessionRecord>> => {
	const m = messagesFor(r.language).session;
	if (!ID_PATTERN.test(id)) return apiFail(SESSION_BAD_ID, m.badId(id));
	let value: unknown;
	try { value = JSON.parse(await r.fs.readText(joinPath(root(r), `${id}.json`))); }
	catch (e) { return missing(e) ? apiFail(SESSION_UNKNOWN, m.unknown(id)) : e instanceof SyntaxError ? apiFail(SESSION_INVALID, m.invalid(id)) : apiFail(SESSION_IO, m.io(errorText(e))); }
	// A record written before per-process files holds one pid, pid_created and ended_at itself; absent fields mean null.
	const pid = value !== null && object(value) ? value.pid ?? null : null;
	const pidCreated = value !== null && object(value) ? value.pid_created ?? null : null;
	const endedAt = value !== null && object(value) ? value.ended_at ?? null : null;
	if (!object(value) || value.session_id !== id || !nullableString(value.cwd) || !nullableString(value.transcript_path) || !(pid === null || positivePid(pid)) || !nullableString(pidCreated) || typeof value.started_at !== "string" || !nullableString(endedAt)) return apiFail(SESSION_INVALID, m.invalid(id));
	const legacy: SessionProcess | null = pid !== null && endedAt === null ? { pid, pidCreated, startedAt: value.started_at } : null;
	const processes = await readProcesses(r, id, legacy);
	if (!processes.ok) return processes;
	// The record keeps the path Claude Code named; every reader gets the transcript file that really exists.
	const transcriptPath = await resolveTranscriptPath(r, id, value.transcript_path, typeof value.config_dir === "string" ? value.config_dir : "");
	if (!transcriptPath.ok) return transcriptPath;
	let cwd = value.cwd;
	let copyOf: string | null = null;
	if (transcriptPath.value !== null) {
		try {
			const head = transcriptHead(await r.fs.readHead(transcriptPath.value, TRANSCRIPT_HEAD_BYTES));
			cwd = head.cwd ?? cwd;
			copyOf = head.copyOf;
		}
		catch { /* A missing or unreadable transcript leaves the recorded cwd in place and names no copy source. */ }
	}
	return apiOk({ id, cwd, transcriptPath: transcriptPath.value, copyOf, startedAt: value.started_at, processes: processes.value });
};

// The processes among `candidates` whose creation time matches the recorded one, earliest started first.
export const liveAmong = (candidates: readonly SessionProcess[], created: Record<string, string | null>): SessionProcess[] =>
	candidates.filter((process) => process.pidCreated !== null && created[String(process.pid)] === process.pidCreated).sort((a, b) => (a.pidCreated ?? "").localeCompare(b.pidCreated ?? ""));
const checkable = (processes: readonly SessionProcess[]): number[] => [...new Set(processes.filter((process) => process.pidCreated !== null).map((process) => process.pid))];

// Every live process of the session; one creation-time query covers all of them.
export const liveProcesses = async (r: RuntimePorts, session: SessionRecord): Promise<ApiResult<SessionProcess[]>> => {
	const pids = checkable(session.processes);
	if (pids.length === 0) return apiOk([]);
	const created = await r.process.createdAt(pids);
	if (!created.ok) return apiFail(SESSION_IO, messagesFor(r.language).session.io(created.error));
	if (pids.some((pid) => created.value[String(pid)] === undefined)) return apiFail(SESSION_IO, messagesFor(r.language).session.io(messagesFor(r.language).failure.processTableIncomplete()));
	return apiOk(liveAmong(session.processes, created.value));
};

export const sessionLive = async (r: RuntimePorts, session: SessionRecord): Promise<ApiResult<boolean>> => {
	const live = await liveProcesses(r, session);
	return live.ok ? apiOk(live.value.length > 0) : live;
};

// A record without a transcript remains while a session process or ending owner is live.
const retainSession = async (r: RuntimePorts, session: SessionRecord, getLive: () => Promise<ApiResult<SessionProcess[]>>): Promise<ApiResult<SessionRecord>> => {
	const m = messagesFor(r.language).session;
	try {
		if (session.transcriptPath !== null && await r.fs.stat(session.transcriptPath) !== null) return apiOk(session);
		const live = await getLive();
		if (!live.ok) return live;
		if (live.value.length > 0) return apiOk(session);
		const removed = await removeSessionUnlessEnding(r, session.id);
		if (!removed.ok) return removed;
		return removed.value ? apiFail(SESSION_UNKNOWN, m.unknown(session.id)) : apiOk(session);
	} catch (e) { return apiFail(SESSION_IO, m.io(errorText(e))); }
};

export const lookupSession = async (r: RuntimePorts, id: string): Promise<ApiResult<SessionRecord>> => {
	const session = await readSession(r, id);
	if (!session.ok) return session;
	return retainSession(r, session.value, () => liveProcesses(r, session.value));
};

export const lookupSessionForCommand = async (r: RuntimePorts, id: string, requireLive: boolean): Promise<ApiResult<SessionRecord>> => {
	const session = await lookupSession(r, id);
	if (!session.ok || !requireLive) return session;
	const live = await sessionLive(r, session.value);
	if (!live.ok) return live;
	return live.value ? session : apiFail(SESSION_ENDED, messagesFor(r.language).session.ended());
};

export type CompactOutcome = { tokensBefore: number; tokensAfter: number } | { skip: string };

export const compactSessionCore = async (r: RuntimePorts, session: SessionRecord, instructions: string | undefined, progress: (event: ProgressEvent) => void): Promise<ApiResult<CompactOutcome>> => {
	const result = await requestSession(r, session, "compact", instructions === undefined ? {} : { instructions }, SESSION_TIMEOUTS.compact, progress);
	if (!result.ok) return result;
	const value = result.value;
	if (object(value) && typeof value.skip === "string") return apiOk({ skip: value.skip });
	if (object(value) && typeof value.tokensBefore === "number" && Number.isFinite(value.tokensBefore) && typeof value.tokensAfter === "number" && Number.isFinite(value.tokensAfter)) return apiOk({ tokensBefore: value.tokensBefore, tokensAfter: value.tokensAfter });
	return apiFail(SESSION_BAD_RESPONSE, messagesFor(r.language).session.badResponse());
};

export const sessionModule = async (r: RuntimePorts, session: SessionRecord): Promise<ApiResult<boolean>> => {
	// The session folder also holds the hooks' process files, so only the window module's usage snapshot marks it as present.
	try { await r.fs.readText(joinPath(folder(r, session.id), USAGE_FILE)); return apiOk(true); }
	catch (e) { return missing(e) ? apiOk(false) : apiFail(SESSION_IO, messagesFor(r.language).session.io(errorText(e))); }
};

export const listSessions = async (r: RuntimePorts): Promise<ApiResult<{ sessions: SessionListEntry[] }>> => {
	let entries;
	try { entries = await r.fs.listDirectory(root(r)); }
	catch (e) { return missing(e) ? apiOk({ sessions: [] }) : apiFail(SESSION_IO, messagesFor(r.language).session.io(errorText(e))); }
	const sessions: SessionListEntry[] = [];
	const records: SessionRecord[] = [];
	for (const entry of entries) {
		if (entry.directory || !entry.name.endsWith(REQUEST_SUFFIX)) continue;
		const id = entry.name.slice(0, -REQUEST_SUFFIX.length);
		const record = await readSession(r, id);
		if (!record.ok) { if (record.error.code !== SESSION_UNKNOWN) sessions.push({ id, error: record.error }); continue; }
		records.push(record.value);
	}
	// One creation-time query for the processes of all sessions.
	const pids = [...new Set(records.flatMap((record) => checkable(record.processes)))];
	const created = pids.length === 0 ? null : await r.process.createdAt(pids);
	for (const record of records) {
		const { id } = record;
		const live = created !== null && !created.ok && checkable(record.processes).length > 0
			? apiFail(SESSION_IO, messagesFor(r.language).session.io(created.error))
			: created !== null && created.ok && checkable(record.processes).some((pid) => created.value[String(pid)] === undefined)
			? apiFail(SESSION_IO, messagesFor(r.language).session.io(messagesFor(r.language).failure.processTableIncomplete()))
			: apiOk(created !== null && created.ok ? liveAmong(record.processes, created.value) : []);
		const retained = await retainSession(r, record, async () => live);
		if (!retained.ok) { if (retained.error.code !== SESSION_UNKNOWN) sessions.push({ id, error: retained.error }); continue; }
		const retainedLive = retained.value === record ? live : await liveProcesses(r, retained.value);
		if (!retainedLive.ok) { sessions.push({ id, error: retainedLive.error }); continue; }
		const { cwd, transcriptPath, startedAt, copyOf } = retained.value;
		const module = await sessionModule(r, retained.value);
		if (!module.ok) { sessions.push({ id, error: module.error }); continue; }
		sessions.push({ id, cwd, transcriptPath, pid: retainedLive.value[0]?.pid ?? null, processes: retainedLive.value.map((process) => ({ pid: process.pid, startedAt: process.startedAt })), startedAt, live: retainedLive.value.length > 0, module: module.value, copyOf });
	}
	sessions.sort((a, b) => ("startedAt" in b ? b.startedAt : "").localeCompare("startedAt" in a ? a.startedAt : ""));
	return apiOk({ sessions });
};

export const requestSession = async (r: RuntimePorts, session: SessionRecord, op: Op, args: Args, timeout: number, progress: (event: ProgressEvent) => void = () => {}): Promise<ApiResult<unknown>> => {
	const m = messagesFor(r.language).session;
	if (!ID_PATTERN.test(session.id)) return apiFail(SESSION_BAD_ID, m.badId(session.id));
	const module = await sessionModule(r, session);
	if (!module.ok) return module;
	if (!module.value) return apiFail(SESSION_NO_MODULE, m.noModule());
	const initialPids = checkable(session.processes);
	let initialCreated: Record<string, string | null> = {};
	if (initialPids.length > 0) {
		const checked = await r.process.createdAt(initialPids);
		if (!checked.ok) return apiFail(SESSION_IO, m.io(errorText(checked.error)));
		initialCreated = checked.value;
	}
	if (liveAmong(session.processes, initialCreated).length === 0) return apiFail(SESSION_ENDED, m.ended());
	const id = r.ids.next();
	if (!ID_PATTERN.test(id)) return apiFail(SESSION_IO, m.io(messagesFor(r.language).failure.requestIdInvalid()));
	const requests = joinPath(folder(r, session.id), "requests");
	const responses = joinPath(folder(r, session.id), "responses");
	const path = joinPath(requests, `${id}${REQUEST_SUFFIX}`);
	const temp = joinPath(requests, `${id}.tmp`);
	const responsePath = joinPath(responses, `${id}${REQUEST_SUFFIX}`);
	const body: Request = { id, op, args };
	const claimDir = joinPath(folder(r, session.id), CLAIMS_DIR, id);
	// The claiming module's Claude pid once its pid file is read, and that pid's creation time once first looked up.
	let claimant: { pid: number; created: string | null } | null = null;
	let published = false;
	let firstPoll = true;
	try {
		await r.fs.ensureDirectory(requests);
		await r.fs.ensureDirectory(responses);
		await r.fs.writeText(temp, JSON.stringify(body));
		await r.fs.rename(temp, path);
		published = true;
		const deadline = r.clock.now().getTime() + timeout;
		let malformed = false;
		// The last progress code sent: each is sent when the module's observed state changes to it, never twice in a row.
		let lastCode: string | null = null;
		for (;;) {
			let stateText: string | null = null;
			try { stateText = (await r.fs.readText(joinPath(claimDir, CLAIM_STATE_FILE))).trim(); } catch (e) { if (!missing(e)) throw e; }
			if (stateText === CLAIM_STATE_WAITING && lastCode !== PROGRESS_CODE_SESSION_WAITING) { progress({ code: PROGRESS_CODE_SESSION_WAITING }); lastCode = PROGRESS_CODE_SESSION_WAITING; }
			if (stateText === CLAIM_STATE_RUNNING && lastCode === PROGRESS_CODE_SESSION_WAITING) { progress({ code: PROGRESS_CODE_SESSION_RUNNING }); lastCode = PROGRESS_CODE_SESSION_RUNNING; }
			let text: string | null = null;
			try { text = await r.fs.readText(responsePath); } catch (e) { if (!missing(e)) throw e; }
			if (text !== null) {
				let value: unknown;
				try { value = JSON.parse(text); } catch { value = null; }
				if (object(value) && value.id === id && ((value.ok === true && "result" in value) || (value.ok === false && typeof value.error === "string"))) {
					const response: Response = value.ok === true ? { id, ok: true, result: value.result } : { id, ok: false, error: typeof value.error === "string" ? value.error : "" };
					await r.fs.remove(responsePath);
					return response.ok ? apiOk(response.result) : apiFail(SESSION_MODULE_ERROR, response.error);
				}
				if (malformed) return apiFail(SESSION_BAD_RESPONSE, m.badResponse());
				malformed = true;
			}
			// The claiming module is gone when its process identity is: the pid no longer exists or has another creation time.
			// Elapsed time never decides it (a claimant may run a long step). A claim with no valid pid file is waited on.
			if (claimant === null) {
				let pidText: string | null = null;
				try { pidText = (await r.fs.readText(joinPath(claimDir, CLAIM_PID_FILE))).trim(); } catch (e) { if (!missing(e)) throw e; }
				if (pidText !== null && PID_PATTERN.test(pidText) && Number.isSafeInteger(Number(pidText))) claimant = { pid: Number(pidText), created: null };
			}
			const current = await readSession(r, session.id);
			if (!current.ok) return current.error.code === SESSION_UNKNOWN ? apiFail(SESSION_ENDED, m.ended()) : current;
			const sessionPids = checkable(current.value.processes);
			const pollPids = firstPoll
				? [...new Set([...sessionPids.filter((pid) => !(String(pid) in initialCreated)), ...(claimant === null ? [] : [claimant.pid])])]
				: [...new Set([...sessionPids, ...(claimant === null ? [] : [claimant.pid])])];
			let created: Record<string, string | null> = initialCreated;
			if (pollPids.length > 0) {
				const queried = await r.process.createdAt(pollPids);
				if (!queried.ok) return apiFail(SESSION_IO, m.io(queried.error));
				created = firstPoll ? { ...created, ...queried.value } : queried.value;
			}
			firstPoll = false;
			if (liveAmong(current.value.processes, created).length === 0) return apiFail(SESSION_ENDED, m.ended());
			if (claimant !== null) {
				const now = created[String(claimant.pid)] ?? null;
				if (claimant.created === null && now !== null) {
					// The claimant existed before it made its claim directory, so a process created after the directory's last change is a stranger that reused the pid.
					const claimChanged = await r.fs.modifiedAt(claimDir);
					if (claimChanged !== null && Date.parse(now) > claimChanged) return apiFail(SESSION_CLAIM_LOST, m.claimLost());
				}
				claimant.created ??= now;
				if (now === null || now !== claimant.created) return apiFail(SESSION_CLAIM_LOST, m.claimLost());
			}
			const remaining = deadline - r.clock.now().getTime();
			if (remaining <= 0) {
				return apiFail(SESSION_TIMEOUT, m.timeout());
			}
			await r.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
		}
	} catch (e) { return apiFail(SESSION_IO, m.io(errorText(e))); }
	finally {
		for (const candidate of published ? [path] : [temp]) {
			try { await r.fs.remove(candidate); } catch (e) { if (!missing(e)) throw e; }
		}
		// After the request: a window that listed it earlier then finds it gone once it has claimed it, and does not run it.
		if (published) { try { await r.fs.removeDirectoryTree(claimDir); } catch (e) { if (!missing(e)) throw e; } }
	}
};

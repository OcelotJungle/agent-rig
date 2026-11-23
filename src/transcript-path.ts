import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { joinPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, SESSION_IO } from "./output.js";
import { errorText } from "./result.js";

const DEFAULT_CONFIG_DIR = ".claude";
const PROJECTS_DIR = "projects";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const missing = (e: unknown): boolean => object(e) && (e.code === "ENOENT" || e.code === "ENOTDIR");

// Claude Code names a transcript after the session's cwd at its start, but keeps writing to the file where the session
// began after a resume in another cwd. So the transcript of a session is the existing file
// `<config dir>/projects/*/<id>.jsonl`: the named path while that is a file or while no such file exists anywhere
// (a new session), otherwise the existing match (the most recently modified when there are several).
export const resolveTranscriptPath = async (r: RuntimePorts, id: string, named: string | null, configDir: string): Promise<ApiResult<string | null>> => {
	const m = messagesFor(r.language).session;
	try {
		if (named !== null && await r.fs.stat(named) !== null) return apiOk(named);
		const [newest] = (await projectTranscripts(r, id, configDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
		return apiOk(newest === undefined ? named : newest.path);
	} catch (e) { return apiFail(SESSION_IO, m.io(errorText(e))); }
};

// Every existing `<config dir>/projects/*/<id>.jsonl` with its modification time; a missing projects directory is none.
// A read error is thrown to the caller.
export const projectTranscripts = async (r: RuntimePorts, id: string, configDir: string): Promise<{ path: string; mtimeMs: number }[]> => {
	const projects = joinPath(configDir === "" ? joinPath(r.home, DEFAULT_CONFIG_DIR) : configDir, PROJECTS_DIR);
	let entries;
	try { entries = await r.fs.listDirectory(projects); }
	catch (e) { if (missing(e)) return []; throw e; }
	const found: { path: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (!entry.directory) continue;
		const path = joinPath(projects, entry.name, `${id}.jsonl`);
		const stat = await r.fs.stat(path);
		if (stat !== null) found.push({ path, mtimeMs: stat.mtimeMs });
	}
	return found;
};

import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { joinPath, toSlashPath } from "./file-system.js";
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

// The text two paths of one file share: separators always, case outside Linux.
const comparable = (r: RuntimePorts, path: string): string => r.platform === "linux" ? path : path.toLowerCase();

// The real file behind a path: a symlink or junction on the way, in a directory or as the file itself, is followed (a
// config dir may share its `projects` with another one this way). A path that does not exist keeps its own text.
export const realFilePath = async (r: RuntimePorts, path: string): Promise<string> => toSlashPath(await r.fs.resolveTarget(path));

// The distinct files among `entries`, each carrying its real path, in the order first met (the first entry of a file
// supplies the rest of its fields). Two paths name one file when they resolve to the same real file, never because their
// text matches.
export const distinctFiles = async <T extends { path: string }>(r: RuntimePorts, entries: readonly T[]): Promise<T[]> => {
	const files = new Map<string, T>();
	for (const entry of entries) {
		const real = await realFilePath(r, entry.path);
		const key = comparable(r, real);
		if (!files.has(key)) files.set(key, { ...entry, path: real });
	}
	return [...files.values()];
};

// Every existing `<config dir>/projects/*/<id>.jsonl` with its modification time, each file once, by its real path; a
// missing projects directory is none. A read error is thrown to the caller.
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
	return distinctFiles(r, found);
};

import type { Messages } from "./messages.js";
import type { Result } from "./result.js";

import { err, errorText, ok } from "./result.js";

export type DirectoryEntry = { name: string; directory: boolean };
export type FileStat = { size: number; mtimeMs: number };

export type FileSystem = {
	readText(path: string): Promise<string>;
	readHead(path: string, maxBytes: number): Promise<string>;
	// Size and modification time of a file; null when it does not exist.
	stat(path: string): Promise<FileStat | null>;
	// Modification time in milliseconds of a file or a directory; null when neither exists.
	modifiedAt(path: string): Promise<number | null>;
	// At most `length` bytes starting at byte `start`; fewer at the end of the file. For files that grow without bound
	// (Codex rollouts), where reading the whole file is not an option.
	readRange(path: string, start: number, length: number): Promise<Uint8Array>;
	appendBytes(path: string, value: Uint8Array): Promise<void>;
	// Creates the file with exactly these bytes, replacing any earlier content: for files that hold a whole content.
	writeBytes(path: string, value: Uint8Array): Promise<void>;
	writeText(path: string, value: string): Promise<void>;
	appendText(path: string, value: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	ensureDirectory(path: string): Promise<void>;
	removeDirectoryTree(path: string): Promise<void>;
	// Creates the file already complete, or reports false when the name exists; never exposes a partial file.
	writeExclusive(path: string, value: string): Promise<Result<boolean>>;
	// Creates the directory (its parent must exist) and reports true, or reports false when the name exists: the one atomic step a directory mutex needs.
	makeDirectoryExclusive(path: string): Promise<Result<boolean>>;
	// The real file behind a path: symlinks in the file itself or in any directory on its path are followed. A write
	// replaces this file; two paths name one file when they resolve to the same one. A path that does not exist keeps its text.
	resolveTarget(path: string): Promise<string>;
	// Permission bits of an existing file, null when it does not exist.
	modeOf(path: string): Promise<number | null>;
	// Creates a new file with the given mode (null: default) and flushes it to disk before returning.
	writeDurable(path: string, value: string, mode: number | null): Promise<void>;
	listDirectory(path: string): Promise<DirectoryEntry[]>;
	uniqueSuffix(): string;
};

// Every path rig stores, compares or renders into text has one form: forward slashes. Windows accepts them everywhere
// rig uses a path, and a single form gives the same file the same key on every run.
export const toSlashPath = (path: string): string => path.replaceAll("\\", "/");

const UNC_PREFIX = "//";

export const joinPath = (...parts: string[]): string => {
	const slashed = parts
		.filter((part) => part.length > 0)
		.map(toSlashPath);
	const collapsed = slashed
		.join("/")
		.replace(/\/+/g, "/")
		.replace(/^([A-Za-z]):\//, "$1:/");
	// A network path (\\server\share) keeps its two leading slashes.
	const first = slashed[0] ?? "";
	return first.startsWith(UNC_PREFIX) && !first.startsWith("///") ? `/${collapsed}` : collapsed;
};

export const atomicWrite = async (fs: FileSystem, path: string, value: string, messages: Messages): Promise<Result<void>> => {
	let temporaryPath = `${path}.tmp-${fs.uniqueSuffix()}`;
	try {
		const separator = path.lastIndexOf("/");
		await fs.ensureDirectory(separator < 0 ? "." : path.slice(0, separator));
		// Replace the file a symlink points to, and keep its permissions (for example 0600).
		const target = await fs.resolveTarget(path);
		const mode = await fs.modeOf(target);
		temporaryPath = `${target}.tmp-${fs.uniqueSuffix()}`;
		await fs.writeDurable(temporaryPath, value, mode);
		await fs.rename(temporaryPath, target);
		return ok(undefined);
	} catch (error) {
		await fs.remove(temporaryPath).catch(() => undefined);
		return err(messages.failure.atomicWriteFailed(errorText(error)));
	}
};

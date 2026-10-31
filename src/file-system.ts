import type { Result } from "./result.js";

import { err, errorText, ok } from "./result.js";

export type DirectoryEntry = { name: string; directory: boolean };

export type FileSystem = {
	readText(path: string): Promise<string>;
	writeText(path: string, value: string): Promise<void>;
	appendText(path: string, value: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	ensureDirectory(path: string): Promise<void>;
	// Creates the file already complete, or reports false when the name exists; never exposes a partial file.
	writeExclusive(path: string, value: string): Promise<Result<boolean>>;
	// Follows symlinks to the file a write must replace.
	resolveTarget(path: string): Promise<string>;
	// Permission bits of an existing file, null when it does not exist.
	modeOf(path: string): Promise<number | null>;
	// Creates a new file with the given mode (null: default) and flushes it to disk before returning.
	writeDurable(path: string, value: string, mode: number | null): Promise<void>;
	listDirectory(path: string): Promise<DirectoryEntry[]>;
	uniqueSuffix(): string;
};

export const joinPath = (...parts: string[]): string => parts
	.filter((part) => part.length > 0)
	.join("/")
	.replace(/\/+/g, "/")
	.replace(/^([A-Za-z]):\//, "$1:/");

export const atomicWrite = async (fs: FileSystem, path: string, value: string): Promise<Result<void>> => {
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
		return err(`Atomic write failed: ${errorText(error)}`);
	}
};

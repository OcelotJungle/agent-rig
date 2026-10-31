import type { Result } from "./result.js";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

import { err, errorText, ok } from "./result.js";

// Permission bits that survive a copy: rwx for owner, group and others plus setuid, setgid and sticky.
const PERMISSION_BITS_MASK = 0o7777;
// Default for a file that did not exist before: the usual umask then narrows it.
const NEW_FILE_MODE = 0o666;

export type HostPlatform = "windows" | "posix";

const errorCode = (error: unknown): string | null =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;

// Follows a symlink so a replacement lands on the file it points to, not on the link itself.
export const resolveTarget = async (path: string): Promise<string> => {
	try {
		return await fs.realpath(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	try {
		const link = await fs.readlink(path);
		return resolve(dirname(path), link);
	} catch {
		return path;
	}
};

export const modeOf = async (path: string): Promise<number | null> => {
	try {
		return (await fs.stat(path)).mode & PERMISSION_BITS_MASK;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
};

// Writes the whole value, flushes it to disk, then applies the mode: a crash cannot leave a renamed file without data.
// Windows has no POSIX permission bits, so chmod there would only toggle the read-only flag.
export const writeDurable = async (path: string, value: string, mode: number | null, platform: HostPlatform): Promise<void> => {
	const handle = await fs.open(path, "wx", mode ?? NEW_FILE_MODE);
	try {
		await handle.writeFile(value, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (mode !== null && platform === "posix") await fs.chmod(path, mode);
};

// The file appears under its final name already complete, or not at all: a hard link is atomic and fails if the name exists.
export const writeExclusiveAtomic = async (path: string, value: string, platform: HostPlatform): Promise<Result<boolean>> => {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeDurable(temporaryPath, value, null, platform);
		try {
			await fs.link(temporaryPath, path);
			return ok(true);
		} catch (error) {
			if (errorCode(error) === "EEXIST") return ok(false);
			return err(`Could not create ${path}: ${errorText(error)}`);
		}
	} catch (error) {
		return err(`Could not create ${path}: ${errorText(error)}`);
	} finally {
		await fs.unlink(temporaryPath).catch(() => undefined);
	}
};

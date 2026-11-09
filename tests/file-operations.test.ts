import type { ProcessOptions, ProcessOutput } from "../src/ports.js";
import type { Result } from "../src/result.js";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSystem, ownerStartTime } from "../src/commands/real-runtime.js";
import { atomicWrite } from "../src/file-system.js";
import { err, ok } from "../src/result.js";
import { MemoryFileSystem } from "./fakes/memory-runtime.js";

const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;
const WINDOWS_TICKS = 638_000_000_000_000_000;
const LINUX_ABSENT_PID = 2_000_000_000;
const IS_POSIX = process.platform !== "win32";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rig-fileops-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const canSymlink = async (): Promise<boolean> => {
	const probeTarget = join(directory, "probe-target");
	await writeFile(probeTarget, "");
	try {
		await symlink(probeTarget, join(directory, "probe-link"));
		return true;
	} catch {
		return false;
	}
};

describe("atomic write through the in-memory file system", () => {
	test("writes durably and keeps the mode of the file it replaces", async () => {
		const fs = new MemoryFileSystem();
		fs.seed("/data/secret.json", "old");
		fs.modes.set("/data/secret.json", PRIVATE_MODE);

		const result = await atomicWrite(fs, "/data/secret.json", "new");

		expect(result.ok).toBe(true);
		expect(fs.files.get("/data/secret.json")).toBe("new");
		expect(fs.modes.get("/data/secret.json")).toBe(PRIVATE_MODE);
		expect(fs.operations.some((operation) => operation.startsWith("durable:"))).toBe(true);
	});

	test("writing through a symlink replaces the target and keeps the link", async () => {
		const fs = new MemoryFileSystem();
		fs.seed("/data/real.json", "old");
		fs.links.set("/data/link.json", "/data/real.json");

		const result = await atomicWrite(fs, "/data/link.json", "new");

		expect(result.ok).toBe(true);
		expect(fs.files.get("/data/real.json")).toBe("new");
		expect(fs.files.has("/data/link.json")).toBe(false);
		expect(fs.links.get("/data/link.json")).toBe("/data/real.json");
	});
});

describe("atomic write on the real file system", () => {
	test("writing through a symlink updates the target and keeps the link a link", async () => {
		if (!(await canSymlink())) return;
		const target = join(directory, "target.json");
		const link = join(directory, "link.json");
		await writeFile(target, "old");
		await symlink(target, link);

		const result = await atomicWrite(createFileSystem(), link.replaceAll("\\", "/"), "new");

		expect(result.ok).toBe(true);
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("new");
		expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	test("a dangling symlink is written through to its target", async () => {
		if (!(await canSymlink())) return;
		const target = join(directory, "later.json");
		const link = join(directory, "dangling.json");
		await symlink(target, link);

		const result = await atomicWrite(createFileSystem(), link.replaceAll("\\", "/"), "created");

		expect(result.ok).toBe(true);
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("created");
	});

	test("on posix the 0600 mode of the old file survives the replacement", async () => {
		if (!IS_POSIX) return;
		const path = join(directory, "secret.json");
		await writeFile(path, "old");
		await chmod(path, PRIVATE_MODE);

		const result = await atomicWrite(createFileSystem("posix"), path, "new");

		expect(result.ok).toBe(true);
		expect((await stat(path)).mode & MODE_MASK).toBe(PRIVATE_MODE);
		expect(await readFile(path, "utf8")).toBe("new");
	});

	test("the windows code path writes without chmod and still replaces the file", async () => {
		const path = join(directory, "plain.json");
		await writeFile(path, "old");
		const chmodSpy = spyOn(nodeFs, "chmod");
		try {
			const result = await atomicWrite(createFileSystem("windows"), path.replaceAll("\\", "/"), "new");

			expect(result.ok).toBe(true);
			expect(await readFile(path, "utf8")).toBe("new");
			expect(chmodSpy).not.toHaveBeenCalled();
		} finally {
			chmodSpy.mockRestore();
		}
	});

	test("the data is flushed to disk before the rename", async () => {
		const path = join(directory, "durable.json");
		const events: string[] = [];
		const originalOpen = nodeFs.open.bind(nodeFs);
		const originalRename = nodeFs.rename.bind(nodeFs);
		const openSpy = spyOn(nodeFs, "open").mockImplementation(async (...openArguments: Parameters<typeof originalOpen>) => {
			const handle = await originalOpen(...openArguments);
			const originalSync = handle.sync.bind(handle);
			handle.sync = async () => { events.push("sync"); return originalSync(); };
			return handle;
		});
		const renameSpy = spyOn(nodeFs, "rename").mockImplementation(async (from, to) => {
			events.push("rename");
			return originalRename(from, to);
		});
		try {
			const result = await atomicWrite(createFileSystem(), path.replaceAll("\\", "/"), "data");

			expect(result.ok).toBe(true);
		} finally {
			openSpy.mockRestore();
			renameSpy.mockRestore();
		}
		expect(events).toEqual(["sync", "rename"]);
	});
});

describe("exclusive creation of a file", () => {
	test("a failure is returned as an error result, not thrown", async () => {
		const blocker = join(directory, "blocker");
		await writeFile(blocker, "i am a file");

		const result = await createFileSystem().writeExclusive(join(blocker, "rig.lock").replaceAll("\\", "/"), "x");

		expect(result.ok).toBe(false);
	});

	test("an existing file gives false and is left untouched", async () => {
		const path = join(directory, "rig.lock");
		await writeFile(path, "owner");

		const result = await createFileSystem().writeExclusive(path.replaceAll("\\", "/"), "intruder");

		expect(result).toEqual(ok(false));
		expect(await readFile(path, "utf8")).toBe("owner");
	});

	test("the file appears under its final name already complete and no temp file remains", async () => {
		const path = join(directory, "rig.lock");
		const contentAtLinkTime: string[] = [];
		const originalLink = nodeFs.link.bind(nodeFs);
		const linkSpy = spyOn(nodeFs, "link").mockImplementation(async (existing, created) => {
			contentAtLinkTime.push(await readFile(existing.toString(), "utf8"));
			contentAtLinkTime.push(String(await stat(created.toString()).then(() => "present", () => "absent")));
			return originalLink(existing, created);
		});
		try {
			const result = await createFileSystem().writeExclusive(path.replaceAll("\\", "/"), "complete-owner-record");

			expect(result).toEqual(ok(true));
		} finally {
			linkSpy.mockRestore();
		}
		expect(contentAtLinkTime).toEqual(["complete-owner-record", "absent"]);
		expect(await readFile(path, "utf8")).toBe("complete-owner-record");
		expect(await readdir(directory)).toEqual(["rig.lock"]);
	});

	test("a crash while filling the temp file leaves no lock file behind", async () => {
		const path = join(directory, "rig.lock");
		const openSpy = spyOn(nodeFs, "open").mockRejectedValue(new Error("killed"));
		try {
			const result = await createFileSystem().writeExclusive(path.replaceAll("\\", "/"), "x");

			expect(result.ok).toBe(false);
		} finally {
			openSpy.mockRestore();
		}
		expect(await readdir(directory)).toEqual([]);
	});
});

describe("owner start time", () => {
	const runner = (answer: Result<ProcessOutput>) => ({ run: async (): Promise<Result<ProcessOutput>> => answer });
	const output = (stdout: string, exitCode = 0, stderr = ""): Result<ProcessOutput> => ok({ stdout, stderr, exitCode });

	test("windows: a failed PowerShell is unknown, never 'no such process'", async () => {
		expect((await ownerStartTime(1, runner(err("spawn failed")), "win32")).ok).toBe(false);
		expect((await ownerStartTime(1, runner(output("", 1, "denied")), "win32")).ok).toBe(false);
		expect((await ownerStartTime(1, runner(output("garbage")), "win32")).ok).toBe(false);
	});

	test("windows: empty output with a clean exit means the process does not exist", async () => {
		expect(await ownerStartTime(1, runner(output("\r\n")), "win32")).toEqual(ok(null));
	});

	test("windows: ticks are returned as the start time", async () => {
		expect(await ownerStartTime(1, runner(output(`${WINDOWS_TICKS}\r\n`)), "win32")).toEqual(ok(WINDOWS_TICKS));
	});

	test("linux: a missing /proc entry means no such process, any other failure is unknown", async () => {
		if (process.platform !== "linux") return;
		expect(await ownerStartTime(LINUX_ABSENT_PID, runner(output("")), "linux")).toEqual(ok(null));
		const own = await ownerStartTime(process.pid, runner(output("")), "linux");
		expect(own.ok && typeof own.value === "number").toBe(true);
	});

	test("darwin: ps runs under LC_ALL=C, so the lstart date is not localized", async () => {
		const calls: Array<{ command: string; options: ProcessOptions | undefined }> = [];
		const recorder = {
			run: async (command: string, _args: readonly string[], options?: ProcessOptions): Promise<Result<ProcessOutput>> => {
				calls.push({ command, options });
				return output("");
			},
		};
		await ownerStartTime(1, recorder, "darwin");
		expect(calls.map((call) => call.command)).toEqual(["ps"]);
		expect(calls[0]?.options?.environment?.LC_ALL).toBe("C");
	});

	test("an unsupported host is unknown", async () => {
		expect((await ownerStartTime(1, runner(output("")), "aix")).ok).toBe(false);
	});
});

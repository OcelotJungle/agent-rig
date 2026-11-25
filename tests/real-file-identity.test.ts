import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { distinctFiles } from "../src/transcript-path.js";

const TEMP_DIRECTORY_PREFIX = "agent-rig-file-identity-";
// A junction needs no privilege on Windows and is a symlink to a directory elsewhere.
const DIRECTORY_LINK_TYPE = "junction";

let temporary: string | undefined;

beforeEach(async () => {
	temporary = await fs.mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
});

afterEach(async () => {
	if (temporary !== undefined) await fs.rm(temporary, { recursive: true, force: true });
	temporary = undefined;
});

const runtimeOf = async () => {
	const runtime = await createRealRuntime();
	if (!runtime.ok) throw new Error(runtime.error);
	return runtime.value;
};

describe("the real file system names a file by where it really is", () => {
	test("a file under a linked directory is one distinct file with its real path", async () => {
		const root = temporary ?? "";
		const shared = join(root, "shared", "projects");
		await fs.mkdir(join(shared, "proj"), { recursive: true });
		await fs.writeFile(join(shared, "proj", "a.jsonl"), "{}\n");
		await fs.mkdir(join(root, "config"), { recursive: true });
		await fs.symlink(shared, join(root, "config", "projects"), DIRECTORY_LINK_TYPE);
		const runtime = await runtimeOf();
		const files = await distinctFiles(runtime, [{ path: join(shared, "proj", "a.jsonl") }, { path: join(root, "config", "projects", "proj", "a.jsonl") }]);
		expect(files.length).toBe(1);
		expect(files[0]?.path.toLowerCase()).toBe((await fs.realpath(join(shared, "proj", "a.jsonl"))).replaceAll("\\", "/").toLowerCase());
	});
	test("a missing file keeps its path and two different files stay two", async () => {
		const root = temporary ?? "";
		await fs.writeFile(join(root, "one.jsonl"), "{}\n");
		await fs.writeFile(join(root, "two.jsonl"), "{}\n");
		const runtime = await runtimeOf();
		const files = await distinctFiles(runtime, [{ path: join(root, "one.jsonl") }, { path: join(root, "two.jsonl") }, { path: join(root, "none.jsonl") }]);
		expect(files.length).toBe(3);
		expect(files[2]?.path).toBe(join(root, "none.jsonl").replaceAll("\\", "/"));
	});
	test("a listed entry that links to a directory is a directory; a link to a file and a broken link are not", async () => {
		const root = temporary ?? "";
		await fs.mkdir(join(root, "real-dir"));
		await fs.writeFile(join(root, "file.txt"), "x");
		await fs.mkdir(join(root, "listed"));
		await fs.symlink(join(root, "real-dir"), join(root, "listed", "dir-link"), DIRECTORY_LINK_TYPE);
		await fs.symlink(join(root, "gone"), join(root, "listed", "broken-link"), DIRECTORY_LINK_TYPE);
		const runtime = await runtimeOf();
		const entries = await runtime.fs.listDirectory(join(root, "listed"));
		expect(entries.find((entry) => entry.name === "dir-link")?.directory).toBe(true);
		expect(entries.find((entry) => entry.name === "broken-link")?.directory).toBe(false);
	});
});

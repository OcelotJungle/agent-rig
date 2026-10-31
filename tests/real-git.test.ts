import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRealGitAdapter, createRealRuntime } from "../src/commands/real-runtime.js";

const TEMP_DIRECTORY_PREFIX = "agent-rig-real-git-";
const TRACKED_FILE = "tracked.txt";
const UNRELATED_FILE = "unrelated.txt";

let temporaryRoot: string | undefined;
let repositoryPath = "";

describe("real git adapter", () => {
	beforeEach(async () => {
		temporaryRoot = await fs.mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
		repositoryPath = join(temporaryRoot, "repo");
		await fs.mkdir(repositoryPath, { recursive: true });
		runGit(repositoryPath, ["init", "--initial-branch=main"]);
		runGit(repositoryPath, ["config", "user.name", "Rig Test"]);
		runGit(repositoryPath, ["config", "user.email", "rig-test@example.invalid"]);
		await fs.writeFile(join(repositoryPath, TRACKED_FILE), "before\n", "utf8");
		await fs.writeFile(join(repositoryPath, UNRELATED_FILE), "original\n", "utf8");
		runGit(repositoryPath, ["add", TRACKED_FILE, UNRELATED_FILE]);
		runGit(repositoryPath, ["commit", "-m", "initial"]);
	});

	afterEach(async () => {
		if (temporaryRoot !== undefined) {
			await fs.rm(temporaryRoot, { recursive: true, force: true });
			temporaryRoot = undefined;
		}
	});

	test("rollback uses reset --keep and preserves an unrelated local edit", async () => {
		const before = runGit(repositoryPath, ["rev-parse", "HEAD"]);
		await fs.writeFile(join(repositoryPath, TRACKED_FILE), "updated\n", "utf8");
		runGit(repositoryPath, ["add", TRACKED_FILE]);
		runGit(repositoryPath, ["commit", "-m", "update"]);
		await fs.writeFile(join(repositoryPath, UNRELATED_FILE), "local edit\n", "utf8");

		const runtime = await createRealRuntime();
		expect(runtime.ok).toBe(true);
		if (!runtime.ok) return;
		const git = createRealGitAdapter(runtime.value.process, { repo: repositoryPath, hub: repositoryPath });

		const reset = await git.resetKeep("rig", before);

		expect(reset.ok).toBe(true);
		expect(runGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(before);
		expect(await fs.readFile(join(repositoryPath, TRACKED_FILE), "utf8")).toBe("before\n");
		expect(await fs.readFile(join(repositoryPath, UNRELATED_FILE), "utf8")).toBe("local edit\n");
	});

	test("rollback refuses a conflicting local edit and leaves it intact", async () => {
		const before = runGit(repositoryPath, ["rev-parse", "HEAD"]);
		await fs.writeFile(join(repositoryPath, TRACKED_FILE), "updated\n", "utf8");
		runGit(repositoryPath, ["add", TRACKED_FILE]);
		runGit(repositoryPath, ["commit", "-m", "update"]);
		const attempted = runGit(repositoryPath, ["rev-parse", "HEAD"]);
		await fs.writeFile(join(repositoryPath, TRACKED_FILE), "local conflicting edit\n", "utf8");

		const runtime = await createRealRuntime();
		expect(runtime.ok).toBe(true);
		if (!runtime.ok) return;
		const git = createRealGitAdapter(runtime.value.process, { repo: repositoryPath, hub: repositoryPath });

		const reset = await git.resetKeep("rig", before);

		expect(reset.ok).toBe(false);
		expect(runGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(attempted);
		expect(await fs.readFile(join(repositoryPath, TRACKED_FILE), "utf8")).toBe("local conflicting edit\n");
	});
});

const runGit = (directory: string, args: readonly string[]): string => {
	const result = spawnSync("git", [...args], { cwd: directory, encoding: "utf8" });
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
};

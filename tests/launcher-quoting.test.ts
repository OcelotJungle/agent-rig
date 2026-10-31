import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const FEATURES_ROOT = fileURLToPath(new URL("../features/", import.meta.url));
// A launcher path after an interpreter flag without quotes breaks when the clone path has spaces.
const UNQUOTED_CLONE_COMMAND = /-I \{\{CLONE\}\}/;
const TEXT_EXTENSIONS = [".md", ".json"] as const;

const listFiles = async (directory: string): Promise<string[]> => {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map(async (entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	}));
	return nested.flat();
};

describe("launcher commands", () => {
	test("never use the clone path without quotes", async () => {
		const files = (await listFiles(FEATURES_ROOT)).filter((path) => TEXT_EXTENSIONS.some((extension) => path.endsWith(extension)));
		const offenders: string[] = [];
		for (const path of files) {
			if (UNQUOTED_CLONE_COMMAND.test(await readFile(path, "utf8"))) offenders.push(path);
		}
		expect(offenders).toEqual([]);
	});
});

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

// The only source of the `rig` wrappers is `rig install` (installShim in src/commands/install.ts),
// which writes ~/.local/bin/rig and rig.cmd with the absolute bun and clone paths.
describe("rig command wrappers", () => {
	test("the repository keeps no second set of wrapper scripts", () => {
		expect(existsSync(join(REPOSITORY_ROOT, "shims"))).toBe(false);
		expect(existsSync(join(REPOSITORY_ROOT, "bin", "rig"))).toBe(false);
	});

	test("package.json does not point bin at a deleted wrapper", async () => {
		const text = await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8");
		expect(text).not.toContain("bin/rig");
		expect(text).not.toContain("\"bin\"");
	});

	test("docker helpers bootstrap through the CLI entry, not bin/rig", async () => {
		const text = await readFile(join(REPOSITORY_ROOT, "tests", "docker", "common.sh"), "utf8");
		expect(text).not.toContain("bin/rig\"");
		expect(text).toContain("src/cli.ts");
	});
});

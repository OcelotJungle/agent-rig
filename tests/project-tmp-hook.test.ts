import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const REPOSITORY = join(import.meta.dir, "..");
const HOOK_SCRIPT = join(REPOSITORY, "base", "hooks", "project-tmp.sh");
// Git Bash on Windows; a bare `bash` can resolve to WSL's System32\bash.exe.
const WINDOWS_BASH = "C:/Program Files/Git/bin/bash.exe";
const POSIX_BASH = "bash";
const EXECUTABLE_MODE = 0o755;
const PROCESS_SUCCESS = 0;
const CYGPATH_NAME = "cygpath";
const POWERSHELL_NAME = "pwsh.exe";
const POWERSHELL_ARGS_NAME = "powershell-args.txt";
// The clone's own settings script, found next to the hook: base/hooks/project-tmp-settings.ps1.
const SETTINGS_SCRIPT_PATTERN = /base[\\/]hooks[\\/]project-tmp-settings\.ps1$/;
const WINDOWS_PLATFORM = "win32";

// Stand-ins for Windows tools, so the Windows branch of the hook runs on any machine.
// cygpath prints its last argument unchanged.
const CYGPATH_SCRIPT = String.raw`#!/usr/bin/env bash
for last; do :; done
printf '%s\n' "$last"
`;

// The fake PowerShell logs its arguments and fails when the -File script does not exist.
const POWERSHELL_SCRIPT = String.raw`#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "$@" > "$dir/powershell-args.txt"
previous=""
for arg in "$@"; do
  if [ "$previous" = "-File" ] && [ ! -f "$arg" ]; then
    echo "script not found: $arg" >&2
    exit 1
  fi
  previous="$arg"
done
exit 0
`;

describe("project-tmp.sh on the Windows branch", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "project-tmp-hook-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	test("passes the clone's own settings script, not a path under HOME", () => {
		const home = join(scratch, "home");
		const project = join(scratch, "project");
		const fakeDir = join(scratch, "bin");
		mkdirSync(home);
		mkdirSync(project);
		mkdirSync(fakeDir);
		writeTool(fakeDir, CYGPATH_NAME, CYGPATH_SCRIPT);
		writeTool(fakeDir, POWERSHELL_NAME, POWERSHELL_SCRIPT);
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			CLAUDE_PROJECT_DIR: project,
			[pathKey]: [fakeDir, process.env[pathKey] ?? ""].join(delimiter),
			// Keeps git from finding the real repository above the scratch folder.
			GIT_CEILING_DIRECTORIES: dirname(scratch),
		};
		const bash = process.platform === WINDOWS_PLATFORM ? WINDOWS_BASH : POSIX_BASH;

		const result = spawnSync(bash, [HOOK_SCRIPT], { cwd: project, env, encoding: "utf8" });

		expect(result.stderr).not.toContain("failed to update");
		expect(result.status).toBe(PROCESS_SUCCESS);
		const passed = readFileSync(join(fakeDir, POWERSHELL_ARGS_NAME), "utf8").split(/\r?\n/);
		expect(passed.some((arg) => SETTINGS_SCRIPT_PATTERN.test(arg))).toBe(true);
	});
});

const writeTool = (directory: string, name: string, content: string): void => {
	const path = join(directory, name);
	writeFileSync(path, content);
	chmodSync(path, EXECUTABLE_MODE);
};

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

describe("project-tmp.sh SessionStart warnings", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "project-tmp-warning-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	const runHook = (project: string, overrides: Record<string, string | undefined> = {}) => {
		const home = join(scratch, "home");
		mkdirSync(home, { recursive: true });
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			CLAUDE_PROJECT_DIR: project,
			TEMP: join(scratch, "foreign-temp"),
			TMPDIR: join(scratch, "foreign-temp"),
			TMP: join(scratch, "foreign-temp"),
			[pathKey]: process.env[pathKey],
			GIT_CEILING_DIRECTORIES: dirname(scratch),
			...overrides,
		};
		const bash = process.platform === WINDOWS_PLATFORM ? WINDOWS_BASH : POSIX_BASH;
		return spawnSync(bash, [HOOK_SCRIPT], { cwd: project, env, encoding: "utf8" });
	};

	test("warns when CLAUDE_ENV_FILE is absent and inherited TEMP is foreign", () => {
		const project = join(scratch, "project");
		mkdirSync(project);

		const result = runHook(project);

		expect(result.stdout).toContain("WARNING:");
		expect(result.stdout).toContain(join(scratch, "foreign-temp").replaceAll("\\", "/"));
		expect(result.stdout).toContain(join(project, ".tmp").replaceAll("\\", "/"));
		expect(result.stdout.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
	});

	test("stays silent when CLAUDE_ENV_FILE is updated", () => {
		const project = join(scratch, "project");
		const envFile = join(scratch, "claude-env");
		mkdirSync(project);
		writeFileSync(envFile, "");

		const result = runHook(project, { CLAUDE_ENV_FILE: envFile });

		expect(result.stdout).toBe("");
		expect(readFileSync(envFile, "utf8")).toContain("# project-tmp hook");
	});

	test("stays silent when inherited TEMP already names project .tmp", () => {
		const project = join(scratch, "project");
		mkdirSync(project);
		const projectTemp = join(project, ".tmp");

		const result = runHook(project, { TEMP: projectTemp, TMPDIR: projectTemp, TMP: projectTemp });

		expect(result.stdout).toBe("");
	});

	test("warns and names settings step when settings update fails", () => {
		const project = join(scratch, "project");
		mkdirSync(project);
		writeFileSync(join(project, ".claude"), "not a directory");

		const result = runHook(project, { CLAUDE_ENV_FILE: join(scratch, "claude-env") });

		expect(result.stdout).toContain("WARNING:");
		expect(result.stdout).toContain("settings.local.json step failed");
		expect(result.stderr).toContain("failed to update .claude/settings.local.json");
	});

	test("warns when creating project .tmp fails", () => {
		const project = join(scratch, "project");
		mkdirSync(project);
		writeFileSync(join(project, ".tmp"), "not a directory");

		const result = runHook(project);

		expect(result.stdout).toContain("WARNING:");
		expect(result.stdout).toContain("Creating project .tmp failed");
		expect(result.stdout).toContain(join(project, ".tmp").replaceAll("\\", "/"));
		expect(result.stdout.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
	});

	test("stays silent outside a project in the home directory", () => {
		const home = join(scratch, "home");
		mkdirSync(home);

		const result = runHook(home, { CLAUDE_PROJECT_DIR: home });

		expect(result.stdout).toBe("");
	});
});

const writeTool = (directory: string, name: string, content: string): void => {
	const path = join(directory, name);
	writeFileSync(path, content);
	chmodSync(path, EXECUTABLE_MODE);
};

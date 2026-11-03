import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(import.meta.dir, "..", "scripts", "prepare-server.sh");
// Git Bash on Windows; a bare `bash` can resolve to WSL's System32\bash.exe.
const WINDOWS_BASH = "C:/Program Files/Git/bin/bash.exe";
const POSIX_BASH = "bash";
const WINDOWS_PLATFORM = "win32";
const EXECUTABLE_MODE = 0o755;
const PROCESS_SUCCESS = 0;
const PROCESS_FAILURE = 1;
// Each test runs the real script through Git Bash, one to two runs with stand-in tools: about 1 s alone on Windows,
// over the 5 s default under the full suite's parallel load (measured 5.2 s), so the limit has a wide margin.
const SCRIPT_TEST_TIMEOUT_MS = 30_000;
const TOOLS = ["apt-get", "systemctl", "loginctl"];
const SETTINGS = '{"channelsEnabled":true,"allowedChannelPlugins":[{"plugin":"telegram-hub","marketplace":"telegram-hub"}]}\n';
const OWN_FILE_TEXT = '{"permissions":{}}\n';
const EDITED_FILE_TEXT = '{"channelsEnabled":true,"allowedChannelPlugins":[{"plugin":"telegram-hub","marketplace":"telegram-hub"}],"permissions":{}}\n';

// Each stand-in logs its name and arguments, and exits with FAKE_FAIL's code when FAKE_FAIL names it.
const FAKE_TOOL = [
	"#!/usr/bin/env bash",
	'name="$(basename "$0")"',
	'printf "%s %s\\n" "$name" "$*" >> "$FAKE_CALLS"',
	'[ "$FAKE_FAIL" != "$name" ]',
	"",
].join("\n");

describe("prepare-server.sh", () => {
	let scratch: string;
	let settings: string;
	let calls: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "prepare-server-"));
		settings = join(scratch, "claude-code", "managed-settings.json");
		calls = join(scratch, "calls.txt");
		for (const tool of TOOLS) {
			writeFileSync(join(scratch, tool), FAKE_TOOL);
			chmodSync(join(scratch, tool), EXECUTABLE_MODE);
		}
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	const run = (args: string[], fail = "") => spawnSync(process.platform === WINDOWS_PLATFORM ? WINDOWS_BASH : POSIX_BASH, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH ?? ""}`, RIG_MANAGED_SETTINGS: settings, FAKE_CALLS: calls, FAKE_FAIL: fail },
	});
	const loggedCalls = (): string[] => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];

	test("it installs the packages, starts cron, enables linger and allows the channel", () => {
		const result = run(["rig"]);

		expect(result.status).toBe(PROCESS_SUCCESS);
		expect(loggedCalls()).toEqual([
			"apt-get update",
			"apt-get install -y git python3 bash cron tmux unzip ca-certificates curl nodejs",
			"systemctl enable --now cron",
			"loginctl enable-linger rig",
		]);
		expect(readFileSync(settings, "utf8")).toBe(SETTINGS);
	}, SCRIPT_TEST_TIMEOUT_MS);

	test("it can run again over its own settings file", () => {
		expect(run(["rig"]).status).toBe(PROCESS_SUCCESS);

		expect(run(["rig"]).status).toBe(PROCESS_SUCCESS);
		expect(readFileSync(settings, "utf8")).toBe(SETTINGS);
	}, SCRIPT_TEST_TIMEOUT_MS);

	test("it changes nothing when the settings file belongs to someone else", () => {
		expect(run(["rig"]).status).toBe(PROCESS_SUCCESS);
		writeFileSync(settings, OWN_FILE_TEXT);
		rmSync(calls);

		const result = run(["rig"]);

		expect(result.status).toBe(PROCESS_FAILURE);
		expect(result.stderr).toContain("allowedChannelPlugins");
		expect(readFileSync(settings, "utf8")).toBe(OWN_FILE_TEXT);
		expect(loggedCalls()).toEqual([]);
	}, SCRIPT_TEST_TIMEOUT_MS);

	test("it keeps a file the owner edited to allow the channel", () => {
		expect(run(["rig"]).status).toBe(PROCESS_SUCCESS);
		writeFileSync(settings, EDITED_FILE_TEXT);

		expect(run(["rig"]).status).toBe(PROCESS_SUCCESS);
		expect(readFileSync(settings, "utf8")).toBe(EDITED_FILE_TEXT);
	}, SCRIPT_TEST_TIMEOUT_MS);

	test("it stops at a failed step and does not grant the channel", () => {
		const result = run(["rig"], "loginctl");

		expect(result.status).not.toBe(PROCESS_SUCCESS);
		expect(existsSync(settings)).toBe(false);
	}, SCRIPT_TEST_TIMEOUT_MS);

	test("it asks for the user name", () => {
		const result = run([]);

		expect(result.status).not.toBe(PROCESS_SUCCESS);
		expect(loggedCalls()).toEqual([]);
	}, SCRIPT_TEST_TIMEOUT_MS);
});

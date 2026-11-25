import type { ProcessEntry, ProcessOutput } from "../src/ports.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";

import { readConsoleText } from "../src/commands/console-text.js";
import { parseProcessTable } from "../src/commands/process-table.js";
import { screenExcerpt, windowProcesses, windowTrees } from "../src/launch-window.js";
import { messagesFor } from "../src/messages.js";
import { err, ok } from "../src/result.js";

const ID = "11111111-1111-1111-1111-111111111111";
const SPAWNED_AT = new Date("2026-01-01T00:00:10.000Z");
const BEFORE = "2026-01-01T00:00:05.000Z";
const AFTER = "2026-01-01T00:00:20.000Z";
const LATER = "2026-01-01T00:00:30.000Z";
const messages = messagesFor("en");
const launched = { sessionId: ID, earlier: new Set<string>(), spawnedAt: SPAWNED_AT };
const row = (pid: number, parent: number, name: string, commandLine: string, createdAt: string | null): ProcessEntry => ({ pid, parent, name, commandLine, createdAt });
const pidsOf = (entries: readonly ProcessEntry[]): number[] => entries.map((entry) => entry.pid);

describe("windowProcesses", () => {
	test("takes processes of this session's resume line created at or after the spawn, and nothing else", () => {
		const table = [
			row(1, 0, "claude.exe", `claude --resume ${ID}`, AFTER),
			row(2, 0, "claude.exe", `claude --resume "${ID}" --x`, SPAWNED_AT.toISOString()),
			row(3, 0, "claude.exe", `claude --resume ${ID}`, BEFORE),
			row(4, 0, "claude.exe", `claude --resume ${ID}`, null),
			row(5, 0, "claude.exe", `claude --resume ${ID}-copy`, AFTER),
			row(6, 0, "claude.exe", "claude --resume 22222222-2222-2222-2222-222222222222", AFTER),
			row(7, 0, "claude.exe", `claude --resume ${ID}`, "not a time"),
			row(8, 0, "claude.exe", `claude -r ${ID}`, AFTER),
		];
		expect(pidsOf(windowProcesses(table, launched))).toEqual([1, 2]);
	});
	test("leaves out the processes the record named before, by pid and creation time together", () => {
		const table = [row(1, 0, "claude.exe", `claude --resume ${ID}`, AFTER), row(2, 0, "claude.exe", `claude --resume ${ID}`, AFTER)];
		const earlier = new Set([`1:${AFTER}`, `2:${LATER}`]);
		expect(pidsOf(windowProcesses(table, { ...launched, earlier }))).toEqual([2]);
	});
	test("never takes the terminal's own processes, whatever their command line", () => {
		const table = ["WindowsTerminal.exe", "wt.exe", "OpenConsole.exe", "windowsterminal.EXE"].map((name, index) => row(index + 1, 0, name, `${name} --resume ${ID}`, AFTER));
		expect(windowProcesses(table, launched)).toEqual([]);
	});
	test("a session id with pattern characters matches only itself", () => {
		const odd = { ...launched, sessionId: "a.c" };
		expect(pidsOf(windowProcesses([row(1, 0, "x", "claude --resume a.c", AFTER), row(2, 0, "x", "claude --resume abc", AFTER)], odd))).toEqual([1]);
	});
});

describe("windowTrees", () => {
	const TERMINAL = 400;
	const terminal = row(TERMINAL, 1, "WindowsTerminal.exe", "WindowsTerminal.exe", BEFORE);
	test("roots are the members whose parent is not a member, the deepest member is the one furthest down", () => {
		const table = [terminal, row(10, TERMINAL, "cmd.exe", `cmd /c claude --resume ${ID}`, AFTER), row(11, 10, "claude.exe", `claude --resume ${ID}`, AFTER), row(12, 11, "node.exe", `node --resume ${ID}`, LATER)];
		const trees = windowTrees(table, windowProcesses(table, launched));
		expect(pidsOf(trees.roots)).toEqual([10]);
		expect(trees.deepest?.pid).toBe(12);
	});
	test("the newest member wins a tie in depth", () => {
		const table = [row(10, 1, "a", `x --resume ${ID}`, AFTER), row(11, 1, "b", `x --resume ${ID}`, LATER)];
		const trees = windowTrees(table, windowProcesses(table, launched));
		expect(pidsOf(trees.roots)).toEqual([10, 11]);
		expect(trees.deepest?.pid).toBe(11);
	});
	test("a member with a terminal process under it is never a root: killing its tree would close other windows", () => {
		const holder = row(10, 1, "cmd.exe", `cmd /c wt --resume ${ID}`, AFTER);
		const table = [holder, row(TERMINAL, 10, "WindowsTerminal.exe", "WindowsTerminal.exe", AFTER), row(11, TERMINAL, "claude.exe", `claude --resume ${ID}`, AFTER)];
		const trees = windowTrees(table, windowProcesses(table, launched));
		expect(pidsOf(trees.roots)).toEqual([11]);
		expect(trees.deepest?.pid).toBe(11);
	});
	test("a parent pid reused by a process created after its child is not the child's parent", () => {
		const table = [row(10, 1, "unrelated.exe", "unrelated", LATER), row(11, 10, "claude.exe", `claude --resume ${ID}`, AFTER)];
		const trees = windowTrees(table, windowProcesses(table, launched));
		expect(pidsOf(trees.roots)).toEqual([11]);
	});
	test("no members give no roots and no deepest process", () => {
		expect(windowTrees([terminal], [])).toEqual({ roots: [], deepest: null });
	});
	test("a cycle in the table ends instead of looping", () => {
		const table = [row(10, 11, "a", `x --resume ${ID}`, AFTER), row(11, 10, "b", `x --resume ${ID}`, AFTER)];
		const trees = windowTrees(table, windowProcesses(table, launched));
		expect(pidsOf(trees.roots)).toEqual([]);
		expect(trees.deepest).toBeNull();
	});
});

describe("screenExcerpt", () => {
	test("keeps non-empty lines and trims line ends", () => {
		expect(screenExcerpt("a  \r\n\r\n   \nb\n")).toBe("a\nb");
	});
	test("keeps the last 12 lines", () => {
		const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
		expect(screenExcerpt(text).split("\n")).toEqual(Array.from({ length: 12 }, (_, index) => `line ${index + 19}`));
	});
	test("keeps the last 800 characters of a long tail", () => {
		const text = `${"x".repeat(2000)}\nend`;
		const excerpt = screenExcerpt(text);
		expect(excerpt.length).toBeLessThanOrEqual(800);
		expect(excerpt.endsWith("end")).toBe(true);
	});
	test("an empty or blank screen is an empty excerpt", () => {
		expect(screenExcerpt("")).toBe("");
		expect(screenExcerpt(" \n\t\n")).toBe("");
	});
});

describe("parseProcessTable", () => {
	const good = { pid: 5, parent: 1, name: "a.exe", commandLine: "a --x", createdAt: AFTER };
	test("reads rows, a null creation time included", () => {
		expect(parseProcessTable(JSON.stringify([good, { ...good, pid: 6, createdAt: null }]), messages)).toEqual(ok([good, { ...good, pid: 6, createdAt: null }]));
	});
	test("one row that does not fit fails the whole table", () => {
		for (const bad of [{ ...good, pid: "5" }, { ...good, parent: 1.5 }, { ...good, name: 1 }, { ...good, commandLine: null }, { ...good, createdAt: 3 }, null, "row"]) {
			expect(parseProcessTable(JSON.stringify([good, bad]), messages)).toEqual(err(messages.failure.processTableInvalid()));
		}
	});
	test("text that is not a JSON array fails", () => {
		for (const text of ["", "not json", "{}", "null"]) expect(parseProcessTable(text, messages)).toEqual(err(messages.failure.processTableInvalid()));
	});
});

describe("readConsoleText", () => {
	const output = (stdout: string, exitCode = 0, stderr = ""): ProcessOutput => ({ stdout, stderr, exitCode });
	const fakeRun = (result: Result<ProcessOutput>) => {
		const calls: { command: string; args: readonly string[]; timeoutMs: number | undefined }[] = [];
		return { calls, run: async (command: string, args: readonly string[], options?: { timeoutMs?: number }) => { calls.push({ command, args, timeoutMs: options?.timeoutMs }); return result; } };
	};
	test("a host that is not Windows has no console to read and never runs anything", async () => {
		const fake = fakeRun(ok(output("")));
		expect(await readConsoleText(fake, messages, "linux", 7)).toEqual(err(messages.failure.consoleReadUnsupported("linux")));
		expect(fake.calls).toEqual([]);
	});
	test("runs the hidden reader with the pid, bounded by a timeout, and decodes its base64 output", async () => {
		const fake = fakeRun(ok(output(`${Buffer.from("Trust this folder?\nYes", "utf8").toString("base64")}\r\n`)));
		expect(await readConsoleText(fake, messages, "win32", 7)).toEqual(ok("Trust this folder?\nYes"));
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].command).toBe("powershell.exe");
		expect(fake.calls[0].args.at(-1)).toBe("7");
		expect(fake.calls[0].timeoutMs).toBeGreaterThan(0);
	});
	test("an empty screen is an empty text, not an error", async () => {
		expect(await readConsoleText(fakeRun(ok(output(""))), messages, "win32", 7)).toEqual(ok(""));
	});
	test("a failed helper, a helper that did not run and output that is not base64 are errors", async () => {
		expect(await readConsoleText(fakeRun(ok(output("", 3, " no console\n"))), messages, "win32", 7)).toEqual(err(messages.failure.consoleReadFailed("no console")));
		expect(await readConsoleText(fakeRun(err("timed out")), messages, "win32", 7)).toEqual(err("timed out"));
		expect(await readConsoleText(fakeRun(ok(output("not*base64"))), messages, "win32", 7)).toEqual(err(messages.failure.consoleTextInvalid()));
	});
});

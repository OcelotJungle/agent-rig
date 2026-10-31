import type { Result } from "../result.js";
import type { ProcessOptions, ProcessOutput } from "../ports.js";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform as hostPlatform } from "node:os";
import { win32 } from "node:path";

import { err, errorText, ok } from "../result.js";
import { PROCESS_FAILURE_EXIT_CODE } from "../ports.js";

// An external command (git, claude plugin) that hangs is killed after 15 minutes and counts as failed.
const MINUTES_PER_TIMEOUT = 15;
const MILLISECONDS_PER_MINUTE = 60_000;
export const PROCESS_TIMEOUT_MS = MINUTES_PER_TIMEOUT * MILLISECONDS_PER_MINUTE;
// Order in which Windows resolves a bare command name that has no extension.
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"] as const;
const WINDOWS_SCRIPT_EXTENSIONS = [".cmd", ".bat"] as const;
const WINDOWS_PATH_SEPARATOR = ";";
// cmd.exe expands %VAR% even inside double quotes and cannot escape a double quote there.
const CMD_UNSAFE_ARGUMENT = /["%\r\n]/;

export type RunnerKind = "windows" | "posix";
// start() arms a one-shot timer and returns a function that disarms it.
export type ProcessTimer = { start(milliseconds: number, onExpire: () => void): () => void };
export type ProcessKiller = (child: ReturnType<typeof spawn>, kind: RunnerKind) => Promise<void>;
export type ProcessLimits = { timeoutMs: number; timer: ProcessTimer; kill?: ProcessKiller };
export type SpawnPlan = { command: string; args: string[]; verbatim: boolean };

const realTimer: ProcessTimer = {
	start: (milliseconds, onExpire) => {
		const handle = setTimeout(onExpire, milliseconds);
		return () => clearTimeout(handle);
	},
};
export const DEFAULT_PROCESS_LIMITS: ProcessLimits = { timeoutMs: PROCESS_TIMEOUT_MS, timer: realTimer };

const hasExtension = (command: string, extensions: readonly string[]): boolean =>
	extensions.some((extension) => command.toLowerCase().endsWith(extension));

const resolveWindowsCommand = (command: string, pathEnvironment: string, exists: (path: string) => boolean): string => {
	const hasDirectory = command.includes("/") || command.includes("\\");
	const directories = hasDirectory ? [""] : pathEnvironment.split(WINDOWS_PATH_SEPARATOR).filter((directory) => directory.length > 0);
	// A bare name is not itself runnable on Windows, only its suffixed forms are.
	const extensions = hasExtension(command, WINDOWS_EXECUTABLE_EXTENSIONS) ? [""] : WINDOWS_EXECUTABLE_EXTENSIONS;
	for (const directory of directories) {
		for (const extension of extensions) {
			// win32.join: this branch always describes Windows paths, whatever host runs it.
			const candidate = `${directory.length > 0 ? win32.join(directory, command) : command}${extension}`;
			if (exists(candidate)) return candidate;
		}
	}
	return command;
};

const quoteForCmd = (value: string): string => `"${value}"`;

// Decides how to start a command. A .cmd or .bat file (npm.cmd, claude.cmd) cannot be spawned directly on Windows, so it
// runs through cmd.exe with every argument quoted; nothing else ever goes through a shell.
export const planSpawn = (
	kind: RunnerKind,
	command: string,
	args: readonly string[],
	pathEnvironment: string,
	exists: (path: string) => boolean = existsSync,
): Result<SpawnPlan> => {
	if (kind === "posix") return ok({ command, args: [...args], verbatim: false });
	const resolved = resolveWindowsCommand(command, pathEnvironment, exists);
	if (!hasExtension(resolved, WINDOWS_SCRIPT_EXTENSIONS)) return ok({ command: resolved, args: [...args], verbatim: false });
	const parts = [resolved, ...args];
	const unsafe = parts.find((part) => CMD_UNSAFE_ARGUMENT.test(part));
	if (unsafe !== undefined) return err(`Cannot pass ${JSON.stringify(unsafe)} to ${command} through cmd.exe: it contains a quote, percent sign or line break.`);
	return ok({ command: "cmd.exe", args: ["/d", "/s", "/c", `"${parts.map(quoteForCmd).join(" ")}"`], verbatim: true });
};

const killTree: ProcessKiller = (child, kind) => new Promise((resolveKill) => {
	const pid = child.pid;
	if (pid === undefined) {
		resolveKill();
		return;
	}
	if (kind === "windows") {
		const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.on("error", () => resolveKill());
		killer.on("close", () => resolveKill());
		return;
	}
	try {
		// The child leads its own process group (detached), so a negative pid reaches every descendant.
		process.kill(-pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	resolveKill();
});

export const runProcess = (
	pathEnvironment: string,
	command: string,
	args: readonly string[],
	options: ProcessOptions = {},
	limits: ProcessLimits = DEFAULT_PROCESS_LIMITS,
	kind: RunnerKind = hostPlatform() === "win32" ? "windows" : "posix",
): Promise<Result<ProcessOutput>> => new Promise((resolveResult) => {
	const plan = planSpawn(kind, command, args, pathEnvironment);
	if (!plan.ok) {
		resolveResult(plan);
		return;
	}
	let stdout = "";
	let stderr = "";
	let settled = false;
	let timedOut = false;
	let disarm: () => void = () => undefined;
	const timeoutFailure = (): Result<ProcessOutput> =>
		err(`${command} did not finish within ${Math.round(limits.timeoutMs / MILLISECONDS_PER_MINUTE)} minutes and was killed.`);
	const settle = (result: Result<ProcessOutput>): void => {
		if (settled) return;
		settled = true;
		disarm();
		resolveResult(result);
	};
	try {
		const environment: Record<string, string | undefined> = { ...process.env, PATH: pathEnvironment };
		// Without this git waits for a password on the terminal and hangs an unattended update.
		if (command === "git") environment.GIT_TERMINAL_PROMPT = "0";
		Object.assign(environment, options.environment);
		const child = spawn(plan.value.command, plan.value.args, {
			cwd: options.cwd,
			env: environment,
			windowsHide: true,
			windowsVerbatimArguments: plan.value.verbatim,
			detached: kind === "posix",
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: unknown) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
		child.on("error", (error) => settle(err(errorText(error))));
		// The killed child can report close before the killer returns, and that exit is still the timeout.
		child.on("close", (code) => settle(timedOut ? timeoutFailure() : ok({ stdout, stderr, exitCode: code ?? PROCESS_FAILURE_EXIT_CODE })));
		disarm = limits.timer.start(limits.timeoutMs, () => {
			if (settled) return;
			timedOut = true;
			void (limits.kill ?? killTree)(child, kind).then(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				settle(timeoutFailure());
			});
		});
		if (options.input === undefined) child.stdin.end();
		else child.stdin.end(options.input);
	} catch (error) {
		settle(err(errorText(error)));
	}
});

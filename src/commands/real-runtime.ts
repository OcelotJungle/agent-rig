import type { FileSystem } from "../file-system.js";
import type { Language, Messages } from "../messages.js";
import type { RuntimePorts, ProcessOptions, ProcessOutput, ProcessPorts, StreamingRun } from "../ports.js";
import type { HostPlatform } from "../node-file-operations.js";
import type { Result } from "../result.js";
import type { RigState } from "../state.js";
import type { RepositoryName, UpdatePorts } from "../update/update.js";

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir, platform as hostPlatform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeAssetFileSystem } from "../assets/node-asset-file-system.js";
import { atomicWrite, toSlashPath } from "../file-system.js";
import { DEFAULT_LANGUAGE, messagesFor } from "../messages.js";
import { makeDirectoryExclusive, modeOf, resolveTarget, writeDurable, writeExclusiveAtomic } from "../node-file-operations.js";
import { err, errorText, ok } from "../result.js";
import { readStoredLanguage } from "../state.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { runProcess, spawnDetached } from "./process-runner.js";
import { countGroupMembers, groupMemberPids, PROCESS_TABLE_ARGUMENTS } from "./run-members.js";
import { confineToKillOnCloseJob, jobMembersOtherThanSelf, terminateJobMembersOtherThanSelf } from "./windows-job.js";
import { parseVersion, VERSION_PATHS } from "../version-manifest.js";

// This keeps lock waits responsive without spinning while another command owns the lock.
const LOCK_POLL_INTERVAL_MS = 250;
const EXECUTABLE_FILE_MODE = 0o755;
// Whether a link ends at a directory; a broken link ends at none.
const linksToDirectory = async (path: string): Promise<boolean> => {
	try { return (await fs.stat(path)).isDirectory(); }
	catch { return false; }
};
// An aborted sleep clears its timer, so a caller that stopped waiting leaves no pending timer to hold the process open.
const sleepFor = (milliseconds: number, cancel?: AbortSignal): Promise<void> => new Promise((resolveSleep) => {
	const timer = setTimeout(resolveSleep, milliseconds);
	cancel?.addEventListener("abort", () => { clearTimeout(timer); resolveSleep(); }, { once: true });
});
// Once a run holds no process but its runner, the pipes of its command close at once; only a process that escaped the run
// (setsid, job breakaway) can still hold one open, and its output is outside the run. So the wait for the pipes is short.
const OUTPUT_DRAIN_MS = 2_000;
// Resolves when the promise does or after the bound, whichever is first; the timer never outlives the wait.
const waitUpTo = async (promise: Promise<void>, milliseconds: number): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<void>((resolveBound) => { timer = setTimeout(resolveBound, milliseconds); });
	try { await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
};
const LINUX_PROC_START_TIME_INDEX = 19;
const RTK_RELEASE_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";
const CODEX_PACKAGE = "@openai/codex";
const OPENCODE_PACKAGE = "opencode-ai@1.19.4";
const CHECKSUM_LENGTH = 64;
const WINDOWS_EXECUTABLE_SUFFIX = ".exe";
const UPDATE_BRANCH = "main";
const NO_LOCAL_COMMITS = 0;
const USER_RUNTIME_ROOT = "/run/user";
const SYSTEMCTL_INACTIVE_EXIT_CODE = 3;

type ReleaseAsset = { name: string; url: string };

type RealRuntimeOptions = { hostName?: NodeJS.Platform };

const realHome = (): string => toSlashPath(process.env.USERPROFILE ?? process.env.HOME ?? homedir());

// Reads only the language (state.json), without building the runtime: for `rig help` and usage errors.
export const readRealLanguage = async (): Promise<Language> => readStoredLanguage(createFileSystem(messagesFor(DEFAULT_LANGUAGE)), realHome());

export const createRealRuntime = async (options: RealRuntimeOptions = {}): Promise<Result<RuntimePorts>> => {
	const home = realHome();
	// The language is read here, once per command run, before anything that can fail and print; it travels in the
	// runtime from now on. A missing or unreadable state.json means the default language.
	const language = await readStoredLanguage(createFileSystem(messagesFor(DEFAULT_LANGUAGE)), home);
	const startMessages = messagesFor(language);
	const fileSystem = createFileSystem(startMessages);
	const hostName = options.hostName ?? hostPlatform();
	const platform = toPlatform(hostName);
	if (platform === null) return err(startMessages.runtime.platformUnsupported(hostName));
	const pathSeparator = platform === "windows" ? ";" : ":";
	const additionalPaths = [join(home, ".local", "bin"), join(home, ".bun", "bin")];
	const pathEnvironment = [...additionalPaths, process.env.PATH ?? ""].join(pathSeparator);
	const processPorts = createProcessPorts(pathEnvironment, language);
	const processStart = await ownerStartTime(process.pid, processPorts, startMessages);
	if (!processStart.ok) return err(startMessages.runtime.processStartUnknown(processStart.error));
	if (processStart.value === null) return err(startMessages.runtime.processNotFound());
	const pythonCommand = platform === "windows" ? "python" : "python3";
	const runtime: RuntimePorts = {
		fs: fileSystem,
		assetFs: createNodeAssetFileSystem(startMessages),
		process: processPorts,
		environment: { get: (name) => process.env[name], entries: () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) },
		stdin: { read: async () => await Bun.stdin.text() },
		lock: {
			fs: fileSystem,
			home,
			process: {
				pid: process.pid,
				startTime: processStart.value,
				ownerStartTime: (pid) => ownerStartTime(pid, processPorts, startMessages),
			},
			clock: { sleep: sleepFor, now: () => Date.now() },
			pollIntervalMs: LOCK_POLL_INTERVAL_MS,
			messages: startMessages,
		},
		home,
		currentDirectory: process.cwd(),
		resolvePath: (...parts) => toSlashPath(resolve(...parts)),
		executablePath: process.execPath,
		pythonCommand,
		pathEnvironment,
		platform,
		language,
		clock: {
			now: () => new Date(),
			nowText: () => new Date().toISOString(),
			sleep: sleepFor,
			every: (milliseconds, callback) => { const timer = setInterval(callback, milliseconds); return () => clearInterval(timer); },
		},
		ids: { next: () => randomUUID() },
		service: {
			start: () => runService(processPorts, platform, "start", currentUserBusSource(), messagesFor(runtime.language)),
			stop: () => runService(processPorts, platform, "stop", currentUserBusSource(), messagesFor(runtime.language)),
			isRunning: () => serviceIsRunning(processPorts, platform, currentUserBusSource(), messagesFor(runtime.language)),
			restart: () => runService(processPorts, platform, "restart", currentUserBusSource(), messagesFor(runtime.language)),
		},
		programs: { install: (name, binDirectory) => installProgram(name, binDirectory, runtime, platform) },
		temporary: {
			createDirectory: async (prefix) => {
				try {
					return ok(await fs.mkdtemp(join(tmpdir(), prefix)));
				} catch (error) {
					return err(startMessages.failure.temporaryCreateFailed(errorText(error)));
				}
			},
			removeDirectory: async (path) => {
				try {
					await fs.rm(path, { recursive: true, force: true });
					return ok(undefined);
				} catch (error) {
					return err(startMessages.failure.temporaryRemoveFailed(path, errorText(error)));
				}
			},
		},
		writeExecutable: async (path, content) => {
			const written = await atomicWrite(fileSystem, path, content, startMessages);
			if (!written.ok) return written;
			if (platform === "windows") return ok(undefined);
			try {
				await fs.chmod(path, EXECUTABLE_FILE_MODE);
				return ok(undefined);
			} catch (error) {
				return err(startMessages.failure.executableFailed(path, errorText(error)));
			}
		},
	};
	return ok(runtime);
};

export const createRealGitAdapter = (
	processPorts: RuntimePorts["process"],
	paths: RigState["paths"],
	messages: Messages,
): UpdatePorts["git"] => ({
	isClean: async (repository) => {
		const result = await runGit(processPorts, repository, ["status", "--porcelain"], paths, messages);
		return result.ok ? ok(result.value.trim().length === 0) : result;
	},
	branchProblem: async (repository) => {
		const branch = await runGit(processPorts, repository, ["branch", "--show-current"], paths, messages);
		if (!branch.ok) return branch;
		if (branch.value.trim() !== UPDATE_BRANCH) return ok("not-on-main");
		const ahead = await runGit(processPorts, repository, ["rev-list", "--count", `origin/${UPDATE_BRANCH}..HEAD`], paths, messages);
		if (!ahead.ok) return ahead;
		return ok(Number(ahead.value.trim()) > NO_LOCAL_COMMITS ? "local-commits" : null);
	},
	fetchMain: async (repository) => {
		const fetched = await runGit(processPorts, repository, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], paths, messages);
		if (!fetched.ok) return fetched;
		const target = await runGit(processPorts, repository, ["rev-parse", "origin/main"], paths, messages);
		return target.ok ? ok(target.value.trim()) : target;
	},
	readVersion: async (repository, commit) => {
		const path = VERSION_PATHS[repository];
		const repositoryPath = repository === "rig" ? paths.repo : paths.hub;
		const exists = await processPorts.run("git", ["-C", repositoryPath, "cat-file", "-e", `${commit}:${path}`]);
		if (!exists.ok) return exists;
		if (exists.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return ok(null);
		const file = await runGit(processPorts, repository, ["show", `${commit}:${path}`], paths, messages);
		return file.ok ? ok(parseVersion(file.value)) : file;
	},
	head: async (repository) => {
		const result = await runGit(processPorts, repository, ["rev-parse", "HEAD"], paths, messages);
		return result.ok ? ok(result.value.trim()) : result;
	},
	fastForward: async (repository, commit) => {
		const result = await runGit(processPorts, repository, ["merge", "--ff-only", commit], paths, messages);
		return result.ok ? ok(undefined) : result;
	},
	resetKeep: async (repository, commit) => {
		const result = await runGit(processPorts, repository, ["reset", "--keep", commit], paths, messages);
		return result.ok ? ok(undefined) : result;
	},
});

const runGit = async (
	processPorts: RuntimePorts["process"],
	repository: RepositoryName,
	args: readonly string[],
	paths: RigState["paths"],
	messages: Messages,
): Promise<Result<string>> => {
	const repositoryPath = repository === "rig" ? paths.repo : paths.hub;
	const result = await processPorts.run("git", ["-C", repositoryPath, ...args]);
	if (!result.ok) return result;
	return result.value.exitCode === PROCESS_SUCCESS_EXIT_CODE
		? ok(result.value.stdout)
		: err(result.value.stderr || result.value.stdout || messages.failure.gitFailed(args.join(" "), result.value.exitCode));
};

const isMissingPath = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

export const createFileSystem = (messages: Messages, hostKind: HostPlatform = hostPlatform() === "win32" ? "windows" : "posix"): FileSystem => ({
	readText: (path) => fs.readFile(path, "utf8"),
	readHead: async (path, maxBytes) => {
		const handle = await fs.open(path, "r");
		try {
			const buffer = new Uint8Array(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return new TextDecoder().decode(buffer.subarray(0, bytesRead));
		} finally { await handle.close(); }
	},
	stat: async (path) => {
		try {
			const info = await fs.stat(path);
			return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
		} catch (error) {
			if (isMissingPath(error)) return null;
			throw error;
		}
	},
	modifiedAt: async (path) => {
		try {
			return (await fs.stat(path)).mtimeMs;
		} catch (error) {
			if (isMissingPath(error)) return null;
			throw error;
		}
	},
	readRange: async (path, start, length) => {
		const handle = await fs.open(path, "r");
		try {
			const buffer = new Uint8Array(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
	writeText: (path, value) => fs.writeFile(path, value, "utf8"),
	appendBytes: (path, value) => fs.appendFile(path, value),
	writeBytes: (path, value) => fs.writeFile(path, value),
	appendText: (path, value) => fs.appendFile(path, value, "utf8"),
	rename: (from, to) => fs.rename(from, to),
	remove: (path) => fs.unlink(path),
	ensureDirectory: async (path) => { await fs.mkdir(path, { recursive: true }); },
	removeDirectoryTree: async (path) => { await fs.rm(path, { recursive: true, force: true }); },
	writeExclusive: (path, value) => writeExclusiveAtomic(path, value, hostKind, messages),
	makeDirectoryExclusive: (path) => makeDirectoryExclusive(path, messages),
	resolveTarget,
	modeOf,
	writeDurable: (path, value, mode) => writeDurable(path, value, mode, hostKind),
	listDirectory: async (path) => {
		const entries = await fs.readdir(path, { withFileTypes: true });
		// A symlink or junction to a directory is a directory too: Dirent reports the link itself.
		return Promise.all(entries.map(async (entry) => ({ name: entry.name, directory: entry.isDirectory() || (entry.isSymbolicLink() && await linksToDirectory(join(path, entry.name))) })));
	},
	uniqueSuffix: () => `${Date.now()}-${randomUUID()}`,
});

const createProcessPorts = (pathEnvironment: string, language: Language): ProcessPorts => {
	const messages = messagesFor(language);
	const ports: ProcessPorts = {
	run: (command: string, args: readonly string[], options?: ProcessOptions) => runProcess(pathEnvironment, command, args, messages, options),
	spawnDetached: (command, graceMs, stderrLimit, stderrPath, options) => spawnDetached(command, graceMs, stderrLimit, stderrPath, language, options),
	runStreaming: async (argv, cwd, env, append, verbatimArguments, appendStdout) => {
		const [command, ...args] = argv;
		if (!command) return err(messages.failure.emptyCommand());
		if (hostPlatform() === "win32") {
			// A stopped run must take down every descendant, including ones taskkill /T cannot reach.
			const confined = confineToKillOnCloseJob(messages);
			if (!confined.ok) return confined;
		}
		return await new Promise((resolve) => {
			let pending = Promise.resolve();
			let failure: string | null = null;
			let settled = false;
			let openPipes = 2;
			let pipesClosed: () => void = () => {};
			const drained = new Promise<void>((resolveDrained) => { pipesClosed = resolveDrained; });
			const settle = (value: Result<StreamingRun>): void => { if (!settled) { settled = true; resolve(value); } };
			try {
				const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatimArguments });
				const write = (bytes: Uint8Array): void => { pending = pending.then(() => append(bytes)).catch((error: unknown) => { failure = messages.failure.outputSaveFailed(errorText(error)); }); };
				const writeStdout = (bytes: Uint8Array): void => { pending = pending.then(() => (appendStdout ?? append)(bytes)).catch((error: unknown) => { failure = messages.failure.outputSaveFailed(errorText(error)); }); };
				child.stdout.on("data", appendStdout === undefined ? write : writeStdout);
				child.stderr.on("data", write);
				const pipeClosed = (): void => { openPipes -= 1; if (openPipes === 0) pipesClosed(); };
				child.stdout.once("close", pipeClosed);
				child.stderr.once("close", pipeClosed);
				child.once("error", (error) => { const text = messages.failure.processSpawnFailed(errorText(error)); failure = text; settle(err(text)); });
				// The command's own exit settles the call; the pipes may stay open for as long as a background process of the run holds them.
				child.once("exit", (code) => settle(ok({ code, finishOutput: async (): Promise<Result<void>> => {
					await waitUpTo(drained, OUTPUT_DRAIN_MS);
					child.stdout.destroy();
					child.stderr.destroy();
					await pending;
					return failure === null ? ok(undefined) : err(failure);
				} })));
			} catch (error) { settle(err(messages.failure.processSpawnFailed(errorText(error)))); }
		});
	},
	runMembers: async (): Promise<Result<number>> => {
		if (hostPlatform() === "win32") return jobMembersOtherThanSelf(messages);
		const table = await ports.run("ps", PROCESS_TABLE_ARGUMENTS);
		if (!table.ok) return table;
		if (table.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(table.value.stderr || messages.failure.processTableQueryFailed());
		// The runner leads its own process group (it is started detached), so the group id is its own pid.
		return ok(countGroupMembers(table.value.stdout, process.pid, process.pid));
	},
	killRunMembers: async (): Promise<Result<void>> => {
		if (hostPlatform() === "win32") return terminateJobMembersOtherThanSelf(messages);
		const table = await ports.run("ps", PROCESS_TABLE_ARGUMENTS);
		if (!table.ok) return table;
		if (table.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(table.value.stderr || messages.failure.processTableQueryFailed());
		const members = groupMemberPids(table.value.stdout, process.pid, process.pid);
		if (members.length === 0) return ok(undefined);
		// A member that ended since the listing makes `kill` report it; that is the goal, so only a failed start is an error and the next count verifies.
		const killed = await ports.run("kill", ["-KILL", ...members.map(String)]);
		return killed.ok ? ok(undefined) : killed;
	},
	// A kill port fails only when the kill could not be done at all (the killer did not start, the process table could not be read,
	// the platform has no such kill). A killer that ran and exited non-zero is ok: a member that ended since the listing makes it
	// report that, and the caller verifies by liveness. The message text of a killer is never parsed.
	killTree: async (pid, force = false): Promise<Result<void>> => {
		if (hostPlatform() === "win32") {
			const result = await ports.run("taskkill", ["/T", "/F", "/PID", String(pid)]);
			return result.ok ? ok(undefined) : result;
		}
		const table = await ports.run("ps", ["-eo", "pid=,ppid="]);
		if (!table.ok) return table;
		if (table.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(table.value.stderr || messages.failure.processTableQueryFailed());
		const children = new Map<number, number[]>();
		for (const line of table.value.stdout.split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
			if (match) { const parent = Number(match[2]); children.set(parent, [...(children.get(parent) ?? []), Number(match[1])]); }
		}
		const tree = [pid];
		for (let index = 0; index < tree.length; index++) tree.push(...(children.get(tree[index]) ?? []));
		for (const child of tree.reverse()) {
			const result = await ports.run("kill", [force ? "-KILL" : "-TERM", String(child)]);
			if (!result.ok) return result;
		}
		return ok(undefined);
	},
	killGroup: async (pid): Promise<Result<void>> => {
		if (hostPlatform() === "win32") return err(messages.failure.processGroupsUnavailable());
		const result = await ports.run("kill", ["-KILL", "--", `-${pid}`]);
		return result.ok ? ok(undefined) : result;
	},
	createdAt: async (pids: readonly number[]): Promise<Result<Record<string, string | null>>> => {
		if (pids.length === 0) return ok({});
		const python = hostPlatform() === "win32" ? "python" : "python3";
		const script = fileURLToPath(new URL("../../base/hooks/session_record.py", import.meta.url));
		const result = await ports.run(python, ["-I", script, "created-at", ...pids.map(String)]);
		if (!result.ok) return result;
		if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(result.value.stderr || messages.failure.processTableQueryFailed());
		try {
			const value: unknown = JSON.parse(result.value.stdout);
			if (typeof value !== "object" || value === null || Array.isArray(value)) return err(messages.failure.processTableInvalid());
			const times: Record<string, string | null> = {};
			for (const [key, time] of Object.entries(value)) {
				if (time !== null && typeof time !== "string") return err(messages.failure.processTableInvalid());
				times[key] = time;
			}
			if (pids.some((pid) => !Object.hasOwn(times, String(pid)))) return err(messages.failure.processTableIncomplete());
			return ok(times);
		} catch { return err(messages.failure.processTableInvalid()); }
	},
	isAvailable: async (command: string): Promise<boolean> => {
		if (command.includes("/") || command.includes("\\")) {
			try {
				await fs.access(command, hostPlatform() === "win32" ? constants.F_OK : constants.X_OK);
				return true;
			} catch {
				return false;
			}
		}
		const windows = hostPlatform() === "win32";
		const lookup = windows
			? await runProcess(pathEnvironment, "where.exe", [command], messages)
			: await runProcess(pathEnvironment, "sh", ["-c", "command -v -- \"$1\"", "rig-command-lookup", command], messages);
		return lookup.ok && lookup.value.exitCode === PROCESS_SUCCESS_EXIT_CODE;
	},
	};
	return ports;
};

// ok(number): start time of the running process; ok(null): no such process; err: the answer could not be obtained, which
// the lock treats as "still running".
export const ownerStartTime = async (
	pid: number,
	processPorts: Pick<RuntimePorts["process"], "run">,
	messages: Messages,
	hostName: NodeJS.Platform = hostPlatform(),
): Promise<Result<number | null>> => {
	if (hostName === "linux") {
		try {
			const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
			const closingParenthesis = text.lastIndexOf(")");
			if (closingParenthesis < 0) return err(messages.failure.procStatUnreadable(pid));
			const fields = text.slice(closingParenthesis + 1).trim().split(/\s+/);
			const startTicks = Number(fields[LINUX_PROC_START_TIME_INDEX]);
			return Number.isFinite(startTicks) ? ok(startTicks) : err(messages.failure.procStartUnreadable(pid));
		} catch (error) {
			return isNotFound(error) ? ok(null) : err(messages.failure.readFailed(`/proc/${pid}/stat`, errorText(error)));
		}
	}
	if (hostName === "win32") {
		const script = `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ('present ' + $p.StartTime.ToUniversalTime().Ticks) } catch { if ($_.FullyQualifiedErrorId -eq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand') { Write-Output 'absent' } else { [Console]::Error.WriteLine($_.ToString()); exit 1 } }`;
		const result = await processPorts.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		if (!result.ok) return err(result.error);
		if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(result.value.stderr || messages.failure.powershellExited(result.value.exitCode));
		const text = result.value.stdout.trim();
		if (text === "absent") return ok(null);
		if (!/^present \d+$/.test(text)) return err(messages.failure.startTimeUnexpectedPowershell(text));
		const ticks = Number(text.slice("present ".length));
		return Number.isFinite(ticks) ? ok(ticks) : err(messages.failure.startTimeUnexpectedPowershell(text));
	}
	if (hostName === "darwin") {
		// BSD ps prints lstart in the user's locale; LC_ALL=C keeps the English format that Date.parse reads.
		const script = "table=$(ps -axo pid=,lstart=) || exit 1; printf '%s\\n' \"$table\" | awk -v pid=\"$1\" '$1 == pid { $1 = \"\"; print \"present\" $0; found = 1 } END { if (!found) print \"absent\" }'";
		const result = await processPorts.run("sh", ["-c", script, "rig-process-probe", String(pid)], { environment: { LC_ALL: "C" } });
		if (!result.ok) return err(result.error);
		const text = result.value.stdout.trim();
		if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(result.value.stderr || messages.failure.processTableQueryFailed());
		if (text === "absent") return ok(null);
		if (!text.startsWith("present ")) return err(messages.failure.startTimeUnexpectedPs(text));
		const start = Date.parse(text.slice("present ".length));
		return Number.isFinite(start) ? ok(start) : err(messages.failure.startTimeUnexpectedPs(text));
	}
	return err(messages.failure.startTimeUnsupported(hostName));
};

type ProcessRunner = Pick<ProcessPorts, "run" | "spawnDetached">;
// Stop-ScheduledTask then Start-ScheduledTask end within a few seconds; a restart still running after this is reported
// as started, and one that fails earlier reports its exit code and stderr.
const WINDOWS_RESTART_GRACE_MS = 30_000;
const RESTART_TEMP_PREFIX = "rig-restart-";
// The restart powershell may still hold its stderr file for a moment after it ended.
const REMOVE_RETRIES = 10;
const RESTART_STDERR_LIMIT = 4000;
const RESTART_SCRIPT = "Stop-ScheduledTask -TaskName 'telegram-hub' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'telegram-hub'";

// Stopping the hub's task ends its job object, and this command may itself run inside that job (rig update started from
// a hub session), so the restart runs detached and outside the caller's job, and survives the stop it performs.
const restartWindowsTask = async (processPorts: ProcessRunner, messages: Messages): Promise<Result<void>> => {
	const directory = await fs.mkdtemp(join(tmpdir(), RESTART_TEMP_PREFIX));
	try {
		const started = await processPorts.spawnDetached(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", RESTART_SCRIPT], WINDOWS_RESTART_GRACE_MS, RESTART_STDERR_LIMIT, join(directory, "restart-stderr.log"), { windowsHide: true });
		if (!started.ok) return err(messages.runtime.taskRestartFailed(started.error));
		if (started.value.exited && started.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(messages.runtime.taskRestartFailed(started.value.stderr));
		return ok(undefined);
	} catch (error) {
		return err(messages.runtime.taskRestartFailed(errorText(error)));
	} finally {
		// A restart still running past the grace period keeps the file open; the temp directory then stays for the OS cleanup.
		await fs.rm(directory, { recursive: true, force: true, maxRetries: REMOVE_RETRIES }).catch(() => undefined);
	}
};
type UserBusSource = { environment: Readonly<Record<string, string | undefined>>; uid: number | null };

const currentUserBusSource = (): UserBusSource => ({
	environment: process.env,
	uid: typeof process.getuid === "function" ? process.getuid() : null,
});

// Cron and other non-login launches have no user bus variables; `systemctl --user` then cannot reach the bus.
export const userBusEnvironment = (source: UserBusSource): Record<string, string> => {
	const result: Record<string, string> = {};
	let runtimeDirectory = source.environment.XDG_RUNTIME_DIR;
	if (runtimeDirectory === undefined || runtimeDirectory === "") {
		if (source.uid === null) return result;
		runtimeDirectory = `${USER_RUNTIME_ROOT}/${source.uid}`;
		result.XDG_RUNTIME_DIR = runtimeDirectory;
	}
	const busAddress = source.environment.DBUS_SESSION_BUS_ADDRESS;
	if (busAddress === undefined || busAddress === "") result.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDirectory}/bus`;
	return result;
};

export const runService = async (
	processPorts: ProcessRunner,
	platform: RuntimePorts["platform"],
	action: "start" | "stop" | "restart",
	busSource: UserBusSource = currentUserBusSource(),
	messages: Messages = messagesFor(DEFAULT_LANGUAGE),
): Promise<Result<void>> => {
	if (platform === "linux") {
		const result = await processPorts.run("systemctl", ["--user", action, "telegram-hub.service"], { environment: userBusEnvironment(busSource) });
		return processSuccess(result, `systemctl --user ${action} telegram-hub.service`);
	}
	if (platform === "windows") {
		if (action === "restart") {
			return await restartWindowsTask(processPorts, messages);
		}
		const command = action === "start" ? "Start-ScheduledTask -TaskName 'telegram-hub'" : "Stop-ScheduledTask -TaskName 'telegram-hub'";
		const result = await processPorts.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
		return processSuccess(result, command);
	}
	return err(messages.runtime.serviceUnsupported(platform));
};

export const serviceIsRunning = async (
	processPorts: ProcessRunner,
	platform: RuntimePorts["platform"],
	busSource: UserBusSource = currentUserBusSource(),
	messages: Messages = messagesFor(DEFAULT_LANGUAGE),
): Promise<Result<boolean>> => {
	if (platform === "linux") {
		const result = await processPorts.run("systemctl", ["--user", "is-active", "--quiet", "telegram-hub.service"], { environment: userBusEnvironment(busSource) });
		if (!result.ok) return result;
		if (result.value.exitCode === PROCESS_SUCCESS_EXIT_CODE) return ok(true);
		// systemctl is-active exits 3 for an inactive unit; any other code (such as 1 for a bus failure) is an error, not "stopped".
		if (result.value.exitCode === SYSTEMCTL_INACTIVE_EXIT_CODE) return ok(false);
		return err(messages.runtime.serviceInactive(result.value.exitCode, result.value.stderr.trim() || result.value.stdout.trim()));
	}
	if (platform === "windows") {
		const result = await processPorts.run("powershell.exe", [
			"-NoProfile", "-NonInteractive", "-Command",
			"(Get-ScheduledTask -TaskName 'telegram-hub' -ErrorAction Stop).State -eq 'Running'",
		]);
		if (!result.ok) return result;
		if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(result.value.stderr || messages.runtime.scheduledTaskNotFound());
		return ok(result.value.stdout.trim().toLowerCase() === "true");
	}
	return err(messages.runtime.serviceCheckUnsupported(platform));
};

const processSuccess = (result: Result<ProcessOutput>, description: string): Result<void> => {
	if (!result.ok) return err(`${description}: ${result.error}`);
	return result.value.exitCode === PROCESS_SUCCESS_EXIT_CODE ? ok(undefined) : err(`${description}: ${result.value.stderr || result.value.stdout}`);
};

const installProgram = async (
	name: string,
	binDirectory: string,
	runtime: RuntimePorts,
	platform: RuntimePorts["platform"],
): Promise<Result<void>> => {
	if (name === "codex") {
		const result = await runProcess(runtime.pathEnvironment, runtime.executablePath, ["add", "--global", CODEX_PACKAGE], messagesFor(runtime.language));
		return processSuccess(result, messagesFor(runtime.language).runtime.codexInstallLabel());
	}
	if (name === "opencode") {
		const command = platform === "windows" ? "npm.cmd" : "npm";
		const result = await runProcess(runtime.pathEnvironment, command, ["install", "--global", "--prefix", binDirectory, OPENCODE_PACKAGE], messagesFor(runtime.language));
		return processSuccess(result, messagesFor(runtime.language).runtime.opencodeInstallLabel());
	}
	if (name === "rtk") return installRtk(binDirectory, platform, runtime);
	return err(messagesFor(runtime.language).runtime.noRootInstall(name));
};

const installRtk = async (binDirectory: string, platform: RuntimePorts["platform"], runtime: RuntimePorts): Promise<Result<void>> => {
	const messages = messagesFor(runtime.language);
	const targetName = platform === "windows" ? `rtk${WINDOWS_EXECUTABLE_SUFFIX}` : "rtk";
	const release = await fetchRtkRelease(platform, messages);
	if (!release.ok) return release;
	const temporary = await runtime.temporary.createDirectory("rig-rtk-");
	if (!temporary.ok) return temporary;
	try {
		const archivePath = join(temporary.value, release.value.asset.name);
		const archive = await fetchBytes(release.value.asset.url, messages);
		if (!archive.ok) return archive;
		const digest = createHash("sha256").update(archive.value).digest("hex");
		if (digest !== release.value.checksum) return err(messages.runtime.rtkChecksumMismatch(release.value.asset.name));
		await fs.writeFile(archivePath, archive.value);
		const extracted = await runProcess(runtime.pathEnvironment, platform === "windows" ? "tar.exe" : "tar", ["-xf", archivePath, "-C", temporary.value], messages);
		const extractedResult = processSuccess(extracted, messages.runtime.rtkExtractLabel());
		if (!extractedResult.ok) return extractedResult;
		const sourcePath = join(temporary.value, targetName);
		const binary = await readBytes(sourcePath, messages);
		if (!binary.ok) return err(messages.runtime.rtkBinaryMissing(targetName, binary.error));
		await fs.mkdir(binDirectory, { recursive: true });
		const targetPath = join(binDirectory, targetName);
		const temporaryTarget = `${targetPath}.tmp-${randomUUID()}`;
		await fs.writeFile(temporaryTarget, binary.value);
		await fs.rename(temporaryTarget, targetPath);
		if (platform !== "windows") await fs.chmod(targetPath, EXECUTABLE_FILE_MODE);
		return ok(undefined);
	} catch (error) {
		return err(messages.runtime.rtkInstallFailed(errorText(error)));
	} finally {
		await runtime.temporary.removeDirectory(temporary.value);
	}
};

const fetchRtkRelease = async (platform: RuntimePorts["platform"], messages: Messages): Promise<Result<{ asset: ReleaseAsset; checksum: string }>> => {
	const target = rtkTarget(platform);
	if (target === null) return err(messages.runtime.rtkUnsupported(platform));
	try {
		const response = await fetch(RTK_RELEASE_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-rig" } });
		if (!response.ok) return err(messages.runtime.githubStatus(response.status));
		const text = await response.text();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return err(messages.runtime.githubBadRelease());
		}
		if (!isObject(value) || !Array.isArray(value.assets)) return err(messages.runtime.githubNoAssetList());
		const assets: ReleaseAsset[] = [];
		for (const asset of value.assets) {
			if (isObject(asset) && typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
				assets.push({ name: asset.name, url: asset.browser_download_url });
			}
		}
		const asset = assets.find((candidate) => candidate.name === target);
		const checksums = assets.find((candidate) => candidate.name === "checksums.txt");
		if (asset === undefined || checksums === undefined) return err(messages.runtime.rtkAssetsMissing(target));
		const checksumText = await fetchText(checksums.url, messages);
		if (!checksumText.ok) return checksumText;
		const checksum = checksumText.value.split(/\r?\n/).map(parseChecksumLine).find((entry) => entry?.name === target)?.hash;
		return checksum === undefined ? err(messages.runtime.checksumMissing(target)) : ok({ asset, checksum });
	} catch (error) {
		return err(messages.runtime.rtkFetchFailed(errorText(error)));
	}
};

const rtkTarget = (platform: RuntimePorts["platform"]): string | null => {
	if (platform === "windows") return "rtk-x86_64-pc-windows-msvc.zip";
	if (platform === "linux") return process.arch === "arm64" ? "rtk-aarch64-unknown-linux-gnu.tar.gz" : "rtk-x86_64-unknown-linux-musl.tar.gz";
	if (platform === "darwin") return process.arch === "arm64" ? "rtk-aarch64-apple-darwin.tar.gz" : "rtk-x86_64-apple-darwin.tar.gz";
	return null;
};

const parseChecksumLine = (line: string): { name: string; hash: string } | null => {
	const parts = line.trim().split(/\s+/);
	const hash = parts[0];
	const name = parts[parts.length - 1];
	return hash !== undefined && name !== undefined && hash.length === CHECKSUM_LENGTH && /^[0-9a-fA-F]+$/.test(hash)
		? { name, hash: hash.toLowerCase() }
		: null;
};

const fetchText = async (url: string, messages: Messages): Promise<Result<string>> => {
	try {
		const response = await fetch(url, { headers: { "User-Agent": "agent-rig" } });
		return response.ok ? ok(await response.text()) : err(messages.failure.downloadFailed(response.status));
	} catch (error) {
		return err(messages.failure.fetchFailed(errorText(error)));
	}
};

const fetchBytes = async (url: string, messages: Messages): Promise<Result<Uint8Array>> => {
	try {
		const response = await fetch(url, { headers: { "User-Agent": "agent-rig" } });
		return response.ok ? ok(new Uint8Array(await response.arrayBuffer())) : err(messages.failure.downloadFailed(response.status));
	} catch (error) {
		return err(messages.failure.fetchFailed(errorText(error)));
	}
};

const readBytes = async (path: string, messages: Messages): Promise<Result<Uint8Array>> => {
	try {
		return ok(await fs.readFile(path));
	} catch (error) {
		return err(messages.failure.readFailed(path, errorText(error)));
	}
};

const toPlatform = (value: NodeJS.Platform): RuntimePorts["platform"] | null => {
	if (value === "win32") return "windows";
	if (value === "darwin") return "darwin";
	if (value === "linux") return "linux";
	return null;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

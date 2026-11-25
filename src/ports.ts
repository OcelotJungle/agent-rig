import type { FileSystem } from "./file-system.js";
import type { Language } from "./messages.js";
import type { LockDependencies } from "./lock.js";
import type { Platform } from "./feature.js";
import type { Result } from "./result.js";
import type { FileSystem as AssetFileSystem } from "./assets/installer.js";

export const PROCESS_SUCCESS_EXIT_CODE = 0;
export const PROCESS_FAILURE_EXIT_CODE = 1;

export type ProcessOutput = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type ProcessOptions = {
	cwd?: string;
	input?: string;
	environment?: Record<string, string>;
	// Overrides the runner's default limit for this call; a command that outlives it is killed with its whole process
	// tree and the call fails with an error.
	timeoutMs?: number;
};

// A command started by runStreaming, as seen at its own exit. The command's output may still be arriving then (a
// background process of the run holds the pipes), so it is collected until the caller ends it with finishOutput.
export type StreamingRun = {
	// The command's own exit code (null when it was ended by a signal).
	code: number | null;
	// Called once the run holds no process but the caller: waits (bounded) for the pipes to close, flushes every pending
	// append, and fails when an append failed. Output of a process that escaped the run is not collected after it.
	finishOutput(): Promise<Result<void>>;
};

// One row of the host's process table. `commandLine` is empty when the host cannot tell it; `createdAt` is null when the
// creation time is unknown (a process whose time is unknown is never taken for a launched one).
export type ProcessEntry = {
	pid: number;
	parent: number;
	name: string;
	commandLine: string;
	createdAt: string | null;
};

export type ProcessPorts = {
	run(command: string, args: readonly string[], options?: ProcessOptions): Promise<Result<ProcessOutput>>;
	spawnDetached(command: readonly string[], graceMs: number, stderrLimit: number, stderrPath: string, options?: { windowsHide?: boolean }): Promise<Result<{ exited: boolean; exitCode: number | null; stderr: string; pid?: number }>>;
	runStreaming(argv: readonly string[], cwd: string, env: Record<string, string>, append: (bytes: Uint8Array) => Promise<void>, verbatimArguments: boolean, appendStdout?: (bytes: Uint8Array) => Promise<void>): Promise<Result<StreamingRun>>;
	// How many processes of the caller's own run, other than the caller itself, are alive: the runner's job on Windows,
	// the runner's process group on POSIX. A process that left the run on purpose (setsid, job breakaway) is not counted.
	runMembers(): Promise<Result<number>>;
	// Kills every process counted by runMembers (so not the caller itself): the runner's job on Windows, the runner's process group on POSIX.
	// Error only when a kill could not be done at all; a member that ended meanwhile is not an error. Callers verify by liveness.
	killRunMembers(): Promise<Result<void>>;
	isAvailable(command: string): Promise<boolean>;
	createdAt(pids: readonly number[]): Promise<Result<Record<string, string | null>>>;
	// Every process of the host with its parent, command line and creation time (Windows and Linux; error on a host with no process table).
	listProcesses(): Promise<Result<ProcessEntry[]>>;
	// The visible text of the console screen of a process, non-empty rows only (Windows only; error elsewhere and when the console cannot
	// be read). Read-only: the console is not changed. The read runs in a hidden helper process and is bounded in time.
	readConsoleText(pid: number): Promise<Result<string>>;
	// Kill contract (killTree, killGroup): error only when the kill could not be done at all (the killer did not start, the process table
	// could not be read, the platform has no such kill). A killer that ran and exited non-zero is ok; callers verify by liveness.
	killTree(pid: number, force?: boolean): Promise<Result<void>>;
	// POSIX only: SIGKILL to the process group whose id is `pid` (a run started with spawnDetached leads its own group).
	killGroup(pid: number): Promise<Result<void>>;
};

export type RuntimePorts = {
	fs: FileSystem;
	assetFs: AssetFileSystem;
	process: ProcessPorts;
	// Reads of the process environment (CODEX_HOME and the like); commands never touch process.env directly.
	environment: { get(name: string): string | undefined; entries(): Record<string, string> };
	stdin: { read(): Promise<string> };
	lock: LockDependencies;
	home: string;
	currentDirectory: string;
	resolvePath(...parts: string[]): string;
	executablePath: string;
	pythonCommand: string;
	pathEnvironment: string;
	platform: Platform;
	// The language of everything rig prints. runCli reads it from state.json once per command run and sets it here;
	// code that builds a text takes it from this field (or from messagesFor(language)) and never reads the disk for it.
	language: Language;
	clock: {
		now(): Date;
		nowText(): string;
		// With `cancel`, aborting the signal ends the sleep at once and frees its timer.
		sleep(milliseconds: number, cancel?: AbortSignal): Promise<void>;
		every(milliseconds: number, callback: () => void): () => void;
	};
	ids: { next(): string };
	service: {
		start(): Promise<Result<void>>;
		stop(): Promise<Result<void>>;
		isRunning(): Promise<Result<boolean>>;
		restart(): Promise<Result<void>>;
	};
	programs: { install(name: string, binDirectory: string): Promise<Result<void>> };
	temporary: {
		createDirectory(prefix: string): Promise<Result<string>>;
		removeDirectory(path: string): Promise<Result<void>>;
	};
	writeExecutable(path: string, content: string): Promise<Result<void>>;
};

import type { FileSystem } from "./file-system.js";
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
};

export type ProcessPorts = {
	run(command: string, args: readonly string[], options?: ProcessOptions): Promise<Result<ProcessOutput>>;
	isAvailable(command: string): Promise<boolean>;
};

export type RuntimePorts = {
	fs: FileSystem;
	assetFs: AssetFileSystem;
	process: ProcessPorts;
	lock: LockDependencies;
	home: string;
	currentDirectory: string;
	resolvePath(...parts: string[]): string;
	executablePath: string;
	pythonCommand: string;
	pathEnvironment: string;
	platform: Platform;
	clock: {
		now(): Date;
		nowText(): string;
		sleep(milliseconds: number): Promise<void>;
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

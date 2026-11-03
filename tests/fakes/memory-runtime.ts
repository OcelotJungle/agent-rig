import type { DirectoryEntry, FileSystem } from "../../src/file-system.js";
import type { RuntimePorts, ProcessOptions, ProcessOutput } from "../../src/ports.js";
import type { Result } from "../../src/result.js";
import type { FileContent } from "../../src/content-hash.js";

import { atomicWrite } from "../../src/file-system.js";
import { err, ok } from "../../src/result.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../../src/ports.js";

const INITIAL_SUFFIX_COUNT = 0;
const INITIAL_EVENT_ID = 0;
const FAKE_OWNER_PID = 10;
const FAKE_OWNER_START_TIME = 20;
const FAKE_LOCK_POLL_INTERVAL_MS = 1;
const FAKE_TEMP_DIRECTORY = "/virtual-temp/rig-check";
const FAKE_TIME = "2026-10-30T00:00:00.000Z";

export class MissingPathError extends Error {
	readonly code = "ENOENT";
}

export class CrashError extends Error {}

export class MemoryFileSystem implements FileSystem {
	readonly files = new Map<string, string>();
	readonly directories = new Set<string>(["/"]);
	// A directory that is a symbolic link: path of the link -> path it points to.
	readonly symlinks = new Map<string, string>();
	// Files whose bytes are not text (the string in `files` is a placeholder), and files with the exec bit.
	readonly binaries = new Map<string, Uint8Array>();
	readonly executables = new Set<string>();
	readonly operations: string[] = [];
	// Symlink path -> the file it points to, and permission bits of files that have them.
	readonly links = new Map<string, string>();
	readonly modes = new Map<string, number>();
	private suffix = INITIAL_SUFFIX_COUNT;
	private crashBudget: number | null = null;
	private crashed = false;

	constructor(private readonly timeline: string[] = []) {}

	seed(path: string, value: string): void {
		this.ensureParentDirectories(path);
		this.files.set(path, value);
		this.directories.add(parentPath(path));
	}

	async readText(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) throw new MissingPathError(`Missing file ${path}`);
		return value;
	}

	async writeText(path: string, value: string): Promise<void> {
		this.record(`write:${path}`);
		this.ensureParentDirectories(path);
		this.files.set(path, value);
	}

	async appendText(path: string, value: string): Promise<void> {
		this.record(`append:${path}`);
		this.ensureParentDirectories(path);
		this.files.set(path, `${this.files.get(path) ?? ""}${value}`);
	}

	async rename(from: string, to: string): Promise<void> {
		this.record(`rename:${from}:${to}`);
		const value = this.files.get(from);
		if (value === undefined) throw new MissingPathError(`Missing file ${from}`);
		this.ensureParentDirectories(to);
		this.files.set(to, value);
		this.files.delete(from);
		const mode = this.modes.get(from);
		if (mode === undefined) this.modes.delete(to);
		else this.modes.set(to, mode);
		this.modes.delete(from);
	}

	async remove(path: string): Promise<void> {
		this.record(`remove:${path}`);
		if (!this.files.delete(path)) throw new MissingPathError(`Missing file ${path}`);
	}

	async ensureDirectory(path: string): Promise<void> {
		this.record(`mkdir:${path}`);
		this.directories.add(path);
		const parent = parentPath(path);
		if (parent !== path) this.directories.add(parent);
	}

	async writeExclusive(path: string, value: string): Promise<Result<boolean>> {
		if (this.files.has(path)) return ok(false);
		this.record(`exclusive:${path}`);
		this.ensureParentDirectories(path);
		this.files.set(path, value);
		return ok(true);
	}

	async resolveTarget(path: string): Promise<string> {
		return this.links.get(path) ?? path;
	}

	async modeOf(path: string): Promise<number | null> {
		return this.modes.get(path) ?? null;
	}

	async writeDurable(path: string, value: string, mode: number | null): Promise<void> {
		this.record(`durable:${path}`);
		this.ensureParentDirectories(path);
		this.files.set(path, value);
		if (mode !== null) this.modes.set(path, mode);
	}

	async listDirectory(path: string): Promise<DirectoryEntry[]> {
		if (!this.directories.has(path)) throw new MissingPathError(`Missing directory ${path}`);
		const prefix = path === "/" ? "/" : `${path}/`;
		const names = new Map<string, boolean>();
		for (const directory of this.directories) {
			if (!directory.startsWith(prefix) || directory === path) continue;
			const relative = directory.slice(prefix.length);
			if (!relative.includes("/")) names.set(relative, true);
		}
		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) continue;
			const relative = file.slice(prefix.length);
			if (!relative.includes("/") && !names.has(relative)) names.set(relative, false);
		}
		return [...names].map(([name, directory]) => ({ name, directory }));
	}

	uniqueSuffix(): string {
		this.suffix += 1;
		return String(this.suffix);
	}

	private ensureParentDirectories(path: string): void {
		let current = parentPath(path);
		while (current.length > 0 && current !== "/") {
			this.directories.add(current);
			current = parentPath(current);
		}
		this.directories.add("/");
	}

	// Simulates a kill: the next `count` mutating operations succeed, the one after that and every later one throws
	// before it changes anything, until revive() is called. A `count` of 0 fails the very next operation.
	crashAfter(count: number): void {
		this.crashBudget = count;
		this.crashed = false;
	}

	revive(): void {
		this.crashBudget = null;
		this.crashed = false;
	}

	pathExists(path: string): boolean {
		return this.files.has(path) || this.directories.has(path) || this.symlinks.has(path);
	}

	// Follows the longest symlink prefix of the path (a link may point at another link).
	resolveSymlinks(path: string): string {
		let current = path;
		const seen = new Set<string>();
		for (;;) {
			if (seen.has(current)) return current;
			seen.add(current);
			let next: string | null = null;
			for (const [link, target] of this.symlinks) {
				if (current === link) { next = target; break; }
				if (current.startsWith(`${link}/`)) { next = `${target}${current.slice(link.length)}`; break; }
			}
			if (next === null) return current;
			current = next;
		}
	}

	get hasCrashed(): boolean {
		return this.crashed;
	}

	private record(operation: string): void {
		if (this.crashed) throw new CrashError(`Process was killed before ${operation}`);
		if (this.crashBudget !== null) {
			if (this.crashBudget === 0) {
				this.crashed = true;
				throw new CrashError(`Process was killed before ${operation}`);
			}
			this.crashBudget -= 1;
		}
		this.operations.push(operation);
		this.timeline.push(operation);
	}
}

export type MemoryRuntimeHarness = {
	runtime: RuntimePorts;
	fs: MemoryFileSystem;
	processCalls: Array<{ command: string; args: readonly string[]; options?: ProcessOptions }>;
	timeline: string[];
	unavailableCommands: Set<string>;
	// Ids the fake `claude plugin list --json` reports; install and uninstall change it.
	installedPlugins: Set<string>;
	// Delays, in milliseconds, that the code under test asked the clock to sleep; the fake clock does not wait.
	sleeps: number[];
};

export const createMemoryRuntime = (platform: RuntimePorts["platform"] = "linux"): MemoryRuntimeHarness => {
	const timeline: string[] = [];
	const fs = new MemoryFileSystem(timeline);
	const processCalls: Array<{ command: string; args: readonly string[]; options?: ProcessOptions }> = [];
	const unavailableCommands = new Set<string>();
	const installedPlugins = new Set<string>();
	const sleeps: number[] = [];
	let eventId = INITIAL_EVENT_ID;
	const assetFs = {
		readFile: async (path: string): Promise<Result<FileContent>> => {
			const value = fs.files.get(path);
			if (value === undefined) return err("not-found");
			const bytes = fs.binaries.get(path) ?? new TextEncoder().encode(value);
			return ok({ bytes, executable: fs.executables.has(path) });
		},
		listFiles: async (path: string): Promise<Result<readonly string[]>> => {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const files = [...fs.files.keys()].filter((file) => file.startsWith(prefix));
			return files.length > 0 ? ok(files) : err("not-found");
		},
		writeFileAtomic: async (path: string, content: FileContent): Promise<Result<void>> => {
			const text = decodeUtf8(content.bytes);
			// Bytes that are not text cannot live in the string map: it holds a placeholder, `binaries` the real bytes.
			const written = await atomicWrite(fs, path, text ?? "");
			if (!written.ok) return written;
			if (text === null) fs.binaries.set(path, content.bytes);
			else fs.binaries.delete(path);
			if (content.executable) fs.executables.add(path);
			else fs.executables.delete(path);
			return written;
		},
		removeFile: async (path: string): Promise<Result<void>> => {
			try {
				await fs.remove(path);
				fs.binaries.delete(path);
				fs.executables.delete(path);
				return ok(undefined);
			} catch {
				return err("not-found");
			}
		},
		makeDirectory: async (path: string): Promise<Result<void>> => {
			await fs.ensureDirectory(path);
			return ok(undefined);
		},
		realPath: async (path: string): Promise<Result<string>> => {
			const resolved = fs.resolveSymlinks(path);
			return fs.pathExists(resolved) ? ok(resolved) : err("not-found");
		},
	};
	const runtime: RuntimePorts = {
		language: "en",
		fs,
		assetFs,
		process: {
			run: async (command, args, options) => {
				processCalls.push({ command, args, options });
				if (command === "claude" && args.join(" ") === "plugin marketplace list") {
					return ok({ stdout: "❯ claude-plugins-official\n❯ openai-codex\n❯ telegram-hub\n", stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });
				}
				if (command === "claude" && args.join(" ") === "plugin list --json") {
					return ok({ stdout: JSON.stringify([...installedPlugins].map((id) => ({ id }))), stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });
				}
				if (command === "claude" && args[0] === "plugin" && args[1] === "install" && args[2] !== undefined) {
					timeline.push("plugin-install");
					installedPlugins.add(args[2]);
					setEnabledPlugin(fs, args[2], true);
				}
				if (command === "claude" && args[0] === "plugin" && args[1] === "uninstall" && args[2] !== undefined) {
					installedPlugins.delete(args[2]);
					setEnabledPlugin(fs, args[2], false);
				}
				if (command === "git" && args.includes("--show-toplevel")) return ok({ stdout: "/repo\n", stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });
				return ok({ stdout: "abc\n", stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });
			},
			isAvailable: async (command) => !unavailableCommands.has(command),
		},
		lock: {
			fs,
			home: "/home/test",
			process: { pid: FAKE_OWNER_PID, startTime: FAKE_OWNER_START_TIME, ownerStartTime: async () => ok(FAKE_OWNER_START_TIME) },
			clock: { sleep: async () => undefined, now: () => Date.now() },
			pollIntervalMs: FAKE_LOCK_POLL_INTERVAL_MS,
		},
		home: "/home/test",
		currentDirectory: "/repo",
		resolvePath: (...parts) => normalize(parts.join("/")),
		executablePath: "/bun/bun",
		pythonCommand: platform === "windows" ? "python" : "python3",
		pathEnvironment: "/usr/bin:/bin",
		platform,
		clock: {
			now: () => new Date(FAKE_TIME),
			nowText: () => FAKE_TIME,
			sleep: async (milliseconds) => { sleeps.push(milliseconds); },
		},
		ids: { next: () => { eventId += 1; return `event-${eventId}`; } },
		service: {
			start: async () => { timeline.push("service-start"); return ok(undefined); },
			stop: async () => { timeline.push("service-stop"); return ok(undefined); },
			isRunning: async () => ok(true),
			restart: async () => { timeline.push("service-restart"); return ok(undefined); },
		},
		programs: { install: async () => ok(undefined) },
		temporary: {
			createDirectory: async () => ok(FAKE_TEMP_DIRECTORY),
			removeDirectory: async () => ok(undefined),
		},
		writeExecutable: async (path, content) => {
			await fs.writeText(path, content);
			return ok(undefined);
		},
	};
	return { runtime, fs, processCalls, timeline, unavailableCommands, installedPlugins, sleeps };
};

const SETTINGS_PATH = "/home/test/.claude/settings.json";
const SETTINGS_INDENT = 2;

const decodeUtf8 = (bytes: Uint8Array): string | null => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Mirrors the real `claude plugin install/uninstall`: it edits `enabledPlugins` in the user's settings.json directly,
// without the rig's own writes, so it is not recorded as a file operation.
const setEnabledPlugin = (fs: MemoryFileSystem, id: string, enabled: boolean): void => {
	let settings: Record<string, unknown> = {};
	const text = fs.files.get(SETTINGS_PATH);
	if (text !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		settings = parsed;
	}
	const current = settings.enabledPlugins;
	const plugins: Record<string, unknown> = isRecord(current) ? { ...current } : {};
	if (enabled) plugins[id] = true;
	else delete plugins[id];
	settings.enabledPlugins = plugins;
	fs.files.set(SETTINGS_PATH, `${JSON.stringify(settings, null, SETTINGS_INDENT)}\n`);
	fs.directories.add("/home/test/.claude");
};

// The hub declares its marketplace name in its own manifest; `name` is deliberately not the plugin name.
export const seedHubManifest = (fs: MemoryFileSystem, hub: string, name: string): void => {
	fs.seed(`${hub}/.claude-plugin/marketplace.json`, JSON.stringify({ name, plugins: [{ name: "telegram-hub", source: "./plugin" }] }));
};

export const seedFeature = (fs: MemoryFileSystem, repo: string, feature: Record<string, unknown>): void => {
	const name = typeof feature.name === "string" ? feature.name : "unknown";
	const featurePath = name === "base" ? `${repo}/base/feature.json` : `${repo}/features/${name}/feature.json`;
	fs.seed(featurePath, JSON.stringify(feature));
	fs.directories.add(`${repo}/features`);
	if (name !== "base") fs.directories.add(`${repo}/features/${name}`);
};

export const baseManifest = (): Record<string, unknown> => ({
	name: "base",
	description: { en: "Base", ru: "Base (ru)" },
	enabledByDefault: true,
	platforms: ["linux", "windows", "darwin"],
	dependencies: [],
	rules: [],
	hooks: [],
	settings: [],
	plugins: [],
	files: [],
	agents: [],
	skills: [],
	hubCommands: [],
	programs: [],
});

export const featureManifest = (name: string, options: Record<string, unknown> = {}): Record<string, unknown> => ({
	name,
	description: { en: `Feature ${name}`, ru: `Feature ${name} (ru)` },
	enabledByDefault: false,
	platforms: ["linux", "windows", "darwin"],
	dependencies: [],
	rules: [],
	hooks: [],
	settings: [],
	plugins: [],
	files: [],
	agents: [],
	skills: [],
	hubCommands: [],
	programs: [],
	...options,
});

const parentPath = (path: string): string => {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
};

const normalize = (path: string): string => path.replace(/\/+/g, "/").replace(/\/\.$/, "");

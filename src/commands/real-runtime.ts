import type { FileSystem } from "../file-system.js";
import type { Language, Messages } from "../messages.js";
import type { RuntimePorts, ProcessOptions, ProcessOutput, ProcessPorts } from "../ports.js";
import type { HostPlatform } from "../node-file-operations.js";
import type { Result } from "../result.js";
import type { RigState } from "../state.js";
import type { RepositoryName, UpdatePorts } from "../update/update.js";

import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir, platform as hostPlatform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createNodeAssetFileSystem } from "../assets/node-asset-file-system.js";
import { atomicWrite, toSlashPath } from "../file-system.js";
import { DEFAULT_LANGUAGE, messagesFor } from "../messages.js";
import { modeOf, resolveTarget, writeDurable, writeExclusiveAtomic } from "../node-file-operations.js";
import { err, errorText, ok } from "../result.js";
import { readStoredLanguage } from "../state.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { runProcess } from "./process-runner.js";
import { parseVersion, VERSION_PATHS } from "../version-manifest.js";

// This keeps lock waits responsive without spinning while another command owns the lock.
const LOCK_POLL_INTERVAL_MS = 250;
const EXECUTABLE_FILE_MODE = 0o755;
const sleepFor = (milliseconds: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
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
export const readRealLanguage = async (): Promise<Language> => readStoredLanguage(createFileSystem(), realHome());

export const createRealRuntime = async (options: RealRuntimeOptions = {}): Promise<Result<RuntimePorts>> => {
	const fileSystem = createFileSystem();
	const home = realHome();
	// The language is read here, once per command run, before anything that can fail and print; it travels in the
	// runtime from now on. A missing or unreadable state.json means the default language.
	const language = await readStoredLanguage(fileSystem, home);
	const startMessages = messagesFor(language);
	const hostName = options.hostName ?? hostPlatform();
	const platform = toPlatform(hostName);
	if (platform === null) return err(startMessages.runtime.platformUnsupported(hostName));
	const pathSeparator = platform === "windows" ? ";" : ":";
	const additionalPaths = [join(home, ".local", "bin"), join(home, ".bun", "bin")];
	const pathEnvironment = [...additionalPaths, process.env.PATH ?? ""].join(pathSeparator);
	const processPorts = createProcessPorts(pathEnvironment);
	const processStart = await ownerStartTime(process.pid, processPorts);
	if (!processStart.ok) return err(startMessages.runtime.processStartUnknown(processStart.error));
	if (processStart.value === null) return err(startMessages.runtime.processNotFound());
	const pythonCommand = platform === "windows" ? "python" : "python3";
	const runtime: RuntimePorts = {
		fs: fileSystem,
		assetFs: createNodeAssetFileSystem(),
		process: processPorts,
		lock: {
			fs: fileSystem,
			home,
			process: {
				pid: process.pid,
				startTime: processStart.value,
				ownerStartTime: (pid) => ownerStartTime(pid, processPorts),
			},
			clock: { sleep: sleepFor, now: () => Date.now() },
			pollIntervalMs: LOCK_POLL_INTERVAL_MS,
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
					return err(errorText(error));
				}
			},
			removeDirectory: async (path) => {
				try {
					await fs.rm(path, { recursive: true, force: true });
					return ok(undefined);
				} catch (error) {
					return err(errorText(error));
				}
			},
		},
		writeExecutable: async (path, content) => {
			const written = await atomicWrite(fileSystem, path, content);
			if (!written.ok) return written;
			if (platform === "windows") return ok(undefined);
			try {
				await fs.chmod(path, EXECUTABLE_FILE_MODE);
				return ok(undefined);
			} catch (error) {
				return err(`Could not make ${path} executable: ${errorText(error)}`);
			}
		},
	};
	return ok(runtime);
};

export const createRealGitAdapter = (
	processPorts: RuntimePorts["process"],
	paths: RigState["paths"],
): UpdatePorts["git"] => ({
	isClean: async (repository) => {
		const result = await runGit(processPorts, repository, ["status", "--porcelain"], paths);
		return result.ok ? ok(result.value.trim().length === 0) : result;
	},
	branchProblem: async (repository) => {
		const branch = await runGit(processPorts, repository, ["branch", "--show-current"], paths);
		if (!branch.ok) return branch;
		if (branch.value.trim() !== UPDATE_BRANCH) return ok("not-on-main");
		const ahead = await runGit(processPorts, repository, ["rev-list", "--count", `origin/${UPDATE_BRANCH}..HEAD`], paths);
		if (!ahead.ok) return ahead;
		return ok(Number(ahead.value.trim()) > NO_LOCAL_COMMITS ? "local-commits" : null);
	},
	fetchMain: async (repository) => {
		const fetched = await runGit(processPorts, repository, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], paths);
		if (!fetched.ok) return fetched;
		const target = await runGit(processPorts, repository, ["rev-parse", "origin/main"], paths);
		return target.ok ? ok(target.value.trim()) : target;
	},
	readVersion: async (repository, commit) => {
		const path = VERSION_PATHS[repository];
		const repositoryPath = repository === "rig" ? paths.repo : paths.hub;
		const exists = await processPorts.run("git", ["-C", repositoryPath, "cat-file", "-e", `${commit}:${path}`]);
		if (!exists.ok) return exists;
		if (exists.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return ok(null);
		const file = await runGit(processPorts, repository, ["show", `${commit}:${path}`], paths);
		return file.ok ? ok(parseVersion(file.value)) : file;
	},
	head: async (repository) => {
		const result = await runGit(processPorts, repository, ["rev-parse", "HEAD"], paths);
		return result.ok ? ok(result.value.trim()) : result;
	},
	fastForward: async (repository, commit) => {
		const result = await runGit(processPorts, repository, ["merge", "--ff-only", commit], paths);
		return result.ok ? ok(undefined) : result;
	},
	resetKeep: async (repository, commit) => {
		const result = await runGit(processPorts, repository, ["reset", "--keep", commit], paths);
		return result.ok ? ok(undefined) : result;
	},
});

const runGit = async (
	processPorts: RuntimePorts["process"],
	repository: RepositoryName,
	args: readonly string[],
	paths: RigState["paths"],
): Promise<Result<string>> => {
	const repositoryPath = repository === "rig" ? paths.repo : paths.hub;
	const result = await processPorts.run("git", ["-C", repositoryPath, ...args]);
	if (!result.ok) return result;
	return result.value.exitCode === PROCESS_SUCCESS_EXIT_CODE
		? ok(result.value.stdout)
		: err(result.value.stderr || result.value.stdout || `git ${args.join(" ")} failed with code ${result.value.exitCode}`);
};

export const createFileSystem = (hostKind: HostPlatform = hostPlatform() === "win32" ? "windows" : "posix"): FileSystem => ({
	readText: (path) => fs.readFile(path, "utf8"),
	writeText: (path, value) => fs.writeFile(path, value, "utf8"),
	appendText: (path, value) => fs.appendFile(path, value, "utf8"),
	rename: (from, to) => fs.rename(from, to),
	remove: (path) => fs.unlink(path),
	ensureDirectory: async (path) => { await fs.mkdir(path, { recursive: true }); },
	writeExclusive: (path, value) => writeExclusiveAtomic(path, value, hostKind),
	resolveTarget,
	modeOf,
	writeDurable: (path, value, mode) => writeDurable(path, value, mode, hostKind),
	listDirectory: async (path) => {
		const entries = await fs.readdir(path, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
	},
	uniqueSuffix: () => `${Date.now()}-${randomUUID()}`,
});

const createProcessPorts = (pathEnvironment: string) => ({
	run: (command: string, args: readonly string[], options?: ProcessOptions) => runProcess(pathEnvironment, command, args, options),
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
			? await runProcess(pathEnvironment, "where.exe", [command])
			: await runProcess(pathEnvironment, "sh", ["-c", "command -v -- \"$1\"", "rig-command-lookup", command]);
		return lookup.ok && lookup.value.exitCode === PROCESS_SUCCESS_EXIT_CODE;
	},
});

// ok(number): start time of the running process; ok(null): no such process; err: the answer could not be obtained, which
// the lock treats as "still running".
export const ownerStartTime = async (
	pid: number,
	processPorts: Pick<RuntimePorts["process"], "run">,
	hostName: NodeJS.Platform = hostPlatform(),
): Promise<Result<number | null>> => {
	if (hostName === "linux") {
		try {
			const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
			const closingParenthesis = text.lastIndexOf(")");
			if (closingParenthesis < 0) return err(`Unreadable /proc/${pid}/stat`);
			const fields = text.slice(closingParenthesis + 1).trim().split(/\s+/);
			const startTicks = Number(fields[LINUX_PROC_START_TIME_INDEX]);
			return Number.isFinite(startTicks) ? ok(startTicks) : err(`Unreadable start time in /proc/${pid}/stat`);
		} catch (error) {
			return isNotFound(error) ? ok(null) : err(errorText(error));
		}
	}
	if (hostName === "win32") {
		// Without ErrorAction Stop a missing process prints nothing and exits 0, so a failure is not mistaken for absence.
		const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`;
		const result = await processPorts.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		if (!result.ok) return err(result.error);
		if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(result.value.stderr || `powershell exited with ${result.value.exitCode}`);
		const text = result.value.stdout.trim();
		if (text.length === 0) return ok(null);
		const ticks = Number(text);
		return Number.isFinite(ticks) ? ok(ticks) : err(`Unexpected start time from powershell: ${text}`);
	}
	if (hostName === "darwin") {
		const result = await processPorts.run("ps", ["-o", "lstart=", "-p", String(pid)]);
		if (!result.ok) return err(result.error);
		const text = result.value.stdout.trim();
		if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return text.length === 0 && result.value.stderr.trim().length === 0 ? ok(null) : err(result.value.stderr);
		const start = Date.parse(text);
		return Number.isFinite(start) ? ok(start) : err(`Unexpected start time from ps: ${text}`);
	}
	return err(`Process start time is not supported on ${hostName}`);
};

type ProcessRunner = Pick<ProcessPorts, "run">;
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
			const stopped = await processPorts.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Stop-ScheduledTask -TaskName 'telegram-hub' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'telegram-hub'"]);
			return processSuccess(stopped, messages.runtime.taskRestartLabel());
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
		const result = await runProcess(runtime.pathEnvironment, runtime.executablePath, ["add", "--global", CODEX_PACKAGE]);
		return processSuccess(result, messagesFor(runtime.language).runtime.codexInstallLabel());
	}
	if (name === "opencode") {
		const command = platform === "windows" ? "npm.cmd" : "npm";
		const result = await runProcess(runtime.pathEnvironment, command, ["install", "--global", "--prefix", binDirectory, OPENCODE_PACKAGE]);
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
		const archive = await fetchBytes(release.value.asset.url);
		if (!archive.ok) return archive;
		const digest = createHash("sha256").update(archive.value).digest("hex");
		if (digest !== release.value.checksum) return err(messages.runtime.rtkChecksumMismatch(release.value.asset.name));
		await fs.writeFile(archivePath, archive.value);
		const extracted = await runProcess(runtime.pathEnvironment, platform === "windows" ? "tar.exe" : "tar", ["-xf", archivePath, "-C", temporary.value]);
		const extractedResult = processSuccess(extracted, messages.runtime.rtkExtractLabel());
		if (!extractedResult.ok) return extractedResult;
		const sourcePath = join(temporary.value, targetName);
		const binary = await readBytes(sourcePath);
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
		const checksumText = await fetchText(checksums.url);
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

const fetchText = async (url: string): Promise<Result<string>> => {
	try {
		const response = await fetch(url, { headers: { "User-Agent": "agent-rig" } });
		return response.ok ? ok(await response.text()) : err(`Download failed with HTTP ${response.status}`);
	} catch (error) {
		return err(errorText(error));
	}
};

const fetchBytes = async (url: string): Promise<Result<Uint8Array>> => {
	try {
		const response = await fetch(url, { headers: { "User-Agent": "agent-rig" } });
		return response.ok ? ok(new Uint8Array(await response.arrayBuffer())) : err(`Download failed with HTTP ${response.status}`);
	} catch (error) {
		return err(errorText(error));
	}
};

const readBytes = async (path: string): Promise<Result<Uint8Array>> => {
	try {
		return ok(await fs.readFile(path));
	} catch (error) {
		return err(errorText(error));
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

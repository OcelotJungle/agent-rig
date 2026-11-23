import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";
import type { SessionEnding } from "../session-ending.js";
import type { OwnerSwitch, OwnerTarget } from "../session-owner.js";

import { localPluginOrigin, readMarketplaceManifest } from "../apply.js";
import { findOnPath } from "../executable-path.js";
import { readFeature } from "../feature.js";
import { joinPath } from "../file-system.js";
import { buildLaunchCommand } from "../launch-command.js";
import { launchPath, LAUNCH_TOKEN } from "../launch-safety.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE, LAUNCH_FAILED, LAUNCH_ACCOUNT_LOOKUP, LAUNCH_INVALID, LAUNCH_UNAVAILABLE, LAUNCH_TIMEOUT, SESSION_ENDING, SESSION_RUNNING } from "../output.js";
import { errorText } from "../result.js";
import { liveProcesses, lookupSession, lookupSessionForCommand, processKey, recordedConfigDir, sessionLive, SESSION_POLL_MS } from "../session-core.js";
import { withSessionEnding } from "../session-ending.js";
import { readOwner, writeOwner } from "../session-owner.js";
import { scanTranscriptBackwards } from "../transcript-scan.js";
import { accountOf, INFO_ERROR_STATE_UNREADABLE } from "./info.js";
import { resolveOwnerTarget } from "./session-owner-target.js";
import { readRigState } from "./shared.js";
import { endSession, stopEndingSession } from "./session-stop.js";

// How long a launch waits to see whether its process exits at once (ms); the launch file is removed only once older than this.
const LAUNCH_EXIT_GRACE_MS = 2000;
// Most stderr bytes a failed launch returns.
const STDERR_LIMIT = 1000;
// Seconds a session run waits when the command gives no timeout of its own.
const DEFAULT_TIMEOUT_SEC = 90;
const MS_PER_SECOND = 1000;
// The registration allowance used by launch polling and by stop after a launching owner dies.
export const LAUNCH_REGISTRATION_WAIT_MS = DEFAULT_TIMEOUT_SEC * MS_PER_SECOND;
export const launchRegistrationDeadline = (startedAt: number): number => startedAt + LAUNCH_EXIT_GRACE_MS + LAUNCH_REGISTRATION_WAIT_MS;
const POSIX_PATH_SEPARATOR = ":";
const WINDOWS_PATH_SEPARATOR = ";";
// File types cmd.exe /c tries for a bare name, in its lookup order; PATH order comes first.
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".com", ".cmd", ".bat"] as const;
const MODES = ["manual", "auto", "acceptEdits", "plan", "dontAsk"] as const;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `pid` is null when the owner switch was unavailable: the launch is not waited for, only its exit grace is checked.
type LaunchResult = { session: string; pid: number | null; mode: string | null; account: number | null } & OwnerSwitch;
// The step a launch runs right before its spawn, inside the ending marker's guarded transition when there is one.
type LaunchStep = () => Promise<ApiResult<void>>;
type SpawnLaunch = (command: string[], before: LaunchStep) => Promise<ApiResult<number>>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validMode = (value: string): boolean => MODES.some((mode) => mode === value);
const invalid = (message: string): ApiResult<never> => apiFail(LAUNCH_INVALID, message);

// The full path of a launcher found on PATH, or null. The launch starts that path, not the bare name PATH would resolve again.
const launcherPath = async (runtime: RuntimePorts, name: string, suffixes: readonly string[] = [""]): Promise<string | null> => findOnPath(
	runtime.pathEnvironment,
	runtime.platform === "windows" ? WINDOWS_PATH_SEPARATOR : POSIX_PATH_SEPARATOR,
	(directory) => runtime.resolvePath(directory, name),
	async (path) => await runtime.fs.stat(path) !== null,
	suffixes,
);

// The one cswap lookup of a launch: the full path of the file that will run, or null. resolveLaunch does it once and
// hands the result to both the account decision and prepareLaunch, so the file checked is the file started. On Windows
// a .cmd or .bat shim counts, as cmd.exe /c runs it.
export const findCswap = async (runtime: RuntimePorts): Promise<string | null> => launcherPath(runtime, "cswap", runtime.platform === "windows" ? WINDOWS_EXECUTABLE_SUFFIXES : [""]);

export const prepareLaunch = async (runtime: RuntimePorts, session: SessionRecord, account: string, mode: string | null, cswapFound: string | null): Promise<ApiResult<string[]>> => {
	const m = messagesFor(runtime.language).session;
	if (!SESSION_ID.test(session.id)) return invalid(m.launchSessionId());
	if (account !== "" && !LAUNCH_TOKEN.test(account)) return invalid(m.launchAccount());
	if (mode !== null && !validMode(mode)) return invalid(m.launchMode());
	if (session.cwd === null) return invalid(m.launchDirectory());
	const cwd = launchPath(runtime.platform, session.cwd);
	if (!cwd.ok) return invalid(m.launchDirectory());
	try { await runtime.fs.listDirectory(session.cwd); } catch { return invalid(m.launchDirectoryMissing()); }
	const state = await readRigState(runtime);
	if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
	const plugins: string[] = [];
	if (state.value.features.telegram === true) {
		const feature = await readFeature(runtime.fs, joinPath(state.value.paths.repo, "features", "telegram"), messagesFor(runtime.language));
		if (!feature.ok) return invalid(feature.error);
		for (const plugin of feature.value.plugins) {
			const origin = localPluginOrigin(plugin, state.value.paths.hub, state.value.paths.repo);
			let id = plugin;
			if (origin !== null) {
				const marketplace = await readMarketplaceManifest(runtime.fs, origin.path, origin.label, messagesFor(runtime.language));
				if (!marketplace.ok) return invalid(marketplace.error);
				if (origin.mustBeListed && !marketplace.value.plugins.includes(origin.name)) return invalid(m.pluginMissingFromMarketplace(origin.name, marketplace.value.name));
				id = `${origin.name}@${marketplace.value.name}`;
			}
			if (!LAUNCH_TOKEN.test(id)) return invalid(m.launchPlugin());
			plugins.push(id);
		}
	}
	if (cswapFound === null && account !== "") return invalid(m.launchNoCswap());
	// The path goes onto the launch line like the directory does, so the same platform rules apply to it.
	const cswapOnLine = cswapFound === null ? null : launchPath(runtime.platform, cswapFound);
	if (cswapOnLine !== null && !cswapOnLine.ok) return apiFail(LAUNCH_UNAVAILABLE, m.launchCswapPath());
	const cswap = cswapOnLine === null ? null : cswapOnLine.value;
	const display = Boolean(runtime.environment.get("DISPLAY") || runtime.environment.get("WAYLAND_DISPLAY"));
	const terminal = runtime.platform === "linux" && display ? await launcherPath(runtime, "x-terminal-emulator") : null;
	const tmux = runtime.platform === "linux" && terminal === null ? await launcherPath(runtime, "tmux") : null;
	const command = buildLaunchCommand({ platform: runtime.platform, cwd: cwd.value, session: session.id, account, mode, plugins, cswap, terminal, tmux });
	return command === null ? apiFail(LAUNCH_UNAVAILABLE, m.launchUnavailable()) : apiOk(command);
};

export const transcriptMode = async (runtime: RuntimePorts, path: string | null): Promise<string | null> => {
	if (path === null) return null;
	try {
		return await scanTranscriptBackwards(runtime, path, (value) => object(value) && value.type === "permission-mode" && typeof value.permissionMode === "string" ? (value.permissionMode === "default" ? "manual" : value.permissionMode) : null);
	} catch { return null; }
};

// A launch without an ending marker has no guard: the step and the start simply run in order.
const startUnguarded = async <T>(before: LaunchStep, start: (deadline: number) => T, deadline: () => number): Promise<ApiResult<T>> => {
	const prepared = await before();
	return prepared.ok ? apiOk(start(deadline())) : prepared;
};

const spawnLaunch = async (runtime: RuntimePorts, command: string[], before: LaunchStep, ending?: SessionEnding): Promise<ApiResult<number>> => {
	const directory = joinPath(runtime.home, ".agent-rig", "launch-stderr");
	const now = runtime.clock.now().getTime();
	const path = joinPath(directory, `${now}-${runtime.ids.next()}.log`);
	try {
		await runtime.fs.ensureDirectory(directory);
		for (const entry of await runtime.fs.listDirectory(directory)) {
			const match = /^(\d+)-[\w-]+\.log$/.exec(entry.name);
			// A concurrent launch needs its stderr until its grace period has elapsed.
			if (!entry.directory && match && now - Number(match[1]) >= LAUNCH_EXIT_GRACE_MS) await runtime.fs.remove(joinPath(directory, entry.name)).catch(() => undefined);
		}
	} catch (error) { return apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.io(errorText(error))); }
	const deadline = () => launchRegistrationDeadline(runtime.clock.now().getTime());
	const start = (registrationDeadline: number) => ({ registrationDeadline, process: runtime.process.spawnDetached(command, LAUNCH_EXIT_GRACE_MS, STDERR_LIMIT, path) });
	const started = ending === undefined ? await startUnguarded(before, start, deadline) : await ending.startLaunch(before, start, deadline);
	if (!started.ok) {
		await runtime.fs.remove(path).catch(() => undefined);
		return started;
	}
	const result = await started.value.process;
	// On Windows the child may still hold the file; the next launch retries it.
	await runtime.fs.remove(path).catch(() => undefined);
	if (!result.ok) return apiFail(LAUNCH_FAILED, result.error);
	return !result.value.exited || result.value.exitCode === 0 ? apiOk(started.value.registrationDeadline) : apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.launchExited(result.value.exitCode, result.value.stderr));
};

type ResolvedLaunch = { command: string[]; account: string; target: OwnerTarget };

// The whole launch, account and the account's owner ids included, resolved into a Result before any destructive step. A
// failed account lookup matters only where cswap could use the account; without cswap the session starts as before 0.7.0,
// without one.
export const resolveLaunch = async (runtime: RuntimePorts, session: SessionRecord, mode: string | null, accountOverride: string | null): Promise<ApiResult<ResolvedLaunch>> => {
	const m = messagesFor(runtime.language);
	const cswap = await findCswap(runtime);
	let accountText = accountOverride ?? "";
	if (accountOverride === null) {
		const state = await readRigState(runtime);
		if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
		const account = await accountOf(runtime, state.value, await recordedConfigDir(runtime, session.id));
		if (account.ok) accountText = account.value === null ? "" : String(account.value);
		else if (cswap !== null) return apiFail(LAUNCH_ACCOUNT_LOOKUP, m.session.launchAccountLookup(account.error));
	}
	if (accountText !== "" && !/^\d+$/.test(accountText)) return invalid(m.session.accountNumber());
	const command = await prepareLaunch(runtime, session, accountText, mode, cswap);
	if (!command.ok) return command;
	const target = await resolveOwnerTarget(runtime, cswap, accountText);
	return target.ok ? apiOk({ command: command.value, account: accountText, target: target.value }) : target;
};

// The last steps of a launch whose command is resolved and whose session is not running: make the launch account the
// transcript's owner, spawn, and (unless the owner switch was unavailable) wait for the new process to register.
const launchResolved = async (runtime: RuntimePorts, session: SessionRecord, launch: ResolvedLaunch, mode: string | null, spawnCommand: SpawnLaunch): Promise<ApiResult<LaunchResult>> => {
	const reading = await readOwner(runtime, session, launch.target);
	if (!reading.ok) return reading;
	const plan = reading.value;
	// The owner line is appended by `before`, inside the launch transition; a reading that needs no write is settled already.
	let decided: OwnerSwitch | null = plan.kind === "settled" ? plan.owner : null;
	const before = async (): Promise<ApiResult<void>> => {
		if (plan.kind === "settled") return apiOk(undefined);
		const written = await writeOwner(runtime, plan);
		if (!written.ok) return written;
		decided = written.value;
		return apiOk(undefined);
	};
	const account = launch.account === "" ? null : Number(launch.account);
	const spawned = await spawnCommand(launch.command, before);
	if (!spawned.ok) return spawned;
	const owner: OwnerSwitch | null = decided;
	if (owner === null) return apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.io(messagesFor(runtime.language).failure.ownerNotDecided()));
	// Without the owner switch Claude Code may refuse the session at once: the grace check is all the launch can tell.
	if (owner.ownerSwitch === "unavailable") return apiOk({ session: session.id, pid: null, mode, account, ...owner });
	const deadline = spawned.value;
	for (;;) {
		const current = await lookupSession(runtime, session.id);
		if (!current.ok) return current;
		// The launched process is one the record did not name before the launch.
		const earlier = new Set(session.processes.map(processKey));
		const started = current.value.processes.filter((process) => !earlier.has(processKey(process)));
		if (started.length > 0) {
			const currentLive = await liveProcesses(runtime, { ...current.value, processes: started });
			if (!currentLive.ok) return currentLive;
			const [first] = currentLive.value;
			if (first !== undefined) return apiOk({ session: session.id, pid: first.pid, mode, account, ...owner });
		}
		const remaining = deadline - runtime.clock.now().getTime();
		if (remaining <= 0) return apiFail(LAUNCH_TIMEOUT, messagesFor(runtime.language).session.launchTimeout());
		await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
	}
};

export const runSession = async (runtime: RuntimePorts, session: SessionRecord, mode: string | null, accountOverride: string | null, spawnCommand: SpawnLaunch = (command, before) => spawnLaunch(runtime, command, before)): Promise<ApiResult<LaunchResult>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (live.value) return apiFail(SESSION_RUNNING, messagesFor(runtime.language).session.alreadyRunning());
	const launch = await resolveLaunch(runtime, session, mode, accountOverride);
	return launch.ok ? launchResolved(runtime, session, launch.value, mode, spawnCommand) : launch;
};

// After a launch inside the ending marker: a stop that took the marker over ends the session the launch started.
const unlessTakenOver = async <T>(runtime: RuntimePorts, id: string, ending: SessionEnding, result: ApiResult<T>): Promise<ApiResult<T>> => {
	const interrupted = await ending.takenOver();
	if (!interrupted.ok) return interrupted;
	if (!interrupted.value) return result;
	const current = await lookupSession(runtime, id);
	if (!current.ok) return current;
	const ended = await endSession(runtime, current.value);
	if (!ended.ok) return ended;
	return apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending());
};

// A stop that took the marker over wins whatever the launch result was.
const endingReleased = <T>(runtime: RuntimePorts, result: ApiResult<T>, takenOver: boolean): ApiResult<T> => takenOver ? apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending()) : result;

const ownerSwitchOf = (value: OwnerSwitch): OwnerSwitch => value.ownerSwitch === "unavailable" ? { ownerSwitch: "unavailable", ownerSwitchReason: value.ownerSwitchReason } : { ownerSwitch: value.ownerSwitch };

export const runCommand = async (runtime: RuntimePorts, args: readonly string[]): Promise<ApiResult<LaunchResult>> => {
	const [id, ...flags] = args;
	if (!id) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageRun());
	let mode: string | null = null;
	let account: string | null = null;
	for (let index = 0; index < flags.length; index += 2) {
		const flag = flags[index];
		const value = flags[index + 1];
		if (!value || (flag === "--mode" && mode !== null) || (flag === "--account" && account !== null) || (flag !== "--mode" && flag !== "--account")) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.invalidRunArguments());
		if (flag === "--mode") mode = value; else account = value;
	}
	// Only to refuse an unknown id before the marker directory is created for it; the launch reads the record again inside the marker.
	const known = await lookupSessionForCommand(runtime, id, false);
	if (!known.ok) return known;
	return withSessionEnding<LaunchResult>(runtime, id, async (ending) => {
		const session = await lookupSessionForCommand(runtime, id, false);
		if (!session.ok) return session;
		const result = await runSession(runtime, session.value, mode ?? await transcriptMode(runtime, session.value.transcriptPath), account, (command, before) => spawnLaunch(runtime, command, before, ending));
		return unlessTakenOver(runtime, id, ending, result);
	}, undefined, (result, takenOver) => endingReleased(runtime, result, takenOver));
};

type ModeResult = { session: string; mode: string; changed: false } | ({ session: string; mode: string; pid: number | null } & OwnerSwitch);

export const modeCommand = async (runtime: RuntimePorts, args: readonly string[], progress: (event: ProgressEvent) => void): Promise<ApiResult<ModeResult>> => {
	if (args.length !== 2) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageMode());
	const [id, mode] = args;
	if (!validMode(mode)) return invalid(messagesFor(runtime.language).session.launchMode());
	const session = await lookupSessionForCommand(runtime, id, false);
	if (!session.ok) return session;
	return withSessionEnding<ModeResult>(runtime, id, async (ending) => {
		if (await transcriptMode(runtime, session.value.transcriptPath) === mode) return apiOk({ session: id, mode, changed: false });
		const launch = await resolveLaunch(runtime, session.value, mode, null);
		if (!launch.ok) return launch;
		const stopped = await stopEndingSession(runtime, session.value, progress, ending);
		if (!stopped.ok) return stopped;
		// The record read before the stop is stale by now: the launch checks and plans on a fresh one.
		const fresh = await lookupSession(runtime, id);
		if (!fresh.ok) return fresh;
		const live = await sessionLive(runtime, fresh.value);
		const started = !live.ok ? live : live.value ? apiFail(SESSION_RUNNING, messagesFor(runtime.language).session.alreadyRunning()) : await launchResolved(runtime, fresh.value, launch.value, mode, (command, before) => spawnLaunch(runtime, command, before, ending));
		const result = await unlessTakenOver(runtime, id, ending, started);
		return result.ok ? apiOk({ session: id, mode, pid: result.value.pid, ...ownerSwitchOf(result.value) }) : result;
	}, undefined, (result, takenOver) => endingReleased(runtime, result, takenOver));
};

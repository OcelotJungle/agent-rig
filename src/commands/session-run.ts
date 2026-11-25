import type { ApiResult, ProgressEvent } from "../output.js";
import type { LaunchedWindow } from "../launch-window.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";
import type { LaunchGate, LaunchStart, SessionEnding } from "../session-ending.js";
import type { OwnerGate, OwnerReading, OwnerRefusal, OwnerSwitch, OwnerTarget } from "../session-owner.js";

import { localPluginOrigin, readMarketplaceManifest } from "../apply.js";
import { findOnPath } from "../executable-path.js";
import { readFeature } from "../feature.js";
import { joinPath } from "../file-system.js";
import { buildLaunchCommand } from "../launch-command.js";
import { launchPath, LAUNCH_TOKEN } from "../launch-safety.js";
import { closeLaunchedWindow } from "../launch-window.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk, ACCOUNT_CONFIG_BUSY, ACCOUNT_PROFILE_INCOMPLETE, ACCOUNT_PROFILE_MISSING, ACCOUNT_PROFILE_UNREADABLE, ERROR_CODE_USAGE, WORKSPACE_UNTRUSTED, LAUNCH_FAILED, LAUNCH_ACCOUNT_LOOKUP, LAUNCH_INVALID, LAUNCH_UNAVAILABLE, LAUNCH_TIMEOUT, OWNER_SWITCH_UNAVAILABLE, PROMPT_DELIVERY_UNKNOWN, PROMPT_NOT_DELIVERED, SESSION_CLAIM_LOST, SESSION_ENDING, SESSION_RUNNING, SESSION_TIMEOUT_RUNNING } from "../output.js";
import { errorText } from "../result.js";
import { liveProcesses, lookupSession, lookupSessionForCommand, processKey, recordedConfigDir, requestSession, sessionLive, sessionModuleStartedSince, SESSION_POLL_MS, SESSION_TIMEOUTS } from "../session-core.js";
import { withSessionEnding } from "../session-ending.js";
import { describeDetail, readOwner, writeOwner } from "../session-owner.js";
import { scanTranscriptBackwards } from "../transcript-scan.js";
import { prepareFolderConsent } from "./account-config.js";
import { accountOf, INFO_ERROR_STATE_UNREADABLE } from "./info.js";
import { resolveOwnerTarget } from "./session-owner-target.js";
import { emitRigEvent, readRigState } from "./shared.js";
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
// The module starts with its process (at session start), so once the process has registered its snapshot gets the same allowance.
const MODULE_UP_WAIT_MS = LAUNCH_REGISTRATION_WAIT_MS;
const POSIX_PATH_SEPARATOR = ":";
const WINDOWS_PATH_SEPARATOR = ";";
// File types cmd.exe /c tries for a bare name, in its lookup order; PATH order comes first.
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".com", ".cmd", ".bat"] as const;
// The rig event a refused launch leaves for the user, next to the failed result.
const OWNER_SWITCH_REFUSED_EVENT = "owner-switch-refused";
const ACCOUNT_CONSENT_REFUSED_EVENT = "account-consent-refused";
const LAUNCH_BLOCKED_SCREEN_EVENT = "launch-blocked-screen";
// The rig events of a launch whose process started but whose prompt was not (or may not have been) delivered.
const PROMPT_NOT_DELIVERED_EVENT = "prompt-not-delivered";
const PROMPT_DELIVERY_UNKNOWN_EVENT = "prompt-delivery-unknown";
const MODES = ["manual", "auto", "acceptEdits", "plan", "dontAsk"] as const;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `pid` is null when the launch had no owner switch to make (`ownerSwitch: "none"`) and no prompt to deliver: it is not waited for, only its exit grace is checked.
// `promptDelivered` is present only on a launch that carried a prompt and delivered it; a launch that did not deliver it fails.
type LaunchResult = { session: string; pid: number | null; mode: string | null; account: number | null; promptDelivered?: true } & OwnerSwitch;
// The step a launch runs right before its spawn, inside the ending marker's guarded transition when there is one: it lets
// the launch go on with a decision, or stays (no spawn) with an outcome.
type LaunchStep<D, S> = () => Promise<ApiResult<LaunchGate<D, S>>>;
// What a launch attempt came to: the decision the step made and the registration deadline, or the outcome it stayed with.
type Spawned<D> = { kind: "spawned"; decision: D; deadline: number };
type Declined<S> = { kind: "declined"; outcome: S };
export type SpawnLaunch = <D, S>(command: string[], before: LaunchStep<D, S>) => Promise<ApiResult<Spawned<D> | Declined<S>>>;
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
const startUnguarded = async <D, S, T>(before: LaunchStep<D, S>, start: (deadline: number, decision: D) => T, deadline: () => number): Promise<ApiResult<LaunchStart<T, S>>> => {
	const prepared = await before();
	if (!prepared.ok) return prepared;
	return apiOk(prepared.value.kind === "stay" ? { kind: "declined", outcome: prepared.value.outcome } : { kind: "started", started: start(deadline(), prepared.value.decision) });
};

// The stderr directory is made and pruned once per launch, not on every try of the owner loop: a retry spawns nothing.
const prepareStderrDirectory = async (runtime: RuntimePorts, directory: string, now: number): Promise<ApiResult<null>> => {
	try {
		await runtime.fs.ensureDirectory(directory);
		for (const entry of await runtime.fs.listDirectory(directory)) {
			const match = /^(\d+)-[\w-]+\.log$/.exec(entry.name);
			// A concurrent launch needs its stderr until its grace period has elapsed.
			if (!entry.directory && match && now - Number(match[1]) >= LAUNCH_EXIT_GRACE_MS) await runtime.fs.remove(joinPath(directory, entry.name)).catch(() => undefined);
		}
		return apiOk(null);
	} catch (error) { return apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.io(errorText(error))); }
};

// The spawn of one launch: the returned function is used for every try of that launch and prepares the stderr directory on the first.
const launcher = (runtime: RuntimePorts, ending?: SessionEnding): SpawnLaunch => {
	let prepared = false;
	return async (command, before) => {
		const directory = joinPath(runtime.home, ".agent-rig", "launch-stderr");
		const now = runtime.clock.now().getTime();
		if (!prepared) {
			const ready = await prepareStderrDirectory(runtime, directory, now);
			if (!ready.ok) return ready;
			prepared = true;
		}
		return spawnLaunch(runtime, directory, now, command, before, ending);
	};
};

const spawnLaunch = async <D, S>(runtime: RuntimePorts, directory: string, now: number, command: string[], before: LaunchStep<D, S>, ending?: SessionEnding): Promise<ApiResult<Spawned<D> | Declined<S>>> => {
	const path = joinPath(directory, `${now}-${runtime.ids.next()}.log`);
	const deadline = () => launchRegistrationDeadline(runtime.clock.now().getTime());
	const start = (registrationDeadline: number, decision: D) => ({ registrationDeadline, decision, process: runtime.process.spawnDetached(command, LAUNCH_EXIT_GRACE_MS, STDERR_LIMIT, path) });
	const attempt = ending === undefined ? await startUnguarded(before, start, deadline) : await ending.startLaunch(before, start, deadline);
	if (!attempt.ok) {
		await runtime.fs.remove(path).catch(() => undefined);
		return attempt;
	}
	// A launch the step stayed: nothing was spawned, so there is no process to wait for.
	if (attempt.value.kind === "declined") {
		await runtime.fs.remove(path).catch(() => undefined);
		return apiOk({ kind: "declined", outcome: attempt.value.outcome });
	}
	const started = attempt.value.started;
	const result = await started.process;
	// On Windows the child may still hold the file; the next launch retries it.
	await runtime.fs.remove(path).catch(() => undefined);
	if (!result.ok) return apiFail(LAUNCH_FAILED, result.error);
	return !result.value.exited || result.value.exitCode === 0 ? apiOk({ kind: "spawned", decision: started.decision, deadline: started.registrationDeadline }) : apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.launchExited(result.value.exitCode, result.value.stderr));
};

type ResolvedLaunch = { command: string[]; account: string; target: OwnerTarget };

// A launch under an account starts in that account's profile, which must already hold the folder's consent: the
// default config's consent is carried into it, and a launch for which that cannot be done is refused before any window
// is opened, with a rig event next to the failed result.
const carryFolderConsent = async (runtime: RuntimePorts, session: SessionRecord, account: number): Promise<ApiResult<null>> => {
	const state = await readRigState(runtime);
	if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
	const m = messagesFor(runtime.language).session;
	// The directory was checked by prepareLaunch.
	const outcome = await prepareFolderConsent(runtime, state.value, account, session.cwd ?? "");
	if (outcome.ok) return apiOk(null);
	if (outcome.reason === "account-lookup") return apiFail(LAUNCH_ACCOUNT_LOOKUP, m.launchAccountLookup(outcome.detail));
	await emitRigEvent(runtime, ACCOUNT_CONSENT_REFUSED_EVENT, "warn", m.accountConsentRefusedEvent(session.id, account, outcome.reason));
	switch (outcome.reason) {
		case WORKSPACE_UNTRUSTED: return apiFail(WORKSPACE_UNTRUSTED, m.workspaceUntrusted(outcome.detail));
		case ACCOUNT_PROFILE_MISSING: return apiFail(ACCOUNT_PROFILE_MISSING, m.accountProfileMissing(account));
		case ACCOUNT_PROFILE_INCOMPLETE: return apiFail(ACCOUNT_PROFILE_INCOMPLETE, m.accountProfileIncomplete(account));
		case ACCOUNT_PROFILE_UNREADABLE: return apiFail(ACCOUNT_PROFILE_UNREADABLE, m.accountProfileUnreadable(account, outcome.detail));
		case ACCOUNT_CONFIG_BUSY: return apiFail(ACCOUNT_CONFIG_BUSY, m.accountConfigBusy(account));
	}
};

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
	if (!target.ok) return target;
	if (accountText !== "") {
		const consent = await carryFolderConsent(runtime, session, Number(accountText));
		if (!consent.ok) return consent;
	}
	return apiOk({ command: command.value, account: accountText, target: target.value });
};

// What the launch's guarded step does with a reading: it goes on (the owner line is appended inside the launch
// transition when the reading planned one) or stays with the reason it is held back.
const ownerStep = (runtime: RuntimePorts, reading: OwnerReading): LaunchStep<OwnerSwitch, OwnerRefusal> => async (): Promise<ApiResult<OwnerGate>> => {
	if (reading.kind === "settled") return apiOk({ kind: "go", decision: reading.owner });
	if (reading.kind === "stay") return apiOk({ kind: "stay", outcome: reading.refusal });
	return writeOwner(runtime, reading);
};

// A launch that cannot make its owner switch is refused before any window: the reason is in the failed result and in a rig event.
const refuseLaunch = async (runtime: RuntimePorts, session: string, account: number | null, held: OwnerRefusal, attempts: number): Promise<ApiResult<never>> => {
	const m = messagesFor(runtime.language).session;
	const detail = describeDetail(held.detail);
	// A failed event write must not hide the refusal itself.
	await emitRigEvent(runtime, OWNER_SWITCH_REFUSED_EVENT, "warn", m.ownerSwitchRefusedEvent(session, account, held.reason, attempts, detail));
	return apiFail(OWNER_SWITCH_UNAVAILABLE, m.ownerSwitchRefused(held.reason, attempts, detail));
};

// A launch whose process never registered left its window on a screen that wants a person. The window is closed (its screen's
// text is read first, only to put it into the message) and the launch is refused with that text; a launch whose window could not
// be found is refused as before. A launch that carried a prompt says in the refusal that the text was not delivered.
const refuseUnregistered = async (runtime: RuntimePorts, launched: LaunchedWindow, account: number | null, withPrompt: boolean): Promise<ApiResult<never>> => {
	const m = messagesFor(runtime.language).session;
	const refusal = (text: string): ApiResult<never> => apiFail(LAUNCH_TIMEOUT, withPrompt ? `${text} ${m.launchPromptNotSent()}` : text);
	const closed = await closeLaunchedWindow(runtime, launched);
	if (closed.killed.length === 0) return refusal(m.launchTimeout());
	// A failed event write must not hide the refusal itself.
	await emitRigEvent(runtime, LAUNCH_BLOCKED_SCREEN_EVENT, "warn", m.launchBlockedScreenEvent(launched.sessionId, account, closed.killed.join(", "), closed.excerpt));
	return refusal(closed.excerpt === "" ? m.launchTimeoutWindowClosed() : m.launchTimeoutWindowClosedScreen(closed.excerpt));
};

// Waits for the launched process to register: a process the record did not name before the launch, alive, within the deadline.
// On the deadline the launch's window is closed and the launch refused.
const awaitRegistration = async (runtime: RuntimePorts, session: SessionRecord, account: number | null, spawnedAt: Date, deadline: number, withPrompt: boolean): Promise<ApiResult<number>> => {
	const earlier = new Set(session.processes.map(processKey));
	for (;;) {
		const current = await lookupSession(runtime, session.id);
		if (!current.ok) return current;
		const started = current.value.processes.filter((process) => !earlier.has(processKey(process)));
		if (started.length > 0) {
			const currentLive = await liveProcesses(runtime, { ...current.value, processes: started });
			if (!currentLive.ok) return currentLive;
			const [first] = currentLive.value;
			if (first !== undefined) return apiOk(first.pid);
		}
		const remaining = deadline - runtime.clock.now().getTime();
		if (remaining <= 0) return refuseUnregistered(runtime, { sessionId: session.id, earlier, spawnedAt }, account, withPrompt);
		await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
	}
};

// A launch whose process started but whose prompt did not (or may not have) reached it leaves the window open, a warn rig event and a failed result.
const refusePrompt = async (runtime: RuntimePorts, session: string, pid: number, kind: "not-delivered" | "unknown", reason: string): Promise<ApiResult<never>> => {
	const m = messagesFor(runtime.language).session;
	const unknown = kind === "unknown";
	const text = unknown ? m.promptDeliveryUnknown(session, pid, reason) : m.promptNotDelivered(session, pid, reason);
	// A failed event write must not hide the refusal itself.
	await emitRigEvent(runtime, unknown ? PROMPT_DELIVERY_UNKNOWN_EVENT : PROMPT_NOT_DELIVERED_EVENT, "warn", text);
	return apiFail(unknown ? PROMPT_DELIVERY_UNKNOWN : PROMPT_NOT_DELIVERED, text);
};

// Waits until the module of the launched process is up (its usage snapshot written at or after the spawn), within the allowance.
const awaitModule = async (runtime: RuntimePorts, session: SessionRecord, spawnedAt: Date): Promise<ApiResult<boolean>> => {
	const deadline = runtime.clock.now().getTime() + MODULE_UP_WAIT_MS;
	for (;;) {
		const up = await sessionModuleStartedSince(runtime, session, spawnedAt.getTime());
		if (!up.ok || up.value) return up;
		const remaining = deadline - runtime.clock.now().getTime();
		if (remaining <= 0) return apiOk(false);
		await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
	}
};

// Hands the prompt to the registered process through the window request queue, so the text is on no command line. The module must be
// the one of this process (not a previous process's leftover), else the request would be answered by nobody or by the wrong process.
const deliverPrompt = async (runtime: RuntimePorts, session: SessionRecord, pid: number, spawnedAt: Date, text: string): Promise<ApiResult<null>> => {
	const m = messagesFor(runtime.language).session;
	const up = await awaitModule(runtime, session, spawnedAt);
	if (!up.ok) return refusePrompt(runtime, session.id, pid, "not-delivered", up.error.message);
	if (!up.value) return refusePrompt(runtime, session.id, pid, "not-delivered", m.promptModuleNotUp());
	// The record read before the spawn does not name the new process.
	const current = await lookupSession(runtime, session.id);
	if (!current.ok) return refusePrompt(runtime, session.id, pid, "not-delivered", current.error.message);
	const sent = await requestSession(runtime, current.value, "prompt", { text }, SESSION_TIMEOUTS.prompt);
	if (sent.ok) return apiOk(null);
	// A module that began the request, or a claimant that vanished, may have submitted the text already.
	const unknown = sent.error.code === SESSION_TIMEOUT_RUNNING || sent.error.code === SESSION_CLAIM_LOST;
	return refusePrompt(runtime, session.id, pid, unknown ? "unknown" : "not-delivered", sent.error.message);
};

// The last steps of a launch whose command is resolved and whose session is not running: make the launch account the
// transcript's owner, spawn, and wait for the new process to register. A launch that cannot make the owner switch is
// refused with no window opened; a transient reason (a process of unknown creation time, a busy or still growing
// transcript) is waited out, one `SESSION_POLL_MS` at a time, until the registration deadline counted from the first
// try, and only then refused. A launch with no account to switch to has no owner switch to make: it spawns as before. A launch
// with a prompt always waits for the registration (the prompt goes to the registered process), then delivers the text.
const launchResolved = async (runtime: RuntimePorts, session: SessionRecord, launch: ResolvedLaunch, mode: string | null, spawnCommand: SpawnLaunch, prompt: string | null = null): Promise<ApiResult<LaunchResult>> => {
	const account = launch.account === "" ? null : Number(launch.account);
	const limit = launchRegistrationDeadline(runtime.clock.now().getTime());
	for (let attempts = 1; ; attempts += 1) {
		// A retry plans on the record as it is now, not as it was when the launch began.
		const current = attempts === 1 ? apiOk(session) : await lookupSession(runtime, session.id);
		if (!current.ok) return current;
		const reading = await readOwner(runtime, current.value, launch.target);
		if (!reading.ok) return reading;
		// Taken before the spawn, so every process of this launch was created at or after it.
		const spawnedAt = runtime.clock.now();
		const spawned = await spawnCommand(launch.command, ownerStep(runtime, reading.value));
		if (!spawned.ok) return spawned;
		if (spawned.value.kind === "declined") {
			const held = spawned.value.outcome;
			const remaining = limit - runtime.clock.now().getTime();
			if (!held.transient || remaining <= 0) return refuseLaunch(runtime, session.id, account, held, attempts);
			await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
			continue;
		}
		const owner = spawned.value.decision;
		// With no owner switch to make Claude Code may refuse the session at once: the grace check is all the launch can tell.
		// A launch with a prompt cannot stop there: the text goes to the registered process.
		if (owner.ownerSwitch === "none" && prompt === null) return apiOk({ session: session.id, pid: null, mode, account, ...owner });
		const registered = await awaitRegistration(runtime, session, account, spawnedAt, spawned.value.deadline, prompt !== null);
		if (!registered.ok) return registered;
		if (prompt === null) return apiOk({ session: session.id, pid: registered.value, mode, account, ...owner });
		const delivered = await deliverPrompt(runtime, session, registered.value, spawnedAt, prompt);
		return delivered.ok ? apiOk({ session: session.id, pid: registered.value, mode, account, ...owner, promptDelivered: true }) : delivered;
	}
};

export const runSession = async (runtime: RuntimePorts, session: SessionRecord, mode: string | null, accountOverride: string | null, spawnCommand: SpawnLaunch = launcher(runtime), prompt: string | null = null): Promise<ApiResult<LaunchResult>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (live.value) return apiFail(SESSION_RUNNING, messagesFor(runtime.language).session.alreadyRunning());
	const launch = await resolveLaunch(runtime, session, mode, accountOverride);
	return launch.ok ? launchResolved(runtime, session, launch.value, mode, spawnCommand, prompt) : launch;
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

export const runCommand = async (runtime: RuntimePorts, args: readonly string[]): Promise<ApiResult<LaunchResult>> => {
	const [id, ...flags] = args;
	if (!id) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageRun());
	let mode: string | null = null;
	let account: string | null = null;
	let prompt: string | null = null;
	for (let index = 0; index < flags.length; index += 2) {
		const flag = flags[index];
		const value = flags[index + 1];
		if (!value || (flag === "--mode" && mode !== null) || (flag === "--account" && account !== null) || (flag === "--prompt" && prompt !== null) || (flag !== "--mode" && flag !== "--account" && flag !== "--prompt")) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.invalidRunArguments());
		if (flag === "--mode") mode = value; else if (flag === "--account") account = value; else prompt = value;
	}
	// Only to refuse an unknown id before the marker directory is created for it; the launch reads the record again inside the marker.
	const known = await lookupSessionForCommand(runtime, id, false);
	if (!known.ok) return known;
	return withSessionEnding<LaunchResult>(runtime, id, async (ending) => {
		const session = await lookupSessionForCommand(runtime, id, false);
		if (!session.ok) return session;
		const result = await runSession(runtime, session.value, mode ?? await transcriptMode(runtime, session.value.transcriptPath), account, launcher(runtime, ending), prompt);
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
		const started = !live.ok ? live : live.value ? apiFail(SESSION_RUNNING, messagesFor(runtime.language).session.alreadyRunning()) : await launchResolved(runtime, fresh.value, launch.value, mode, launcher(runtime, ending));
		const result = await unlessTakenOver(runtime, id, ending, started);
		return result.ok ? apiOk({ session: id, mode, pid: result.value.pid, ownerSwitch: result.value.ownerSwitch }) : result;
	}, undefined, (result, takenOver) => endingReleased(runtime, result, takenOver));
};

import type { RigState } from "../state.js";
import type { Result } from "../result.js";
import type {
	HubFiles,
	Pair,
	PendingRestart,
	RepositoryName,
	UpdateCompletion,
	UpdateEvent,
	UpdatePorts,
	UpdateState,
	UpdateTransaction,
} from "../update/update.js";
import type { LockOwner } from "../lock.js";
import type { Messages } from "../messages.js";
import type { RuntimePorts } from "../ports.js";

import { appendEvent, trimEvents } from "../events.js";
import { loadFeatures } from "../feature-graph.js";
import { messagesFor } from "../messages.js";
import { joinPath } from "../file-system.js";
import { err, errorText, ok } from "../result.js";
import { runPending, runUpdate } from "../update/update.js";
import { applyRig } from "../apply.js";
import { tryAcquireLock } from "../lock.js";
import { inspectRig } from "./check.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { installMissingPrograms } from "./programs.js";
import { createRealGitAdapter } from "./real-runtime.js";
import { pathJoin, withRigLock } from "./shared.js";
import { readState as readRigStateFile, writeState as writeRigStateFile } from "../state.js";

const UPDATE_STATE_RECORD = "update:state";
const HUB_RESTARTING_FILE = "hub-restarting.json";
const HUB_READY_FILE = "hub-ready.json";
const EVENTS_FILE = "events.jsonl";
const UPDATE_STEP_SUCCESS_EXIT_CODE = 0;
const UPDATE_STEP_FAILURE_EXIT_CODE = 1;
// The check could not ask its environment (for example the service manager); the installed rig is not known to be broken.
const UPDATE_STEP_ENVIRONMENT_EXIT_CODE = 2;

type PersistedUpdateState = Pick<UpdateState, "confirmed" | "transaction" | "lastFailure" | "pendingEvent">;
type StepOutcome = { ok: true } | { ok: false; error: string; exitCode: number | null };

export const updateRig = async (
	runtime: RuntimePorts,
	pendingOnly: boolean,
	writeLine: (line: string) => void,
): Promise<Result<void>> => {
	const operation = async (): Promise<Result<void>> => {
		const state = await readRigStateFile(runtime.fs, runtime.home);
		if (!state.ok) return state;
		const environmentFailures: Pair[] = [];
		const ports = makeUpdatePorts(runtime, state.value.paths, pendingOnly, writeLine, environmentFailures);
		const result = pendingOnly ? await runPending(ports) : await runUpdate(ports);
		// The update was rolled back, but the pair is not at fault when the check could not query its environment.
		const forgotten = await forgetBadPairs(runtime, environmentFailures);
		if (!forgotten.ok) return result.ok ? forgotten : err(`${result.error}\n${forgotten.error}`);
		if (!result.ok) return result;
		// The 5-minute pending check stays silent on success: its output goes to update.log, which would grow by a line per run.
		if (pendingOnly) return ok(undefined);
		const trimmed = await trimEvents({
			fs: runtime.fs,
			home: runtime.home,
			now: () => runtime.clock.nowText(),
			createId: () => runtime.ids.next(),
		});
		if (!trimmed.ok) return trimmed;
		writeLine(messagesFor(runtime.language).updateCommand.complete());
		return ok(undefined);
	};
	if (!pendingOnly) return withRigLock(runtime, writeLine, operation);
	// Spec: --pending never waits for the lock. A running rig command already handles the pending restart itself.
	const acquired = await tryAcquireLock(runtime.lock);
	if (!acquired.ok) return acquired;
	if (acquired.value === null) {
		writeLine(messagesFor(runtime.language).updateCommand.checkDeferred());
		return ok(undefined);
	}
	let result: Result<void>;
	try {
		result = await operation();
	} catch (error) {
		result = err(errorText(error));
	}
	const released = await acquired.value.release();
	return released.ok ? result : released;
};

export type UpdateStep = "apply" | "check";

// Runs inside the freshly fetched code, as a child of `rig update`. The parent holds the rig lock, so the child must not take it.
export const runUpdateStep = async (
	runtime: RuntimePorts,
	step: UpdateStep,
	parent: LockOwner,
	writeLine: (line: string) => void,
): Promise<number> => {
	const held = await parentHoldsLock(runtime, parent);
	if (!held.ok) return reportStepError(runtime, held.error, writeLine);
	if (step === "apply") {
		const applied = await applyInstalledPrograms(runtime, writeLine);
		return applied.ok ? UPDATE_STEP_SUCCESS_EXIT_CODE : reportStepError(runtime, applied.error, writeLine);
	}
	const inspection = await inspectRig(runtime);
	if (!inspection.ok) return reportStepError(runtime, inspection.error, writeLine);
	const { problems, environmentProblems } = inspection.value;
	if (problems.length === 0 && environmentProblems.length === 0) return UPDATE_STEP_SUCCESS_EXIT_CODE;
	reportStepError(runtime, [...problems, ...environmentProblems].join("\n"), writeLine);
	return problems.length === 0 ? UPDATE_STEP_ENVIRONMENT_EXIT_CODE : UPDATE_STEP_FAILURE_EXIT_CODE;
};

const reportStepError = (runtime: RuntimePorts, message: string, writeLine: (line: string) => void): number => {
	writeLine(messagesFor(runtime.language).cli.rigError(message));
	return UPDATE_STEP_FAILURE_EXIT_CODE;
};

const parentHoldsLock = async (runtime: RuntimePorts, parent: LockOwner): Promise<Result<void>> => {
	const messages = messagesFor(runtime.language);
	const lockPath = runtime.lock.lockPath ?? joinPath(runtime.home, ".agent-rig", "rig.lock");
	let owner: unknown;
	try {
		owner = JSON.parse(await runtime.fs.readText(lockPath));
	} catch {
		return err(messages.updateCommand.stepLockMissing());
	}
	if (!isObject(owner) || owner.pid !== parent.pid || owner.startTime !== parent.startTime) {
		return err(messages.updateCommand.stepLockOtherProcess());
	}
	const startTime = await runtime.lock.process.ownerStartTime(parent.pid);
	if (!startTime.ok) return startTime;
	if (startTime.value !== parent.startTime) {
		return err(messages.updateCommand.stepParentExited());
	}
	return ok(undefined);
};

const applyInstalledPrograms = async (runtime: RuntimePorts, writeLine: (line: string) => void): Promise<Result<void>> => {
	const state = await readState(runtime);
	if (!state.ok) return state;
	const features = await loadFeatures(runtime.fs, state.value.paths.repo);
	if (!features.ok) return features;
	const enabled = features.value
		.filter((feature) => feature.name === "base" || state.value.features[feature.name] === true)
		.map((feature) => feature.name);
	// Programs that need no root are installed here, so a good update is not rolled back for a missing tool.
	const programs = await installMissingPrograms(runtime, features.value, new Set(enabled));
	if (!programs.ok) return programs;
	for (const missing of programs.value) writeLine(messagesFor(runtime.language).programs.installPackage(missing.name, missing.command));
	const result = await applyRig(runtime, { state: state.value, mode: "apply" });
	return result.ok ? ok(undefined) : result;
};

const runUpdateStepProcess = async (
	runtime: RuntimePorts,
	paths: RigState["paths"],
	step: UpdateStep,
	writeLine: (line: string) => void,
): Promise<StepOutcome> => {
	const { pid, startTime } = runtime.lock.process;
	const launched = await runtime.process.run(
		runtime.executablePath,
		[runtime.resolvePath(paths.repo, "src", "cli.ts"), "update-step", step, String(pid), String(startTime)],
		{ cwd: paths.repo },
	);
	if (!launched.ok) return { ok: false, error: messagesFor(runtime.language).updateCommand.newCodeNotStarted(step, launched.error), exitCode: null };
	const output = [launched.value.stdout, launched.value.stderr].map((text) => text.trim()).filter((text) => text.length > 0).join("\n");
	if (launched.value.exitCode === PROCESS_SUCCESS_EXIT_CODE) {
		for (const line of output.split(/\r?\n/)) if (line.length > 0) writeLine(line);
		return { ok: true };
	}
	return {
		ok: false,
		error: output.length > 0 ? output : messagesFor(runtime.language).updateCommand.newCodeExitCode(step, launched.value.exitCode),
		exitCode: launched.value.exitCode,
	};
};

const forgetBadPairs = async (runtime: RuntimePorts, pairs: readonly Pair[]): Promise<Result<void>> => {
	if (pairs.length === 0) return ok(undefined);
	const state = await readState(runtime);
	if (!state.ok) return state;
	const badPairs = state.value.badPairs.filter((bad) => !pairs.some((pair) => pair.rig === bad.repo && pair.hub === bad.hub));
	return writeRigStateFile(runtime.fs, runtime.home, { ...state.value, badPairs });
};

const makeUpdatePorts = (
	runtime: RuntimePorts,
	paths: RigState["paths"],
	pendingOnly: boolean,
	writeLine: (line: string) => void,
	environmentFailures: Pair[],
): UpdatePorts => ({
	messages: messagesFor(runtime.language),
	git: createRealGitAdapter(runtime.process, paths),
	apply: async () => {
		const update = await readUpdateState(runtime, paths, !pendingOnly);
		if (!update.ok) return update;
		if (update.value.transaction?.phase === "rollback-applying") {
			// Rolling back, the old code in this process is the code that must run.
			const state = await readState(runtime);
			if (!state.ok) return state;
			const result = await applyRig(runtime, { state: state.value, mode: "apply" });
			return result.ok ? ok(undefined) : result;
		}
		const stepped = await runUpdateStepProcess(runtime, paths, "apply", writeLine);
		return stepped.ok ? ok(undefined) : err(stepped.error);
	},
	check: async () => {
		const stepped = await runUpdateStepProcess(runtime, paths, "check", writeLine);
		if (stepped.ok) return ok(undefined);
		if (stepped.exitCode === UPDATE_STEP_ENVIRONMENT_EXIT_CODE) {
			const update = await readUpdateState(runtime, paths, !pendingOnly);
			if (update.ok && update.value.transaction !== null) environmentFailures.push(update.value.transaction.target);
		}
		return err(stepped.error);
	},
	emit: (event) => emitUpdateEvent(runtime, event),
	hasDelivered: (eventId) => isDelivered(runtime, eventId),
	readState: () => readUpdateState(runtime, paths, !pendingOnly),
	writeState: (state) => writeUpdateState(runtime, state),
	readHubFiles: () => readHubSignals(runtime),
	discoverFeatures: async () => {
		const state = await readState(runtime);
		if (!state.ok) return state;
		const features = await loadFeatures(runtime.fs, paths.repo);
		return features.ok ? ok(features.value.filter((feature) => feature.name !== "base").map((feature) => feature.name)) : features;
	},
	service: { restart: () => runtime.service.restart() },
	clock: { now: () => runtime.clock.now() },
});

const readUpdateState = async (runtime: RuntimePorts, paths: RigState["paths"], loadConfirmed: boolean): Promise<Result<UpdateState>> => {
	const rigState = await readState(runtime);
	if (!rigState.ok) return rigState;
	const stored = parseStoredUpdateState(rigState.value.records[UPDATE_STATE_RECORD]);
	if (!stored.ok) return stored;
	const pendingResult = parsePending(rigState.value.pendingHubRestart, messagesFor(runtime.language));
	if (!pendingResult.ok) return pendingResult;
	const pending = pendingResult.value;
	if (stored.value !== null) {
		return ok({
			mode: rigState.value.mode,
			features: rigState.value.features,
			confirmed: stored.value.confirmed,
			badPairs: rigState.value.badPairs.map((pair) => ({ rig: pair.repo, hub: pair.hub })),
			pending,
			transaction: stored.value.transaction,
			lastFailure: stored.value.lastFailure,
			pendingEvent: stored.value.pendingEvent,
		});
	}
	if (!loadConfirmed && pending === null) {
		return ok({
			mode: rigState.value.mode,
			features: rigState.value.features,
			confirmed: { rig: "", hub: "" },
			badPairs: rigState.value.badPairs.map((pair) => ({ rig: pair.repo, hub: pair.hub })),
			pending: null,
			transaction: null,
			lastFailure: null,
			pendingEvent: null,
		});
	}
	const [rigHead, hubHead] = await Promise.all([currentHead(runtime, "rig", paths), currentHead(runtime, "hub", paths)]);
	if (!rigHead.ok) return rigHead;
	if (!hubHead.ok) return hubHead;
	return ok({
		mode: rigState.value.mode,
		features: rigState.value.features,
		confirmed: { rig: rigHead.value, hub: hubHead.value },
		badPairs: rigState.value.badPairs.map((pair) => ({ rig: pair.repo, hub: pair.hub })),
		pending,
		transaction: null,
		lastFailure: null,
		pendingEvent: null,
	});
};

const writeUpdateState = async (runtime: RuntimePorts, updateState: UpdateState): Promise<Result<void>> => {
	const current = await readState(runtime);
	if (!current.ok) return current;
	const records = { ...current.value.records, [UPDATE_STATE_RECORD]: JSON.stringify({
		confirmed: updateState.confirmed,
		transaction: updateState.transaction,
		lastFailure: updateState.lastFailure,
		pendingEvent: updateState.pendingEvent,
	}) };
	const next: RigState = {
		...current.value,
		mode: updateState.mode,
		features: updateState.features,
		badPairs: updateState.badPairs.map((pair) => ({ repo: pair.rig, hub: pair.hub })),
		pendingHubRestart: updateState.pending === null ? null : JSON.stringify(updateState.pending),
		records,
	};
	return writeRigStateFile(runtime.fs, runtime.home, next);
};

const parseStoredUpdateState = (text: string | undefined): Result<PersistedUpdateState | null> => {
	if (text === undefined) return ok(null);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return err("update state record is not valid JSON");
	}
	if (!isObject(value) || !isPair(value.confirmed) || !(value.transaction === null || isTransaction(value.transaction)) || !(value.pendingEvent === undefined || value.pendingEvent === null || isUpdateEvent(value.pendingEvent))) {
		return err("update state record has an invalid shape");
	}
	const lastFailure = typeof value.lastFailure === "string" ? value.lastFailure : null;
	const pendingEvent = isUpdateEvent(value.pendingEvent) ? value.pendingEvent : null;
	return ok({ confirmed: value.confirmed, transaction: value.transaction, lastFailure, pendingEvent });
};

const parsePending = (text: string | null, messages: Messages): Result<PendingRestart | null> => {
	if (text === null) return ok(null);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return err(messages.updateCommand.pendingNotJson());
	}
	return isPending(value) ? ok(value) : err(messages.updateCommand.pendingBadShape());
};

const readHubSignals = async (runtime: RuntimePorts): Promise<Result<HubFiles>> => {
	const [restartingText, readyText] = await Promise.all([
		readOptional(runtime, pathJoin(runtime.home, ".agent-rig", HUB_RESTARTING_FILE)),
		readOptional(runtime, pathJoin(runtime.home, ".agent-rig", HUB_READY_FILE)),
	]);
	if (!restartingText.ok) return restartingText;
	if (!readyText.ok) return readyText;
	const restarting = parseSignal(restartingText.value);
	const ready = parseReadySignal(readyText.value);
	return ok({ restarting, ready });
};

const emitUpdateEvent = async (runtime: RuntimePorts, event: UpdateEvent): Promise<Result<void>> => {
	// The log is not read on this path: a crash after the append is settled by isDelivered on the next run.
	const appended = await appendEvent({
		fs: runtime.fs,
		home: runtime.home,
		now: () => event.time,
		createId: () => event.id,
	}, event);
	return appended.ok ? ok(undefined) : appended;
};

// Called only by resolvePendingEvent after a crash, so the events file is read only on recovery.
const isDelivered = async (runtime: RuntimePorts, eventId: string): Promise<Result<boolean>> => {
	const text = await readOptional(runtime, pathJoin(runtime.home, ".agent-rig", EVENTS_FILE));
	if (!text.ok) return text;
	if (text.value === null) return ok(false);
	return ok(text.value.split("\n").some((line) => isEventWithId(line, eventId)));
};

const isEventWithId = (line: string, eventId: string): boolean => {
	if (line.trim() === "") return false;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return false;
	}
	return isObject(value) && value.id === eventId;
};

const currentHead = (runtime: RuntimePorts, repository: RepositoryName, paths: RigState["paths"]): Promise<Result<string>> => createRealGitAdapter(runtime.process, paths).head(repository);

const readState = async (runtime: RuntimePorts): Promise<Result<RigState>> => {
	return readRigStateFile(runtime.fs, runtime.home);
};

const readOptional = async (runtime: RuntimePorts, path: string): Promise<Result<string | null>> => {
	try {
		return ok(await runtime.fs.readText(path));
	} catch (error) {
		return isNotFound(error) ? ok(null) : err(`Could not read ${path}: ${errorText(error)}`);
	}
};

const parseSignal = (text: string | null): HubFiles["restarting"] => {
	if (text === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	return isObject(value) && typeof value.time === "string" ? { time: value.time } : null;
};

const parseReadySignal = (text: string | null): HubFiles["ready"] => {
	if (text === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	return isObject(value) && typeof value.commit === "string" && typeof value.time === "string"
		? { commit: value.commit, time: value.time }
		: null;
};

const isPair = (value: unknown): value is Pair => isObject(value) && typeof value.rig === "string" && typeof value.hub === "string";

const isPending = (value: unknown): value is PendingRestart => isObject(value) && isPair(value.confirmed) && isPair(value.attempted) &&
	typeof value.hubCommit === "string" && typeof value.startedAt === "string" && typeof value.restartAfter === "string" && typeof value.waitingReported === "boolean";

const isTransaction = (value: unknown): value is UpdateTransaction => isObject(value) && isPair(value.before) && isPair(value.target) &&
	isTransactionPhase(value.phase) && (value.kind === "update" || value.kind === "pending-rollback") &&
	typeof value.failure === "string" && typeof value.failureReported === "boolean" && typeof value.restartService === "boolean" &&
	(value.completion === null || isCompletion(value.completion));

const isTransactionPhase = (value: unknown): value is UpdateTransaction["phase"] => value === "moving" || value === "applying" || value === "checked" ||
	value === "notifying" || value === "rolling-back" || value === "rollback-applying" || value === "rollback-restarting";

const isCompletion = (value: unknown): value is UpdateCompletion => isObject(value) && isPair(value.confirmed) &&
	(value.pending === null || isPending(value.pending)) && isFeatureState(value.features) && Array.isArray(value.events) && value.events.every(isUpdateEvent) &&
	(value.notified === undefined || typeof value.notified === "number");

const isFeatureState = (value: unknown): value is Record<string, boolean> => isObject(value) && Object.values(value).every((enabled) => typeof enabled === "boolean");

const isUpdateEvent = (value: unknown): value is UpdateEvent => isObject(value) && typeof value.id === "string" && typeof value.time === "string" &&
	typeof value.type === "string" && (value.level === "info" || value.level === "warn" || value.level === "error") && typeof value.text === "string";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

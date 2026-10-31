import type { Result } from "../result.js";

const HUB_RESTART_TIMEOUT_MS = 5 * 60 * 1000;
const HUB_WAIT_WARNING_MS = 24 * 60 * 60 * 1000;
const REPOSITORIES = ["rig", "hub"] as const;
// The short form git itself prints.
const SHORT_COMMIT_LENGTH = 7;
const REPOSITORY_TITLES = { rig: "agent-rig", hub: "хаб" } as const;

export type RepositoryName = "rig" | "hub";
export type Pair = { rig: string; hub: string };
export type FeatureState = Record<string, boolean>;
export type HubSignal = { commit: string; time: string } | null;
export type RestartingSignal = { time: string } | null;
export type UpdateEvent = {
  id: string;
  time: string;
  type: string;
  level: "info" | "warn" | "error";
  text: string;
};

export type PendingRestart = {
  confirmed: Pair;
  attempted: Pair;
  hubCommit: string;
  startedAt: string;
  restartAfter: string;
  waitingReported: boolean;
};

export type UpdateCompletion = {
  confirmed: Pair;
  pending: PendingRestart | null;
  features: FeatureState;
  events: UpdateEvent[];
  // How many of the events are already delivered: a crashed run resumes after them instead of repeating them.
  notified?: number;
};

export type TransactionPhase =
  | "moving"
  | "applying"
  | "checked"
  | "notifying"
  | "rolling-back"
  | "rollback-applying"
  | "rollback-restarting";

const shortCommit = (commit: string): string => commit.slice(0, SHORT_COMMIT_LENGTH);

const versionChanges = async (ports: UpdatePorts, before: Pair, target: Pair): Promise<string> => {
  const changes = await Promise.all(REPOSITORIES
    .filter((name) => before[name] !== target[name])
    .map(async (name) => {
      const [oldVersion, newVersion] = await Promise.all([
        ports.git.readVersion(name, before[name]),
        ports.git.readVersion(name, target[name]),
      ]);
      const oldRelease = oldVersion.ok ? oldVersion.value : null;
      const newRelease = newVersion.ok ? newVersion.value : null;
      if (oldRelease !== null && newRelease !== null) {
        if (oldRelease !== newRelease) return `${REPOSITORY_TITLES[name]} ${oldRelease} → ${newRelease}`;
        return `${REPOSITORY_TITLES[name]} ${newRelease} (${shortCommit(before[name])} → ${shortCommit(target[name])})`;
      }
      return `${REPOSITORY_TITLES[name]} ${shortCommit(before[name])} → ${shortCommit(target[name])}`;
    }));
  return changes.join(", ");
};

export type UpdateTransaction = {
  before: Pair;
  target: Pair;
  phase: TransactionPhase;
  kind: "update" | "pending-rollback";
  failure: string;
  failureReported: boolean;
  restartService: boolean;
  completion: UpdateCompletion | null;
};

export type UpdateState = {
  mode: "server" | "dev";
  features: FeatureState;
  confirmed: Pair;
  badPairs: Pair[];
  pending: PendingRestart | null;
  transaction: UpdateTransaction | null;
  // The last failure cause that was reported ("type:reason"); the same cause is not reported again until it clears.
  lastFailure: string | null;
  // The event being appended, saved with the state that goes with it before the append; a run that finds it resolves it first.
  pendingEvent: UpdateEvent | null;
};

export type BranchProblem = "not-on-main" | "local-commits" | null;

export type HubFiles = { restarting: RestartingSignal; ready: HubSignal };

export type UpdatePorts = {
  git: {
    isClean: (repository: RepositoryName) => Promise<Result<boolean>>;
    // The clone must be on branch main with no commits that origin/main lacks.
    branchProblem: (repository: RepositoryName) => Promise<Result<BranchProblem>>;
    fetchMain: (repository: RepositoryName) => Promise<Result<string>>;
    readVersion: (repository: RepositoryName, commit: string) => Promise<Result<string | null>>;
    head: (repository: RepositoryName) => Promise<Result<string>>;
    // The adapter applies the commit to branch main with git merge --ff-only.
    fastForward: (repository: RepositoryName, commit: string) => Promise<Result<void>>;
    // The adapter runs git reset --keep <commit> on branch main.
    resetKeep: (repository: RepositoryName, commit: string) => Promise<Result<void>>;
  };
  apply: () => Promise<Result<void>>;
  check: () => Promise<Result<void>>;
  emit: (event: UpdateEvent) => Promise<Result<void>>;
  // Read only when resolving a pending event after a crash: whether an event with this id is already in the log.
  hasDelivered: (eventId: string) => Promise<Result<boolean>>;
  readState: () => Promise<Result<UpdateState>>;
  writeState: (state: UpdateState) => Promise<Result<void>>;
  readHubFiles: () => Promise<Result<HubFiles>>;
  discoverFeatures: () => Promise<Result<string[]>>;
  service: { restart: () => Promise<Result<void>> };
  clock: { now: () => Date };
};

export async function runUpdate(ports: UpdatePorts): Promise<Result<void>> {
  const loaded = await ports.readState();
  if (!loaded.ok) return loaded;
  if (loaded.value.mode === "dev") return failure("Обновление недоступно в режиме dev.");

  const resolved = await resolvePendingEvent(ports, loaded.value);
  if (!resolved.ok) return resolved;
  let state = resolved.value;
  if (state.transaction !== null) {
    const recovered = await recoverTransaction(ports, state);
    if (!recovered.ok) return recovered;
    const refreshed = await ports.readState();
    if (!refreshed.ok) return refreshed;
    state = refreshed.value;
  }

  const pendingResult = await processPending(ports, state);
  if (!pendingResult.ok) return pendingResult;
  const refreshed = await ports.readState();
  if (!refreshed.ok) return refreshed;
  state = refreshed.value;

  const [rigFetch, hubFetch] = await Promise.all([
    ports.git.fetchMain("rig"),
    ports.git.fetchMain("hub"),
  ]);
  if (!rigFetch.ok) return failWithEvent(ports, state, "update-failed", rigFetch.error, "error", "Не удалось получить main репозитория rig.");
  if (!hubFetch.ok) return failWithEvent(ports, state, "update-failed", hubFetch.error, "error", "Не удалось получить main репозитория hub.");

  const currentResult = await readPair(ports);
  if (!currentResult.ok) return failWithEvent(ports, state, "update-failed", currentResult.error, "error", "Не удалось прочитать версии клонов.");
  const current = currentResult.value;
  const targets: Pair = { rig: rigFetch.value, hub: hubFetch.value };

  if (samePair(current, targets)) {
    if (state.lastFailure === null) return success(undefined);
    // The recovery is announced once, so the failure shown in rig status is closed by an update-ok event.
    const recovered = createEvent(
      ports.clock.now().toISOString(),
      `update-ok:${current.rig}:${current.hub}`,
      "update-ok",
      "info",
      "Обновление снова работает: клоны совпадают с main.",
    );
    const emitted = await emitWithState(ports, { ...state, lastFailure: null }, recovered);
    return emitted.ok ? success(undefined) : emitted;
  }
  if (state.badPairs.some((pair) => samePair(pair, targets))) return success(undefined);

  for (const repository of REPOSITORIES) {
    const problem = await ports.git.branchProblem(repository);
    if (!problem.ok) return failWithEvent(ports, state, "update-failed", problem.error, "error", `Не удалось проверить ветку клона ${repository}.`);
    if (problem.value !== null) {
      const text = problem.value === "not-on-main"
        ? `Обновление пропущено: клон ${repository} не на ветке main.`
        : `Обновление пропущено: в клоне ${repository} есть локальные коммиты, которых нет в origin/main.`;
      return failWithEvent(ports, state, "update-skipped", `${repository}:${problem.value}`, "warn", text, false);
    }
  }

  const [rigClean, hubClean] = await Promise.all([
    ports.git.isClean("rig"),
    ports.git.isClean("hub"),
  ]);
  if (!rigClean.ok) return failWithEvent(ports, state, "update-failed", rigClean.error, "error", "Не удалось проверить локальные изменения в rig.");
  if (!hubClean.ok) return failWithEvent(ports, state, "update-failed", hubClean.error, "error", "Не удалось проверить локальные изменения в hub.");
  if (!rigClean.value || !hubClean.value) {
    return failWithEvent(ports, state, "update-skipped", "dirty-clone", "warn", "Обновление пропущено: в одном из клонов есть локальные изменения.", false);
  }

  const transaction: UpdateTransaction = {
    before: current,
    target: targets,
    phase: "moving",
    kind: "update",
    failure: "",
    failureReported: false,
    restartService: false,
    completion: null,
  };
  const saved = await ports.writeState({ ...state, transaction });
  if (!saved.ok) return saved;
  return advanceTransaction(ports, { ...state, transaction });
}

export async function runPending(ports: UpdatePorts): Promise<Result<void>> {
  const loaded = await ports.readState();
  if (!loaded.ok) return loaded;
  if (loaded.value.pending === null && loaded.value.transaction === null && loaded.value.pendingEvent === null) return success(undefined);
  if (loaded.value.mode === "dev") return failure("Проверка ожидающего перезапуска недоступна в режиме dev.");

  const resolved = await resolvePendingEvent(ports, loaded.value);
  if (!resolved.ok) return resolved;
  let state = resolved.value;
  if (state.transaction !== null) {
    const recovered = await recoverTransaction(ports, state);
    if (!recovered.ok) return recovered;
    const refreshed = await ports.readState();
    if (!refreshed.ok) return refreshed;
    state = refreshed.value;
  }

  return processPending(ports, state);
}

async function processPending(ports: UpdatePorts, state: UpdateState): Promise<Result<void>> {
  const pending = state.pending;
  if (pending === null) return success(undefined);
  if (state.features.telegram !== true) {
    const saved = await ports.writeState({ ...state, confirmed: pending.attempted, pending: null });
    return saved.ok ? success(undefined) : saved;
  }

  const filesResult = await ports.readHubFiles();
  if (!filesResult.ok) return failWithEvent(ports, state, "update-failed", filesResult.error, "error", "Не удалось проверить состояние перезапуска хаба.");
  const { restarting, ready } = filesResult.value;
  if (matchesCurrentReadySignal(ready, pending)) {
    const saved = await ports.writeState({ ...state, confirmed: pending.attempted, pending: null });
    return saved.ok ? success(undefined) : saved;
  }

  const now = ports.clock.now().getTime();
  if (matchesCurrentRestartingSignal(restarting, pending)) {
    // The deadline counts from the restart signal: a newer hub commit during the wait must not postpone it.
    const restartingAt = Date.parse(restarting.time);
    if (now - restartingAt >= HUB_RESTART_TIMEOUT_MS) {
      const transaction: UpdateTransaction = {
        before: pending.confirmed,
        target: pending.attempted,
        phase: "rolling-back",
        kind: "pending-rollback",
        failure: "Хаб не сообщил о готовности за 5 минут после начала перезапуска.",
        failureReported: false,
        restartService: true,
        completion: null,
      };
      const saved = await ports.writeState({
        ...state,
        badPairs: addBadPair(state.badPairs, pending.attempted),
        transaction,
      });
      if (!saved.ok) return saved;
      return continueRollback(ports, { ...state, badPairs: addBadPair(state.badPairs, pending.attempted), transaction });
    }
  }

  if (!pending.waitingReported && isAtLeast(now, pending.startedAt, HUB_WAIT_WARNING_MS)) {
    const updatedPending = { ...pending, waitingReported: true };
    const event = createEvent(
      ports.clock.now().toISOString(),
      `hub-restart-waiting:${pending.hubCommit}:${pending.restartAfter}`,
      "hub-restart-waiting",
      "warn",
      "Перезапуск хаба ждёт безопасного момента уже больше суток.",
    );
    const emitted = await emitWithState(ports, { ...state, pending: updatedPending }, event);
    return emitted.ok ? success(undefined) : emitted;
  }
  return success(undefined);
}

// Runs first in every run. The events file is read only here, and only when a pending event exists:
// an append that the crash cut off is sent now, one that landed is not sent again.
async function resolvePendingEvent(ports: UpdatePorts, state: UpdateState): Promise<Result<UpdateState>> {
  const event = state.pendingEvent;
  if (event === null) return success(state);
  const delivered = await ports.hasDelivered(event.id);
  if (!delivered.ok) return delivered;
  if (!delivered.value) {
    const emitted = await ports.emit(event);
    if (!emitted.ok) return emitted;
  }
  const cleared: UpdateState = { ...state, pendingEvent: null };
  const saved = await ports.writeState(cleared);
  return saved.ok ? success(cleared) : saved;
}

// The event is saved as pending together with the state that goes with it, before the append. A crash at any later
// point leaves the pending event for resolvePendingEvent, so the event reaches the log exactly once.
async function emitWithState(ports: UpdatePorts, next: UpdateState, event: UpdateEvent): Promise<Result<UpdateState>> {
  const intent = await ports.writeState({ ...next, pendingEvent: event });
  if (!intent.ok) return intent;
  const emitted = await ports.emit(event);
  if (!emitted.ok) return emitted;
  const cleared: UpdateState = { ...next, pendingEvent: null };
  const saved = await ports.writeState(cleared);
  return saved.ok ? success(cleared) : saved;
}

async function recoverTransaction(ports: UpdatePorts, state: UpdateState): Promise<Result<void>> {
  const transaction = state.transaction;
  if (transaction === null) return success(undefined);
  if (transaction.phase === "notifying") return finishNotifications(ports, state, transaction);
  if (transaction.phase === "checked") return completeSuccessfulUpdate(ports, state, transaction);
  if (transaction.phase === "rolling-back" || transaction.phase === "rollback-applying" || transaction.phase === "rollback-restarting") {
    return continueRollback(ports, state);
  }
  return advanceTransaction(ports, state);
}

async function advanceTransaction(ports: UpdatePorts, state: UpdateState): Promise<Result<void>> {
  const transaction = state.transaction;
  if (transaction === null) return failure("Нет активной транзакции обновления.");

  for (const repository of REPOSITORIES) {
    const moved = await ports.git.fastForward(repository, transaction.target[repository]);
    if (!moved.ok) return startRollback(ports, state, `Не удалось перемотать ${repository}: ${moved.error}`);
  }

  const applyingTransaction: UpdateTransaction = { ...transaction, phase: "applying" };
  const applyingState: UpdateState = { ...state, transaction: applyingTransaction };
  const applyingSaved = await ports.writeState(applyingState);
  if (!applyingSaved.ok) return applyingSaved;

  const applied = await ports.apply();
  if (!applied.ok) return startRollback(ports, applyingState, `rig apply завершился с ошибкой: ${applied.error}`);
  const checked = await ports.check();
  if (!checked.ok) return startRollback(ports, applyingState, `rig check завершился с ошибкой: ${checked.error}`);

  const checkedTransaction: UpdateTransaction = { ...applyingTransaction, phase: "checked" };
  const checkedState: UpdateState = { ...applyingState, transaction: checkedTransaction };
  const checkedSaved = await ports.writeState(checkedState);
  if (!checkedSaved.ok) return checkedSaved;
  return completeSuccessfulUpdate(ports, checkedState, checkedTransaction);
}

async function completeSuccessfulUpdate(
  ports: UpdatePorts,
  state: UpdateState,
  transaction: UpdateTransaction,
): Promise<Result<void>> {
  const discovered = await ports.discoverFeatures();
  if (!discovered.ok) return failWithEvent(ports, state, "update-failed", discovered.error, "error", "Не удалось загрузить список фич.");

  const features = { ...state.features };
  const featureEvents: UpdateEvent[] = [];
  const names = [...new Set(discovered.value)].sort();
  const eventTime = ports.clock.now().toISOString();
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(features, name)) continue;
    features[name] = false;
    featureEvents.push(createEvent(
      eventTime,
      `feature-new:${transaction.target.rig}:${transaction.target.hub}:${name}`,
      "feature-new",
      "info",
      `Новая фича «${name}» выключена. Включить: rig feature ${name} enable`,
    ));
  }

  const pendingResult = nextPending(state, transaction, eventTime);
  const events = [
    createEvent(
      eventTime,
      `update-ok:${transaction.target.rig}:${transaction.target.hub}`,
      "update-ok",
      "info",
      `Обновлено: ${await versionChanges(ports, transaction.before, transaction.target)}.`,
    ),
    ...(pendingResult.event === null ? [] : [pendingResult.event]),
    ...featureEvents,
  ];
  const completion: UpdateCompletion = {
    confirmed: pendingResult.confirmed,
    pending: pendingResult.pending,
    features,
    events,
  };
  const notifyingTransaction: UpdateTransaction = { ...transaction, phase: "notifying", completion };
  const saved = await ports.writeState({ ...state, transaction: notifyingTransaction });
  if (!saved.ok) return saved;
  return finishNotifications(ports, { ...state, transaction: notifyingTransaction }, notifyingTransaction);
}

function nextPending(
  state: UpdateState,
  transaction: UpdateTransaction,
  now: string,
): { confirmed: Pair; pending: PendingRestart | null; event: UpdateEvent | null } {
  const telegramEnabled = state.features.telegram === true;
  const previous = state.pending;
  if (!telegramEnabled) return { confirmed: transaction.target, pending: null, event: null };

  if (transaction.target.hub !== transaction.before.hub) {
    const pending: PendingRestart = {
      confirmed: previous?.confirmed ?? state.confirmed,
      attempted: transaction.target,
      hubCommit: transaction.target.hub,
      startedAt: previous?.startedAt ?? now,
      restartAfter: now,
      waitingReported: previous?.waitingReported ?? false,
    };
    const changedExpectedCommit = previous === null || previous.hubCommit !== pending.hubCommit;
    return {
      confirmed: pending.confirmed,
      pending,
      event: changedExpectedCommit
        ? createEvent(
          now,
          `hub-restart-pending:${pending.hubCommit}:${pending.restartAfter}`,
          "hub-restart-pending",
          "info",
          "Хаб должен перезапуститься после завершения текущих сессий.",
        )
        : null,
    };
  }

  if (previous !== null) {
    return { confirmed: previous.confirmed, pending: { ...previous, attempted: transaction.target }, event: null };
  }
  return { confirmed: transaction.target, pending: null, event: null };
}

async function finishNotifications(
  ports: UpdatePorts,
  state: UpdateState,
  transaction: UpdateTransaction,
): Promise<Result<void>> {
  const completion = transaction.completion;
  if (completion === null) return failure("У транзакции отсутствуют данные завершения.");
  let current = state;
  for (let index = completion.notified ?? 0; index < completion.events.length; index += 1) {
    const event = completion.events[index];
    if (event === undefined) break;
    const progress: UpdateTransaction = { ...transaction, completion: { ...completion, notified: index + 1 } };
    const emitted = await emitWithState(ports, { ...current, transaction: progress }, event);
    if (!emitted.ok) return emitted;
    current = emitted.value;
  }
  const saved = await ports.writeState({
    ...current,
    confirmed: completion.confirmed,
    pending: completion.pending,
    features: completion.features,
    transaction: null,
    lastFailure: null,
  });
  return saved.ok ? success(undefined) : saved;
}

async function startRollback(ports: UpdatePorts, state: UpdateState, reason: string): Promise<Result<void>> {
  const transaction = state.transaction;
  if (transaction === null) return failure(reason);
  const rollingBack: UpdateTransaction = {
    ...transaction,
    phase: "rolling-back",
    failure: reason,
    failureReported: false,
    completion: null,
  };
  const nextState = {
    ...state,
    badPairs: addBadPair(state.badPairs, transaction.target),
    transaction: rollingBack,
  };
  const saved = await ports.writeState(nextState);
  if (!saved.ok) return saved;
  return continueRollback(ports, nextState);
}

async function continueRollback(ports: UpdatePorts, state: UpdateState): Promise<Result<void>> {
  const transaction = state.transaction;
  if (transaction === null) return failure("Нет активного отката.");

  if (transaction.phase === "rolling-back") {
    let resetFailure = "";
    for (const repository of REPOSITORIES) {
      const reset = await ports.git.resetKeep(repository, transaction.before[repository]);
      if (!reset.ok && resetFailure === "") resetFailure = `${repository}: ${reset.error}`;
    }
    if (resetFailure !== "") {
      const reported = await reportRollbackFailure(ports, state, `Не удалось выполнить git reset --keep: ${resetFailure}`);
      return reported.ok ? failure(resetFailure) : reported;
    }
    const applying: UpdateTransaction = { ...transaction, phase: "rollback-applying" };
    const applyingState = { ...state, transaction: applying };
    const saved = await ports.writeState(applyingState);
    if (!saved.ok) return saved;
    return continueRollback(ports, applyingState);
  }

  if (transaction.phase === "rollback-applying") {
    const applied = await ports.apply();
    if (!applied.ok) {
      const reported = await reportRollbackFailure(ports, state, `Повторный rig apply при откате завершился с ошибкой: ${applied.error}`);
      return reported.ok ? failure(applied.error) : reported;
    }
    if (transaction.restartService) {
      const restarting: UpdateTransaction = { ...transaction, phase: "rollback-restarting" };
      const restartingState = { ...state, transaction: restarting };
      const saved = await ports.writeState(restartingState);
      if (!saved.ok) return saved;
      return continueRollback(ports, restartingState);
    }
    return finishRollback(ports, state, transaction);
  }

  if (transaction.phase === "rollback-restarting") {
    const restarted = await ports.service.restart();
    if (!restarted.ok) {
      const reported = await reportRollbackFailure(ports, state, `Не удалось перезапустить службу хаба после отката: ${restarted.error}`);
      return reported.ok ? failure(restarted.error) : reported;
    }
    return finishRollback(ports, state, transaction);
  }

  return failure("Транзакция не находится в состоянии отката.");
}

async function reportRollbackFailure(ports: UpdatePorts, state: UpdateState, detail: string): Promise<Result<void>> {
  const transaction = state.transaction;
  if (transaction === null) return failure(detail);
  if (transaction.failureReported) return success(undefined);
  const updatedTransaction = { ...transaction, failureReported: true };
  const emitted = await emitWithState(ports, { ...state, transaction: updatedTransaction }, createEvent(
    ports.clock.now().toISOString(),
    `update-failed:${transaction.target.rig}:${transaction.target.hub}:${transaction.failure}`,
    "update-failed",
    "error",
    `${transaction.failure} ${detail}`,
  ));
  return emitted.ok ? success(undefined) : emitted;
}

async function finishRollback(
  ports: UpdatePorts,
  state: UpdateState,
  transaction: UpdateTransaction,
): Promise<Result<void>> {
  let current = state;
  if (!transaction.failureReported) {
    const updatedTransaction = { ...transaction, failureReported: true };
    const emitted = await emitWithState(ports, { ...state, transaction: updatedTransaction }, createEvent(
      ports.clock.now().toISOString(),
      `update-failed:${transaction.target.rig}:${transaction.target.hub}:${transaction.failure}`,
      "update-failed",
      "error",
      `${transaction.failure} Клоны возвращены к подтверждённым версиям.`,
    ));
    if (!emitted.ok) return emitted;
    current = emitted.value;
  }
  const finished: UpdateState = {
    ...current,
    confirmed: transaction.before,
    pending: transaction.kind === "pending-rollback" ? null : current.pending,
    transaction: null,
  };
  const rollbackEmitted = await emitWithState(ports, finished, createEvent(
    ports.clock.now().toISOString(),
    `rollback:${transaction.target.rig}:${transaction.target.hub}`,
    "rollback",
    "warn",
    "Клоны возвращены к подтверждённым версиям.",
  ));
  return rollbackEmitted.ok ? failure(transaction.failure) : rollbackEmitted;
}

async function readPair(ports: UpdatePorts): Promise<Result<Pair>> {
  const [rigHead, hubHead] = await Promise.all([ports.git.head("rig"), ports.git.head("hub")]);
  if (!rigHead.ok) return failure(rigHead.error);
  if (!hubHead.ok) return failure(hubHead.error);
  return success({ rig: rigHead.value, hub: hubHead.value });
}

function matchesCurrentReadySignal(signal: HubSignal, pending: PendingRestart): signal is { commit: string; time: string } {
  return signal !== null
    && signal.commit === pending.hubCommit
    && isValidTimestampAtOrAfter(signal.time, pending.restartAfter);
}

function matchesCurrentRestartingSignal(signal: RestartingSignal, pending: PendingRestart): signal is { time: string } {
  return signal !== null
    && isValidTimestampAtOrAfter(signal.time, pending.startedAt);
}

function isValidTimestampAtOrAfter(timestamp: string, boundary: string): boolean {
  const time = Date.parse(timestamp);
  const lowerBound = Date.parse(boundary);
  return Number.isFinite(time) && Number.isFinite(lowerBound) && time >= lowerBound;
}

function isAtLeast(now: number, startedAt: string, duration: number): boolean {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) && now - start >= duration;
}

// Only the pair currently at origin/main can be retried, so older failed pairs carry no information.
function addBadPair(_pairs: Pair[], attempted: Pair): Pair[] {
  return [attempted];
}

function samePair(left: Pair, right: Pair): boolean {
  return left.rig === right.rig && left.hub === right.hub;
}

// The base id is stable for one event; the time makes it unique in the log, so a recovery lookup never matches an older event.
function createEvent(time: string, baseId: string, type: string, level: UpdateEvent["level"], text: string): UpdateEvent {
  return { id: `${baseId}@${time}`, time, type, level, text };
}

async function failWithEvent(
  ports: UpdatePorts,
  state: UpdateState,
  type: string,
  reason: string,
  level: UpdateEvent["level"],
  text: string,
  failed = true,
): Promise<Result<void>> {
  const outcome: Result<void> = failed ? failure(reason) : success(undefined);
  const cause = `${type}:${reason}`;
  if (state.lastFailure === cause) return outcome;
  const time = ports.clock.now().toISOString();
  const emitted = await emitWithState(ports, { ...state, lastFailure: cause }, createEvent(time, `${type}:${reason}`, type, level, text));
  return emitted.ok ? outcome : emitted;
}

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

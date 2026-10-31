import type { Result } from "../../src/result";
import type { CronEntries } from "../../src/update/cron";
import type {
  HubFiles,
  Pair,
  PendingRestart,
  RepositoryName,
  UpdateEvent,
  UpdatePorts,
  UpdateState,
  UpdateTransaction,
} from "../../src/update/update";

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCronEntries, mergeCronEntries } from "../../src/update/cron";
import { runPending, runUpdate } from "../../src/update/update";

const REPOSITORIES: RepositoryName[] = ["rig", "hub"];
const INITIAL_TIME = "2026-10-30T00:00:00.000Z";
const TEST_USER_NAME = "Update Test";
const TEST_USER_EMAIL = "update-test@example.com";
const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const TEN_MINUTES_MS = 10 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * 60 * ONE_MINUTE_MS;
// Tests spawn real git: the slowest takes 2.6 s on an idle Windows machine and went over bun's 5 s default while
// Docker scenarios ran beside it. The budget bounds a hung test, it does not wait.
const GIT_TEST_TIMEOUT_MS = 30_000;

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);

type Fixture = {
  root: string;
  working: Record<RepositoryName, string>;
  publisher: Record<RepositoryName, string>;
  origin: Record<RepositoryName, string>;
};

// Built once per file: every test copies this template instead of running git setup again.
// Remotes are relative (../rig.git) so a copy keeps working under its own root.
const template = await buildTemplate();

afterAll(async () => {
  await rm(template.root, { recursive: true, force: true });
});

type HarnessOptions = {
  mode?: "server" | "dev";
  telegram?: boolean;
  featureNames?: string[];
  failFetch?: RepositoryName;
  failReset?: RepositoryName;
  applyResults?: Result<void>[];
  checkResult?: Result<void>;
  discoverResult?: Result<string[]>;
  restartResult?: Result<void>;
};

type Harness = {
  ports: UpdatePorts;
  events: UpdateEvent[];
  calls: string[];
  get state(): UpdateState;
  get applyCount(): number;
  get restartCount(): number;
  setNow: (value: string) => void;
  setState: (state: UpdateState) => void;
  setHubFiles: (files: HubFiles) => void;
  setFailReset: (repository: RepositoryName | null) => void;
  setCheckResult: (result: Result<void>) => void;
};

describe("runUpdate", () => {
  let root: string | null = null;
  let working: Record<RepositoryName, string> = { rig: "", hub: "" };
  let publisher: Record<RepositoryName, string> = { rig: "", hub: "" };
  let origin: Record<RepositoryName, string> = { rig: "", hub: "" };

  beforeEach(async () => {
    const fixture = await openFixture("rig-update-");
    root = fixture.root;
    working = fixture.working;
    publisher = fixture.publisher;
    origin = fixture.origin;
  });

  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
  });

  test("fetches main and fast-forwards both main branches before apply and check", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const harness = makeHarness(working, publisher, origin);

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(git(working.rig, "branch", "--show-current")).toBe("main");
    expect(git(working.hub, "branch", "--show-current")).toBe("main");
    expect(git(working.rig, "rev-parse", "HEAD")).toBe(git(publisher.rig, "rev-parse", "HEAD"));
    expect(git(working.hub, "rev-parse", "HEAD")).toBe(git(publisher.hub, "rev-parse", "HEAD"));
    expect(harness.calls.indexOf("apply")).toBeGreaterThan(harness.calls.indexOf("ff:hub"));
    expect(harness.calls.indexOf("check")).toBeGreaterThan(harness.calls.indexOf("apply"));
    expect(harness.events.map((event) => event.type)).toContain("update-ok");
    const updateEvent = harness.events.find((event) => event.type === "update-ok");
    expect(updateEvent).toBeDefined();
    if (updateEvent !== undefined) {
      expect(updateEvent.id.length).toBeGreaterThan(0);
      expect(updateEvent.time).toBe(INITIAL_TIME);
    }
  });

  test("a dirty rig clone skips the whole pair and emits update-skipped", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    await writeFile(join(working.rig, "version.txt"), "local rig edit");
    const harness = makeHarness(working, publisher, origin);
    const before = await pairAt(working);

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(await pairAt(working)).toEqual(before);
    expect(harness.applyCount).toBe(0);
    expect(harness.events.map((event) => event.type)).toEqual(["update-skipped"]);
  });

  test("a dirty hub clone skips the whole pair too", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    await writeFile(join(working.hub, "version.txt"), "local hub edit");
    const harness = makeHarness(working, publisher, origin);
    const before = await pairAt(working);

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(await pairAt(working)).toEqual(before);
    expect(harness.applyCount).toBe(0);
    expect(harness.events.map((event) => event.type)).toEqual(["update-skipped"]);
  });

  test("no new commits leave state, apply, and events untouched", async () => {
    const harness = makeHarness(working, publisher, origin);
    const initialState = harness.state;

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state).toEqual(initialState);
    expect(harness.applyCount).toBe(0);
    expect(harness.events).toEqual([]);
  });

  test("records exactly a failed pair, ignores its repeat, and tries each pair above it once", async () => {
    await addUpstreamCommit(publisher.rig, "broken rig");
    await addUpstreamCommit(publisher.hub, "broken hub");
    const broken = await pairAt(publisher);
    const harness = makeHarness(working, publisher, origin, {
      checkResult: errorResult("bad check"),
    });

    const failed = await runUpdate(harness.ports);
    const eventCount = harness.events.length;
    const applyCount = harness.applyCount;
    const repeated = await runUpdate(harness.ports);

    expect(failed.ok).toBe(false);
    expect(repeated.ok).toBe(true);
    expect(harness.state.badPairs).toEqual([broken]);
    expect(harness.events).toHaveLength(eventCount);
    expect(harness.applyCount).toBe(applyCount);
    expect(await pairAt(working)).toEqual(harness.state.confirmed);

    await addUpstreamCommit(publisher.rig, "fix above broken rig");
    const fixedPair = await pairAt(publisher);
    harness.setCheckResult(ok(undefined));
    const fixed = await runUpdate(harness.ports);
    const fixedApplyCount = harness.applyCount;
    const fixedEventCount = harness.events.length;
    await runUpdate(harness.ports);

    expect(fixed.ok).toBe(true);
    expect(fixedPair).not.toEqual(broken);
    expect(harness.state.badPairs).toEqual([broken]);
    expect(await pairAt(working)).toEqual(fixedPair);
    expect(harness.applyCount).toBe(fixedApplyCount);
    expect(harness.events).toHaveLength(fixedEventCount);
  });

  test("fetch failure on rig emits update-failed and moves neither clone", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const harness = makeHarness(working, publisher, origin, { failFetch: "rig" });
    const before = await pairAt(working);

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(false);
    expect(await pairAt(working)).toEqual(before);
    expect(harness.events.map((event) => event.type)).toEqual(["update-failed"]);
  });

  test("fetch failure on hub emits update-failed and moves neither clone", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const harness = makeHarness(working, publisher, origin, { failFetch: "hub" });
    const before = await pairAt(working);

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(false);
    expect(await pairAt(working)).toEqual(before);
    expect(harness.events.map((event) => event.type)).toEqual(["update-failed"]);
  });

  test("apply failure rolls back both clones and emits update-failed", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const before = await pairAt(working);
    const harness = makeHarness(working, publisher, origin, {
      applyResults: [errorResult("apply failed"), ok(undefined)],
    });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(false);
    expect(await pairAt(working)).toEqual(before);
    expect(harness.state.badPairs).toEqual([await pairAt(publisher)]);
    expect(harness.events.map((event) => event.type)).toContain("update-failed");
  });

  test("a check failure rolls both repositories back and retries the failed pair only once", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const before = await pairAt(working);
    const attempted = await pairAt(publisher);
    const harness = makeHarness(working, publisher, origin, {
      checkResult: errorResult("check failed"),
    });

    const result = await runUpdate(harness.ports);
    const eventCount = harness.events.length;
    const repeated = await runUpdate(harness.ports);

    expect(result.ok).toBe(false);
    expect(repeated.ok).toBe(true);
    expect(await pairAt(working)).toEqual(before);
    expect(harness.state.badPairs).toEqual([attempted]);
    expect(harness.events).toHaveLength(eventCount);
  });

  test("a refused reset --keep reports an error and records the attempted pair as bad", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const attempted = await pairAt(publisher);
    const harness = makeHarness(working, publisher, origin, {
      checkResult: errorResult("check failed"),
    });
    harness.setFailReset("rig");

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(false);
    expect(harness.state.badPairs).toEqual([attempted]);
    expect(harness.state.transaction?.phase).toBe("rolling-back");
    const lastEvent = harness.events[harness.events.length - 1];
    expect(lastEvent?.type).toBe("update-failed");
    expect(lastEvent?.level).toBe("error");
  });

  test("a failed apply during rollback remains recoverable and keeps the pair bad", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const attempted = await pairAt(publisher);
    const harness = makeHarness(working, publisher, origin, {
      applyResults: [errorResult("new apply failed"), errorResult("rollback apply failed"), ok(undefined)],
    });

    const first = await runUpdate(harness.ports);
    expect(first.ok).toBe(false);
    expect(harness.state.transaction?.phase).toBe("rollback-applying");
    expect(harness.state.badPairs).toEqual([attempted]);

    const recovered = await runUpdate(harness.ports);
    const repeated = await runUpdate(harness.ports);

    expect(recovered.ok).toBe(false);
    expect(repeated.ok).toBe(true);
    expect(harness.state.transaction).toBe(null);
    expect(harness.state.badPairs).toEqual([attempted]);
    expect(await pairAt(working)).toEqual(harness.state.confirmed);
  });

  test("a transaction after moving only rig resumes the missing fast-forward", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const before = await pairAt(working);
    const target = await pairAt(publisher);
    fetchTargets(working);
    const harness = makeHarness(working, publisher, origin);
    git(working.rig, "merge", "--ff-only", target.rig);
    harness.setState({ ...harness.state, transaction: makeTransaction(before, target, "moving") });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(await pairAt(working)).toEqual(target);
    expect(harness.state.transaction).toBe(null);
    expect(harness.applyCount).toBe(1);
  });

  test("a transaction after both moves but before apply resumes apply and check", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const before = await pairAt(working);
    const target = await pairAt(publisher);
    fetchTargets(working);
    const harness = makeHarness(working, publisher, origin);
    git(working.rig, "merge", "--ff-only", target.rig);
    git(working.hub, "merge", "--ff-only", target.hub);
    harness.setState({ ...harness.state, transaction: makeTransaction(before, target, "applying") });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.calls).toContain("apply");
    expect(harness.calls).toContain("check");
    expect(await pairAt(working)).toEqual(target);
    expect(harness.state.transaction).toBe(null);
  });

  test("a checked transaction completes without rerunning apply or check", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const before = await pairAt(working);
    const target = await pairAt(publisher);
    fetchTargets(working);
    const harness = makeHarness(working, publisher, origin);
    git(working.rig, "merge", "--ff-only", target.rig);
    git(working.hub, "merge", "--ff-only", target.hub);
    harness.setState({ ...harness.state, transaction: makeTransaction(before, target, "checked") });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.applyCount).toBe(0);
    expect(harness.calls).not.toContain("check");
    expect(harness.state.transaction).toBe(null);
    expect(harness.state.pending?.attempted).toEqual(target);
  });

  test("dev mode refuses without fetching", async () => {
    const harness = makeHarness(working, publisher, origin, { mode: "dev" });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(false);
    expect(harness.calls).toEqual(["readState"]);
    expect(harness.events).toEqual([]);

    harness.setState({
      ...harness.state,
      pending: {
        confirmed: harness.state.confirmed,
        attempted: harness.state.confirmed,
        hubCommit: harness.state.confirmed.hub,
        startedAt: INITIAL_TIME,
        restartAfter: INITIAL_TIME,
        waitingReported: false,
      },
    });
    harness.calls.length = 0;
    const pendingResult = await runPending(harness.ports);

    expect(pendingResult.ok).toBe(false);
    expect(harness.calls).toEqual(["readState"]);
  });
});

describe("pending hub restart", () => {
  let root: string | null = null;
  let working: Record<RepositoryName, string> = { rig: "", hub: "" };
  let publisher: Record<RepositoryName, string> = { rig: "", hub: "" };
  let origin: Record<RepositoryName, string> = { rig: "", hub: "" };

  beforeEach(async () => {
    const fixture = await openFixture("rig-pending-");
    root = fixture.root;
    working = fixture.working;
    publisher = fixture.publisher;
    origin = fixture.origin;
  });

  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
  });

  test("runPending with no pending record exits after reading state", async () => {
    const harness = makeHarness(working, publisher, origin);

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.calls).toEqual(["readState"]);
    expect(harness.events).toEqual([]);
  });

  test("a ready signal for the current commit and time confirms the attempted pair", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setHubFiles({
      restarting: { time: pending.restartAfter },
      ready: { commit: pending.hubCommit, time: addMilliseconds(pending.restartAfter, ONE_SECOND_MS) },
    });

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.pending).toBe(null);
    expect(harness.state.confirmed).toEqual(pending.attempted);
  });

  test("a stale restarting or ready file cannot satisfy the current pending restart", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setHubFiles({
      restarting: { time: addMilliseconds(pending.restartAfter, -ONE_MINUTE_MS) },
      ready: { commit: pending.hubCommit, time: addMilliseconds(pending.restartAfter, -ONE_SECOND_MS) },
    });
    harness.setNow(addMilliseconds(pending.restartAfter, TEN_MINUTES_MS));

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.pending).not.toBe(null);
    expect(harness.state.confirmed).toEqual(pending.confirmed);
    expect(await pairAt(working)).toEqual(pending.attempted);
    expect(harness.restartCount).toBe(0);
  });

  test("a restarting signal from before restartAfter and a wrong ready commit are ignored", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setHubFiles({
      restarting: { time: addMilliseconds(pending.restartAfter, -ONE_SECOND_MS) },
      ready: { commit: "other-hub-commit", time: addMilliseconds(pending.restartAfter, ONE_MINUTE_MS) },
    });
    harness.setNow(addMilliseconds(pending.restartAfter, TEN_MINUTES_MS));

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.pending).not.toBe(null);
    expect(harness.state.confirmed).toEqual(pending.confirmed);
    expect(harness.restartCount).toBe(0);
  });

  test("a ready signal with an old commit does not clear the pending restart", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setHubFiles({
      restarting: null,
      ready: { commit: "older-hub-commit", time: addMilliseconds(pending.restartAfter, ONE_MINUTE_MS) },
    });

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.pending).not.toBe(null);
    expect(harness.state.confirmed).toEqual(pending.confirmed);
    expect(harness.restartCount).toBe(0);
  });

  test("five minutes after a current restarting signal rolls back to the confirmed pair and restarts service", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setHubFiles({
      restarting: { time: pending.restartAfter },
      ready: null,
    });
    harness.setNow(addMilliseconds(pending.restartAfter, FIVE_MINUTES_MS));

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(false);
    expect(await pairAt(working)).toEqual(pending.confirmed);
    expect(harness.state.confirmed).toEqual(pending.confirmed);
    expect(harness.state.pending).toBe(null);
    expect(harness.state.badPairs).toEqual([pending.attempted]);
    expect(harness.restartCount).toBe(1);
  });

  test("git reset --keep preserves fresh edits made after the clean update check", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    await writeFile(join(working.rig, "personal.txt"), "fresh local edit");
    harness.setHubFiles({
      restarting: { time: pending.restartAfter },
      ready: null,
    });
    harness.setNow(addMilliseconds(pending.restartAfter, FIVE_MINUTES_MS));

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(false);
    expect(await readFile(join(working.rig, "personal.txt"), "utf8")).toBe("fresh local edit");
    expect(await pairAt(working)).toEqual(pending.confirmed);
    expect(harness.state.badPairs).toEqual([pending.attempted]);
    expect(harness.restartCount).toBe(1);
  });

  test("a refused pending reset emits update-failed at error level and retains the bad pair", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    await writeFile(join(working.hub, "version.txt"), "conflicting local edit");
    harness.setHubFiles({
      restarting: { time: pending.restartAfter },
      ready: null,
    });
    harness.setNow(addMilliseconds(pending.restartAfter, FIVE_MINUTES_MS));

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(false);
    expect(harness.state.badPairs).toEqual([pending.attempted]);
    expect(harness.state.transaction?.phase).toBe("rolling-back");
    const lastEvent = harness.events[harness.events.length - 1];
    expect(lastEvent?.type).toBe("update-failed");
    expect(lastEvent?.level).toBe("error");
  });

  test("updates during a pending restart retain the last confirmed pair", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const originalPending = requirePending(harness.state);
    await addUpstreamCommit(publisher.rig, "rig next while pending");
    await addUpstreamCommit(publisher.hub, "hub next while pending");
    harness.setNow(addMilliseconds(originalPending.startedAt, ONE_MINUTE_MS));

    const result = await runUpdate(harness.ports);
    const pending = requirePending(harness.state);

    expect(result.ok).toBe(true);
    expect(pending.confirmed).toEqual(originalPending.confirmed);
    expect(pending.attempted).toEqual(await pairAt(publisher));
    expect(pending.hubCommit).toBe(pending.attempted.hub);
    expect(pending.startedAt).toBe(originalPending.startedAt);
    expect(pending.restartAfter).not.toBe(originalPending.restartAfter);
    expect(harness.state.confirmed).toEqual(originalPending.confirmed);
  });

  test("a pending rollback targets the last confirmed pair and records the last attempted pair bad", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const firstPending = requirePending(harness.state);
    await addUpstreamCommit(publisher.rig, "rig next while pending");
    await addUpstreamCommit(publisher.hub, "hub next while pending");
    harness.setNow(addMilliseconds(firstPending.startedAt, ONE_MINUTE_MS));
    await runUpdate(harness.ports);
    const latestPending = requirePending(harness.state);
    harness.setHubFiles({
      restarting: { time: latestPending.restartAfter },
      ready: null,
    });
    harness.setNow(addMilliseconds(latestPending.restartAfter, FIVE_MINUTES_MS));

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(false);
    expect(await pairAt(working)).toEqual(firstPending.confirmed);
    expect(harness.state.badPairs).toEqual([latestPending.attempted]);
    expect(harness.state.confirmed).toEqual(firstPending.confirmed);
  });

  test("telegram disabled creates no pending restart", async () => {
    await addUpstreamCommit(publisher.rig, "rig next");
    await addUpstreamCommit(publisher.hub, "hub next");
    const harness = makeHarness(working, publisher, origin, { telegram: false });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.pending).toBe(null);
    expect(harness.state.confirmed).toEqual(await pairAt(publisher));
    expect(harness.events.map((event) => event.type)).not.toContain("hub-restart-pending");
  });

  test("disabling telegram clears an existing pending restart without restarting the hub", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setState({ ...harness.state, features: { ...harness.state.features, telegram: false } });
    harness.calls.length = 0;

    const result = await runPending(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.pending).toBe(null);
    expect(harness.state.confirmed).toEqual(pending.attempted);
    expect(harness.calls).not.toContain("readHubFiles");
    expect(harness.restartCount).toBe(0);
  });

  test("waiting more than a day emits one warning event", async () => {
    const harness = await startPendingUpdate(working, publisher, origin);
    const pending = requirePending(harness.state);
    harness.setNow(addMilliseconds(pending.startedAt, ONE_DAY_MS));

    const first = await runPending(harness.ports);
    const warningCount = harness.events.filter((event) => event.type === "hub-restart-waiting").length;
    const second = await runPending(harness.ports);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(warningCount).toBe(1);
    expect(harness.events.filter((event) => event.type === "hub-restart-waiting")).toHaveLength(1);
    expect(harness.events.find((event) => event.type === "hub-restart-waiting")?.level).toBe("warn");
    expect(requirePending(harness.state).waitingReported).toBe(true);
  });
});

describe("feature discovery and cron", () => {
  let root: string | null = null;
  let working: Record<RepositoryName, string> = { rig: "", hub: "" };
  let publisher: Record<RepositoryName, string> = { rig: "", hub: "" };
  let origin: Record<RepositoryName, string> = { rig: "", hub: "" };

  beforeEach(async () => {
    const fixture = await openFixture("rig-feature-");
    root = fixture.root;
    working = fixture.working;
    publisher = fixture.publisher;
    origin = fixture.origin;
  });

  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
  });

  test("new features are recorded disabled with an enable command and existing features stay enabled", async () => {
    await addUpstreamCommit(publisher.rig, "feature added");
    const harness = makeHarness(working, publisher, origin, {
      featureNames: ["telegram", "existing-enabled", "new-feature"],
    });
    harness.setState({
      ...harness.state,
      features: { telegram: true, "existing-enabled": true },
    });

    const result = await runUpdate(harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.state.features).toEqual({
      telegram: true,
      "existing-enabled": true,
      "new-feature": false,
    });
    const featureEvent = harness.events.find((event) => event.type === "feature-new");
    expect(featureEvent?.text).toContain("rig feature new-feature enable");
  });

  test("cron entries use absolute bun and rig paths, PATH, both schedules, and update.log", () => {
    const entries = cronEntries();
    const [hourly, pending] = entries.jobs;

    expect(entries.jobs).toHaveLength(2);
    expect(entries.environment).toContain("PATH=\"/usr/local/bin:/usr/bin\"");
    expect(hourly).toContain("0 * * * *");
    expect(hourly).toContain("'/opt/bun/bin/bun'");
    expect(hourly).toContain(">> '/home/rig/.agent-rig/update.log' 2>&1");
    expect(pending).toContain(">> '/home/rig/.agent-rig/update.log' 2>&1");
    expect(pending).toContain("*/5 * * * *");
    expect(pending).toContain("update --pending");
    expect(pending).toContain("'/home/rig/.local/bin/rig-cli.ts'");
  });

  test("cron escapes percent signs, which crontab turns into newlines", () => {
    const result = buildCronEntries({ bunPath: "/opt/bun/bin/bun", rigPath: "/home/100%rig/cli.ts", path: "/usr/bin", logPath: "/home/rig/log%1/update.log" });
    if (!result.ok) throw new Error(result.error);

    for (const job of result.value.jobs) {
      expect(job).toContain("100\\%rig");
      expect(job).toContain("log\\%1");
      expect(job.replaceAll("\\%", "")).not.toContain("%");
    }
  });

  test("cron jobs rotate update.log once it passes the size limit", () => {
    const [hourly, pending] = cronEntries().jobs;

    for (const job of [hourly, pending]) {
      expect(job).toContain("wc -c <");
      expect(job).toContain("mv -f '/home/rig/.agent-rig/update.log' '/home/rig/.agent-rig/update.log.1'");
      expect(job.indexOf("mv -f")).toBeLessThan(job.indexOf(">>"));
    }
  });

  test("merged crontab starts with PATH, keeps jobs last and migrates old inline entries", () => {
    const entries = cronEntries();
    const foreign = "15 3 * * * /usr/bin/backup";
    const old = "0 * * * * PATH='/old' '/opt/bun/bin/bun' '/old.ts' update >> '/l' 2>&1 # agent-rig-update-hourly";

    const merged = mergeCronEntries(`${foreign}\n${old}\n`, entries);

    expect(merged).toBe(`${[...entries.environment, foreign, ...entries.jobs].join("\n")}\n`);
    expect(merged.split("\n")[1]?.startsWith("PATH=")).toBe(true);
    expect(mergeCronEntries(merged, entries)).toBe(merged);
  });

  test("cron refuses relative bun or rig paths", () => {
    const bunResult = buildCronEntries({ bunPath: "bun", rigPath: "/home/rig/rig-cli.ts", path: "/usr/bin", logPath: "/home/rig/.agent-rig/update.log" });
    const rigResult = buildCronEntries({ bunPath: "/opt/bun/bin/bun", rigPath: "rig-cli.ts", path: "/usr/bin", logPath: "/home/rig/.agent-rig/update.log" });

    expect(bunResult.ok).toBe(false);
    expect(rigResult.ok).toBe(false);
  });

  test("cron reinstallation is idempotent and keeps foreign lines including marker mentions", () => {
    const entries = cronEntries();
    const foreign = "# user's agent-rig-update-hourly note";
    const existing = `${foreign}\n${entries.jobs.join("\n")}\n`;

    const once = mergeCronEntries(existing, entries);
    const twice = mergeCronEntries(once, entries);

    expect(once).toBe(twice);
    expect(once.split("\n").filter((line) => line.endsWith("# agent-rig-update-hourly"))).toHaveLength(1);
    expect(once.split("\n").filter((line) => line.endsWith("# agent-rig-update-pending"))).toHaveLength(1);
    expect(once.split("\n").filter((line) => line.startsWith("PATH="))).toHaveLength(1);
    expect(once).toContain(`${foreign}\n`);
  });

  test("merged crontab ends in exactly one newline and keeps other users' lines for empty, unterminated and terminated input", () => {
    const entries = cronEntries();
    const foreign = "15 3 * * * /usr/bin/backup";
    const cases: [string, string[]][] = [
      ["", []],
      [foreign, [foreign]],
      [`${foreign}\n`, [foreign]],
      [`${foreign}\n${entries.jobs[0]}`, [foreign]],
    ];

    for (const [existing, kept] of cases) {
      expect(mergeCronEntries(existing, entries)).toBe(`${[...entries.environment, ...kept, ...entries.jobs].join("\n")}\n`);
    }
  });
});

function makeHarness(
  working: Record<RepositoryName, string>,
  publisher: Record<RepositoryName, string>,
  origin: Record<RepositoryName, string>,
  options: HarnessOptions = {},
): Harness {
  let state: UpdateState = {
    mode: options.mode ?? "server",
    features: { telegram: options.telegram ?? true, "existing-enabled": true },
    confirmed: pairFromWorking(working),
    badPairs: [],
    pending: null,
    transaction: null,
    lastFailure: null,
    pendingEvent: null,
  };
  let now = INITIAL_TIME;
  let hubFiles: HubFiles = { restarting: null, ready: null };
  let failReset = options.failReset ?? null;
  let applyResults = [...(options.applyResults ?? [])];
  let checkResult = options.checkResult ?? ok(undefined);
  let applyCount = 0;
  let restartCount = 0;
  const events: UpdateEvent[] = [];
  const calls: string[] = [];
  const ports: UpdatePorts = {
    git: {
      branchProblem: async () => ok(null),
      isClean: async (repository) => {
        calls.push(`status:${repository}`);
        return ok(git(working[repository], "status", "--porcelain") === "");
      },
      fetchMain: async (repository) => {
        calls.push(`fetch:${repository}`);
        if (options.failFetch === repository) return errorResult(`${repository} fetch failed`);
        git(working[repository], "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
        const branch = git(working[repository], "rev-parse", "refs/remotes/origin/main");
        return ok(branch);
      },
      head: async (repository) => {
        calls.push(`head:${repository}`);
        return ok(git(working[repository], "rev-parse", "HEAD"));
      },
      fastForward: async (repository, target) => {
        calls.push(`ff:${repository}`);
        const result = runGit(working[repository], "merge", "--ff-only", target);
        return result.status === 0 ? ok(undefined) : errorResult(result.stderr.trim());
      },
      resetKeep: async (repository, target) => {
        calls.push(`reset:${repository}`);
        if (failReset === repository) return errorResult(`${repository} reset refused`);
        const result = runGit(working[repository], "reset", "--keep", target);
        return result.status === 0 ? ok(undefined) : errorResult(result.stderr.trim());
      },
    },
    apply: async () => {
      calls.push("apply");
      applyCount += 1;
      return applyResults.shift() ?? ok(undefined);
    },
    check: async () => {
      calls.push("check");
      return checkResult;
    },
    emit: async (event) => {
      calls.push(`emit:${event.type}`);
      events.push(event);
      return ok(undefined);
    },
    hasDelivered: async (eventId) => ok(events.some((event) => event.id === eventId)),
    readState: async () => {
      calls.push("readState");
      return ok(state);
    },
    writeState: async (next) => {
      calls.push("writeState");
      state = next;
      return ok(undefined);
    },
    readHubFiles: async () => {
      calls.push("readHubFiles");
      return ok(hubFiles);
    },
    discoverFeatures: async () => {
      calls.push("discoverFeatures");
      return options.discoverResult ?? ok(options.featureNames ?? ["telegram", "existing-enabled"]);
    },
    service: {
      restart: async () => {
        calls.push("restart");
        restartCount += 1;
        return options.restartResult ?? ok(undefined);
      },
    },
    clock: { now: () => new Date(now) },
  };
  return {
    ports,
    events,
    calls,
    get state() { return state; },
    get applyCount() { return applyCount; },
    get restartCount() { return restartCount; },
    setNow: (value) => { now = value; },
    setState: (next) => { state = next; },
    setHubFiles: (files) => { hubFiles = files; },
    setFailReset: (repository) => { failReset = repository; },
    setCheckResult: (result) => { checkResult = result; },
  };
}

async function startPendingUpdate(
  working: Record<RepositoryName, string>,
  publisher: Record<RepositoryName, string>,
  origin: Record<RepositoryName, string>,
): Promise<Harness> {
  await addUpstreamCommit(publisher.rig, "rig update");
  await addUpstreamCommit(publisher.hub, "hub update");
  const harness = makeHarness(working, publisher, origin);
  const result = await runUpdate(harness.ports);
  expect(result.ok).toBe(true);
  expect(harness.state.pending).not.toBe(null);
  return harness;
}

function makeTransaction(before: Pair, target: Pair, phase: UpdateTransaction["phase"]): UpdateTransaction {
  return {
    before,
    target,
    phase,
    kind: "update",
    failure: "",
    failureReported: false,
    restartService: false,
    completion: null,
  };
}

function requirePending(state: UpdateState): PendingRestart {
  expect(state.pending).not.toBe(null);
  if (state.pending === null) return {
    confirmed: state.confirmed,
    attempted: state.confirmed,
    hubCommit: "",
    startedAt: INITIAL_TIME,
    restartAfter: INITIAL_TIME,
    waitingReported: false,
  };
  return state.pending;
}

async function addUpstreamCommit(repository: string, content: string): Promise<void> {
  await writeFile(join(repository, "version.txt"), content);
  await commit(repository, content);
  git(repository, "push", "origin", "main");
}

function fixtureAt(root: string): Fixture {
  return {
    root,
    working: { rig: join(root, "rig"), hub: join(root, "hub") },
    publisher: { rig: join(root, "publisher-rig"), hub: join(root, "publisher-hub") },
    origin: { rig: join(root, "rig.git"), hub: join(root, "hub.git") },
  };
}

async function buildTemplate(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rig-update-template-"));
  const fixture = fixtureAt(root);
  for (const repository of REPOSITORIES) {
    git(root, "init", "--bare", "--initial-branch=main", fixture.origin[repository]);
    git(root, "clone", fixture.origin[repository], fixture.publisher[repository]);
    await writeFile(join(fixture.publisher[repository], "version.txt"), "initial");
    await writeFile(join(fixture.publisher[repository], "personal.txt"), "original");
    await commit(fixture.publisher[repository], "initial");
    git(fixture.publisher[repository], "push", "origin", "main");
    git(root, "clone", fixture.origin[repository], fixture.working[repository]);
    const originName = basename(fixture.origin[repository]);
    // Disposable fixture repos: fsync costs 0.1+ s per git write on Windows; maintenance
    // and gc are background housekeeping that no update assertion depends on.
    for (const repo of [fixture.origin[repository], fixture.publisher[repository], fixture.working[repository]]) {
      git(repo, "config", "core.fsync", "none");
      git(repo, "config", "maintenance.auto", "false");
      git(repo, "config", "gc.auto", "0");
    }
    git(fixture.working[repository], "remote", "set-url", "origin", `../${originName}`);
    git(fixture.publisher[repository], "remote", "set-url", "origin", `../${originName}`);
  }
  return fixture;
}

async function openFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await cp(template.root, root, { recursive: true });
  return fixtureAt(root);
}

async function commit(repository: string, message: string): Promise<void> {
  git(repository, "add", ".");
  git(repository, "-c", `user.name=${TEST_USER_NAME}`, "-c", `user.email=${TEST_USER_EMAIL}`, "commit", "-m", message);
}

async function pairAt(repositories: Record<RepositoryName, string>): Promise<Pair> {
  return {
    rig: git(repositories.rig, "rev-parse", "HEAD"),
    hub: git(repositories.hub, "rev-parse", "HEAD"),
  };
}

function pairFromWorking(repositories: Record<RepositoryName, string>): Pair {
  return {
    rig: git(repositories.rig, "rev-parse", "HEAD"),
    hub: git(repositories.hub, "rev-parse", "HEAD"),
  };
}

function fetchTargets(repositories: Record<RepositoryName, string>): void {
  for (const repository of REPOSITORIES) {
    git(repositories[repository], "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = runGit(cwd, ...args);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function runGit(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function cronEntries(): CronEntries {
  const result = buildCronEntries({
    bunPath: "/opt/bun/bin/bun",
    rigPath: "/home/rig/.local/bin/rig-cli.ts",
    path: "/usr/local/bin:/usr/bin",
    logPath: "/home/rig/.agent-rig/update.log",
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function errorResult<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

import type { Result } from "../../src/result";
import type { RuntimePorts } from "../../src/ports";
import type { RigState } from "../../src/state";
import type {
  BranchProblem,
  HubFiles,
  Pair,
  PendingRestart,
  RepositoryName,
  UpdateEvent,
  UpdatePorts,
  UpdateState,
  UpdateTransaction,
} from "../../src/update/update";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { en } from "../../src/messages.js";
import { ru } from "../../src/messages-ru.js";
import { createRealGitAdapter } from "../../src/commands/real-runtime";
import { updateRig } from "../../src/commands/update";
import { runPending, runUpdate } from "../../src/update/update";
import { createMemoryRuntime } from "../fakes/memory-runtime";

const GIT_TEST_TIMEOUT_MS = 30_000;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const T0 = "2026-10-30T00:00:00.000Z";
const HOME = "/home/test";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const EVENTS_PATH = `${HOME}/.agent-rig/events.jsonl`;
const OFFSET_PATH = `${HOME}/.agent-rig/events.offset`;
const OVER_TRIM_THRESHOLD_BYTES = 1024 * 1024 + 1;
const TEST_USER = ["-c", "user.name=Cycle Test", "-c", "user.email=cycle-test@example.com"];

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);

type Control = {
  fetchError: string | null;
  branchProblem: BranchProblem;
  clean: boolean;
  applyResults: Result<void>[];
  failEmitAt: number | null;
  // The first save made after an event was appended fails, as if the process died right after the append.
  failSaveAfterEmit: boolean;
  hubFiles: HubFiles;
  now: string;
  heads: Pair;
  remote: Pair;
  releaseVersions: Record<string, string>;
};

type Fake = {
  ports: UpdatePorts;
  control: Control;
  events: UpdateEvent[];
  emitAttempts: () => number;
  restarts: () => number;
  calls: string[];
  state: () => UpdateState;
  setState: (state: UpdateState) => void;
};

const pair = (rig: string, hub: string): Pair => ({ rig, hub });

const baseState = (overrides: Partial<UpdateState> = {}): UpdateState => ({
  mode: "server",
  features: { telegram: true },
  confirmed: pair("r1", "h1"),
  badPairs: [],
  pending: null,
  transaction: null,
  lastFailure: null,
  pendingEvent: null,
  ...overrides,
});

const makePending = (overrides: Partial<PendingRestart> = {}): PendingRestart => ({
  confirmed: pair("r0", "h0"),
  attempted: pair("r1", "h1"),
  hubCommit: "h1",
  startedAt: T0,
  restartAfter: T0,
  waitingReported: false,
  ...overrides,
});

const makeFake = (initial: UpdateState = baseState()): Fake => {
  let state = initial;
  let emitAttempts = 0;
  let restarts = 0;
  let emittedSinceSave = false;
  const events: UpdateEvent[] = [];
  const calls: string[] = [];
  const control: Control = {
    fetchError: null,
    branchProblem: null,
    clean: true,
    applyResults: [],
    failEmitAt: null,
    failSaveAfterEmit: false,
    hubFiles: { restarting: null, ready: null },
    now: T0,
    heads: pair("r1", "h1"),
    remote: pair("r1", "h1"),
    releaseVersions: {},
  };
  const ports: UpdatePorts = {
    messages: en,
    git: {
      isClean: async () => ({ ok: true, value: control.clean }),
      branchProblem: async () => ({ ok: true, value: control.branchProblem }),
      fetchMain: async (repository: RepositoryName) => {
        if (control.fetchError !== null) return { ok: false, error: control.fetchError };
        return { ok: true, value: control.remote[repository] };
      },
      readVersion: async (repository: RepositoryName, commit: string) => ({
        ok: true,
        value: control.releaseVersions[`${repository}:${commit}`] ?? null,
      }),
      head: async (repository: RepositoryName) => ({ ok: true, value: control.heads[repository] }),
      fastForward: async (repository: RepositoryName, commit: string) => {
        calls.push(`ff:${repository}`);
        control.heads = { ...control.heads, [repository]: commit };
        return { ok: true, value: undefined };
      },
      resetKeep: async (repository: RepositoryName, commit: string) => {
        calls.push(`reset:${repository}`);
        control.heads = { ...control.heads, [repository]: commit };
        return { ok: true, value: undefined };
      },
    },
    apply: async () => control.applyResults.shift() ?? { ok: true, value: undefined },
    check: async () => ({ ok: true, value: undefined }),
    emit: async (event) => {
      emitAttempts += 1;
      if (control.failEmitAt === emitAttempts) return { ok: false, error: "emit failed" };
      events.push(event);
      emittedSinceSave = true;
      return { ok: true, value: undefined };
    },
    hasDelivered: async (eventId) => ({ ok: true, value: events.some((event) => event.id === eventId) }),
    readState: async () => ({ ok: true, value: state }),
    writeState: async (next) => {
      if (control.failSaveAfterEmit && emittedSinceSave) {
        control.failSaveAfterEmit = false;
        emittedSinceSave = false;
        return { ok: false, error: "save failed" };
      }
      emittedSinceSave = false;
      state = next;
      return { ok: true, value: undefined };
    },
    readHubFiles: async () => ({ ok: true, value: control.hubFiles }),
    discoverFeatures: async () => ({ ok: true, value: ["telegram"] }),
    service: { restart: async () => { restarts += 1; return { ok: true, value: undefined }; } },
    clock: { now: () => new Date(control.now) },
  };
  return {
    ports,
    control,
    events,
    emitAttempts: () => emitAttempts,
    restarts: () => restarts,
    calls,
    state: () => state,
    setState: (next) => { state = next; },
  };
};

const later = (milliseconds: number): string => new Date(Date.parse(T0) + milliseconds).toISOString();

describe("C1: a new hub commit while the hub restarts", () => {
  test("keeps the restarting signal valid, so the original deadline still rolls the hub back", async () => {
    const fake = makeFake(baseState({ pending: makePending(), confirmed: pair("r0", "h0") }));
    fake.control.hubFiles = { restarting: { time: T0 }, ready: null };
    fake.control.remote = pair("r1", "h2");
    fake.control.now = later(3 * ONE_MINUTE_MS);

    const updated = await runUpdate(fake.ports);
    expect(updated.ok).toBe(true);
    expect(fake.state().pending?.hubCommit).toBe("h2");

    fake.control.now = later(FIVE_MINUTES_MS);
    const pending = await runPending(fake.ports);

    expect(pending.ok).toBe(false);
    expect(fake.restarts()).toBe(1);
    expect(fake.events.some((event) => event.type === "update-failed")).toBe(true);
    expect(fake.state().pending).toBe(null);
  });

  test("ignores a restarting signal written before this wait began", async () => {
    const fake = makeFake(baseState({ pending: makePending() }));
    fake.control.hubFiles = { restarting: { time: later(-ONE_HOUR_MS) }, ready: null };
    fake.control.now = later(FIVE_MINUTES_MS);

    const result = await runPending(fake.ports);

    expect(result.ok).toBe(true);
    expect(fake.restarts()).toBe(0);
    expect(fake.state().pending).not.toBe(null);
  });
});

describe("C2: one message per failure cause", () => {
  test("repeating the same cause hourly reports once and remembers it in the state", async () => {
    const fake = makeFake();
    fake.control.fetchError = "network down";

    for (let hour = 0; hour < 3; hour += 1) {
      fake.control.now = later(hour * ONE_HOUR_MS);
      const result = await runUpdate(fake.ports);
      expect(result.ok).toBe(false);
    }

    expect(fake.events.filter((event) => event.type === "update-failed")).toHaveLength(1);
    expect(fake.state().lastFailure).not.toBe(null);
  });

  test("a changed cause reports again", async () => {
    const fake = makeFake();
    fake.control.fetchError = "network down";
    await runUpdate(fake.ports);
    fake.control.now = later(ONE_HOUR_MS);
    fake.control.fetchError = "auth denied";
    await runUpdate(fake.ports);

    expect(fake.events).toHaveLength(2);
  });

  test("the same cause after the problem disappeared reports again", async () => {
    const fake = makeFake();
    fake.control.fetchError = "network down";
    await runUpdate(fake.ports);
    fake.control.now = later(ONE_HOUR_MS);
    fake.control.fetchError = null;
    const healthy = await runUpdate(fake.ports);
    expect(healthy.ok).toBe(true);
    expect(fake.state().lastFailure).toBe(null);
    fake.control.now = later(2 * ONE_HOUR_MS);
    fake.control.fetchError = "network down";
    await runUpdate(fake.ports);

    expect(fake.events.filter((event) => event.type === "update-failed")).toHaveLength(2);
  });

  test("a recovered fetch writes one update-ok and clears the failure", async () => {
    const fake = makeFake();
    fake.control.fetchError = "network down";
    const failed = await runUpdate(fake.ports);
    expect(failed.ok).toBe(false);

    fake.control.now = later(ONE_HOUR_MS);
    fake.control.fetchError = null;
    const healthy = await runUpdate(fake.ports);

    expect(healthy.ok).toBe(true);
    const oks = fake.events.filter((event) => event.type === "update-ok");
    expect(oks).toHaveLength(1);
    expect(oks[0]?.level).toBe("info");
    expect(oks[0]?.text).toBe("Update works again: the clones match main.");
    expect(fake.state().lastFailure).toBe(null);
  });

  test("a further healthy run after the recovery writes no new update-ok", async () => {
    const fake = makeFake();
    fake.control.fetchError = "network down";
    await runUpdate(fake.ports);
    fake.control.now = later(ONE_HOUR_MS);
    fake.control.fetchError = null;
    await runUpdate(fake.ports);

    fake.control.now = later(2 * ONE_HOUR_MS);
    const again = await runUpdate(fake.ports);

    expect(again.ok).toBe(true);
    expect(fake.events.map((event) => event.type)).toEqual(["update-failed", "update-ok"]);
    expect(fake.state().lastFailure).toBe(null);
  });

  test("a healthy run with no earlier failure writes no event and no state write", async () => {
    const fake = makeFake();
    let writes = 0;
    const writeState = fake.ports.writeState;
    fake.ports.writeState = async (next) => {
      writes += 1;
      return writeState(next);
    };

    const result = await runUpdate(fake.ports);

    expect(result.ok).toBe(true);
    expect(fake.events).toHaveLength(0);
    expect(writes).toBe(0);
  });

  test("a recovered notification is not emitted twice", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("r2", "h2");
    fake.ports.discoverFeatures = async () => ({ ok: true, value: ["telegram", "alpha", "beta"] });
    fake.control.failEmitAt = 2;

    const first = await runUpdate(fake.ports);
    expect(first.ok).toBe(false);
    const second = await runUpdate(fake.ports);
    expect(second.ok).toBe(true);

    const ids = fake.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fake.events.map((event) => event.type).filter((type) => type === "update-ok")).toHaveLength(1);
    expect(fake.events.filter((event) => event.type === "feature-new")).toHaveLength(2);
  });
});

describe("C3: a clone off main or ahead of origin", () => {
  test("skips the update, leaves the clone alone and reports the reason once", async () => {
    const fake = makeFake();
    fake.control.remote = pair("r2", "h2");
    fake.control.branchProblem = "not-on-main";

    for (let hour = 0; hour < 2; hour += 1) {
      fake.control.now = later(hour * ONE_HOUR_MS);
      const result = await runUpdate(fake.ports);
      expect(result.ok).toBe(true);
    }

    expect(fake.calls).toEqual([]);
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]?.type).toBe("update-skipped");
    expect(fake.events[0]?.text).toContain("main");
  });

  test("local commits skip the update with their own reason", async () => {
    const fake = makeFake();
    fake.control.remote = pair("r2", "h2");
    fake.control.branchProblem = "local-commits";

    await runUpdate(fake.ports);

    expect(fake.calls).toEqual([]);
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]?.text).toContain("local commits");
  });

  test("update events are written in the language of the ports' messages", async () => {
    const fake = makeFake();
    fake.ports.messages = ru;
    fake.control.remote = pair("r2", "h2");
    fake.control.branchProblem = "local-commits";

    await runUpdate(fake.ports);

    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]?.text).toBe(ru.update.skippedLocalCommits("rig"));
    expect(fake.events[0]?.text).not.toContain("local commits");
  });

  describe("real git adapter", () => {
    let root: string | null = null;
    afterEach(async () => {
      if (root !== null) await rm(root, { recursive: true, force: true });
      root = null;
    });

    test("branchProblem reports a feature branch and local commits and nothing for a clean main", async () => {
      root = await mkdtemp(join(tmpdir(), "rig-branch-"));
      const origin = join(root, "origin.git");
      const clone = join(root, "clone");
      runGit(root, "init", "--bare", "--initial-branch=main", origin);
      runGit(root, "clone", origin, clone);
      await writeFile(join(clone, "a.txt"), "a");
      runGit(clone, "add", ".");
      runGit(clone, ...TEST_USER, "commit", "-m", "first");
      runGit(clone, "push", "origin", "main");
      const adapter = createRealGitAdapter(realProcess(), { repo: clone, hub: clone });

      expect(await adapter.branchProblem("rig")).toEqual({ ok: true, value: null });

      runGit(clone, "checkout", "-b", "feature");
      expect(await adapter.branchProblem("rig")).toEqual({ ok: true, value: "not-on-main" });

      runGit(clone, "checkout", "main");
      await writeFile(join(clone, "b.txt"), "b");
      runGit(clone, "add", ".");
      runGit(clone, ...TEST_USER, "commit", "-m", "local");
      expect(await adapter.branchProblem("rig")).toEqual({ ok: true, value: "local-commits" });
    });
  });
});

describe("C4: the event log is trimmed", () => {
  test("a full-read oversized log is emptied by a normal update run", async () => {
    const harness = createMemoryRuntime();
    harness.fs.seed(STATE_PATH, serverState());
    const text = "x".repeat(OVER_TRIM_THRESHOLD_BYTES);
    harness.fs.seed(EVENTS_PATH, text);
    harness.fs.seed(OFFSET_PATH, `${new TextEncoder().encode(text).length}\n`);

    const result = await updateRig(harness.runtime, false, () => undefined);

    expect(result.ok).toBe(true);
    expect(harness.fs.files.get(EVENTS_PATH)).toBe("");
  });
});

describe("C5: rollback event", () => {
  test("a failed update that was rolled back also sends the rollback event", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("r2", "h2");
    fake.control.applyResults = [{ ok: false, error: "apply broke" }];

    const result = await runUpdate(fake.ports);

    expect(result.ok).toBe(false);
    expect(fake.events.map((event) => event.type)).toEqual(["update-failed", "rollback"]);
  });
});

describe("C6: pending recovery and corrupt pending", () => {
  test("runPending completes an interrupted transaction even without a pending restart", async () => {
    const transaction: UpdateTransaction = {
      before: pair("r1", "h1"),
      target: pair("r2", "h2"),
      phase: "checked",
      kind: "update",
      failure: "",
      failureReported: false,
      restartService: false,
      completion: null,
    };
    const fake = makeFake(baseState({ features: { telegram: false }, transaction }));
    fake.control.heads = pair("r2", "h2");

    const result = await runPending(fake.ports);

    expect(result.ok).toBe(true);
    expect(fake.state().transaction).toBe(null);
    expect(fake.state().confirmed).toEqual(pair("r2", "h2"));
  });

  test("a corrupt pending restart is an error instead of silently becoming empty", async () => {
    const harness = createMemoryRuntime();
    harness.fs.seed(STATE_PATH, serverState("{bad"));

    const result = await updateRig(harness.runtime, true, () => undefined);

    expect(result.ok).toBe(false);
  });
});

describe("C8: bad pairs stay bounded", () => {
  test("only the latest failed pair is kept", async () => {
    const fake = makeFake(baseState({ features: { telegram: false }, badPairs: [pair("r8", "h8"), pair("r9", "h9")] }));
    fake.control.remote = pair("r2", "h2");
    fake.control.applyResults = [{ ok: false, error: "apply broke" }];

    await runUpdate(fake.ports);

    expect(fake.state().badPairs).toEqual([pair("r2", "h2")]);
  });
});

describe("the update-ok event names the versions", () => {
  test("it shows different release versions read from the before and target commits", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("abcdef0123456789", "fedcba9876543210");
    fake.control.releaseVersions = {
      "rig:r1": "0.1.0",
      "rig:abcdef0123456789": "0.2.0",
      "hub:h1": "1.0.0",
      "hub:fedcba9876543210": "1.1.0",
    };

    expect((await runUpdate(fake.ports)).ok).toBe(true);

    expect(fake.events.find((event) => event.type === "update-ok")?.text).toBe(
      "Updated: agent-rig 0.1.0 → 0.2.0, hub 1.0.0 → 1.1.0.",
    );
  });

  test("it shows commits when both releases are equal and leaves out unchanged repositories", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("r2", "h1");
    fake.control.releaseVersions = { "rig:r1": "0.2.0", "rig:r2": "0.2.0" };

    expect((await runUpdate(fake.ports)).ok).toBe(true);

    expect(fake.events.find((event) => event.type === "update-ok")?.text).toBe(
      "Updated: agent-rig 0.2.0 (r1 → r2).",
    );
  });

  test("it falls back to short commits when either release is unknown", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("abcdef0123456789", "fedcba9876543210");
    fake.control.releaseVersions = { "rig:abcdef0123456789": "0.2.0" };

    expect((await runUpdate(fake.ports)).ok).toBe(true);

    expect(fake.events.find((event) => event.type === "update-ok")?.text).toBe(
      "Updated: agent-rig r1 → abcdef0, hub h1 → fedcba9.",
    );
  });

  test("release lookup reads the commit even when the working tree has another version", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-release-version-"));
    try {
      const repository = join(root, "repo");
      runGit(root, "init", "--initial-branch=main", repository);
      runGit(repository, "config", "user.name", "Cycle Test");
      runGit(repository, "config", "user.email", "cycle-test@example.com");
      await writeFile(join(repository, "package.json"), JSON.stringify({ version: "0.1.0" }));
      runGit(repository, "add", "package.json");
      runGit(repository, "-c", "user.name=Cycle Test", "-c", "user.email=cycle-test@example.com", "commit", "-m", "release");
      const commit = runGit(repository, "rev-parse", "HEAD");
      await writeFile(join(repository, "package.json"), JSON.stringify({ version: "9.9.9" }));
      const adapter = createRealGitAdapter(realProcess(), { repo: repository, hub: repository });

      expect(await adapter.readVersion("rig", commit)).toEqual({ ok: true, value: "0.1.0" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("the root package version uses three numeric components", async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  expect(typeof manifest).toBe("object");
  expect(manifest).not.toBeNull();
  expect(manifest).toHaveProperty("version");
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) return;
  expect(typeof manifest.version).toBe("string");
  if (typeof manifest.version !== "string") return;
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
});

describe("C9: an event is delivered once across a crash", () => {
  test("a failed save right after an event is appended does not deliver it again", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("r2", "h2");
    fake.control.failSaveAfterEmit = true;

    const first = await runUpdate(fake.ports);
    expect(first.ok).toBe(false);
    expect(fake.events.map((event) => event.type)).toEqual(["update-ok"]);

    const second = await runUpdate(fake.ports);
    expect(second.ok).toBe(true);
    expect(fake.events.map((event) => event.type)).toEqual(["update-ok"]);
    expect(fake.state().transaction).toBe(null);
  });

  test("a crash before the append still delivers the event exactly once", async () => {
    const fake = makeFake(baseState({ features: { telegram: false } }));
    fake.control.remote = pair("r2", "h2");
    fake.control.failEmitAt = 1;

    const first = await runUpdate(fake.ports);
    expect(first.ok).toBe(false);
    expect(fake.events).toHaveLength(0);

    const second = await runUpdate(fake.ports);
    expect(second.ok).toBe(true);
    expect(fake.events.map((event) => event.type)).toEqual(["update-ok"]);
  });

  test("a failed save right after the failure event does not report the same cause again", async () => {
    const fake = makeFake();
    fake.control.fetchError = "network down";
    fake.control.failSaveAfterEmit = true;

    const first = await runUpdate(fake.ports);
    expect(first.ok).toBe(false);
    const second = await runUpdate(fake.ports);
    expect(second.ok).toBe(false);

    expect(fake.events.map((event) => event.type)).toEqual(["update-failed"]);
  });
});

describe("update events do not read the whole log", () => {
  test("emitting an event never reads events.jsonl before appending", async () => {
    const harness = createMemoryRuntime();
    harness.fs.seed(STATE_PATH, serverState());
    const order: string[] = [];
    const originalRead = harness.fs.readText.bind(harness.fs);
    harness.fs.readText = async (path: string) => {
      if (path === EVENTS_PATH) order.push("read-events");
      return originalRead(path);
    };
    const originalAppend = harness.fs.appendText.bind(harness.fs);
    harness.fs.appendText = async (path: string, value: string) => {
      if (path === EVENTS_PATH) order.push("append-events");
      return originalAppend(path, value);
    };
    const run = harness.runtime.process.run;
    harness.runtime.process.run = async (command, args, options) => {
      if (command === "git" && args.includes("branch")) return processOk("main\n");
      if (command === "git" && args.includes("rev-list")) return processOk("0\n");
      if (command === "git" && args.includes("rev-parse") && args.includes("origin/main")) return processOk("new\n");
      if (command === "git" && args.includes("rev-parse")) return processOk("old\n");
      if (command === "git" && args.includes("status")) return processOk(" M file.txt\n");
      return run(command, args, options);
    };

    const result = await updateRig(harness.runtime, false, () => undefined);

    expect(result.ok).toBe(true);
    expect(order).toContain("append-events");
    expect(order.slice(0, order.indexOf("append-events"))).not.toContain("read-events");
  });
});

const processOk = (stdout: string): Result<{ stdout: string; stderr: string; exitCode: number }> => ({
  ok: true,
  value: { stdout, stderr: "", exitCode: 0 },
});

const serverState = (pendingHubRestart: string | null = null): string => {
  const state: RigState = {
    mode: "server",
    paths: { repo: "/repo", hub: "/hub" },
    features: { telegram: false },
    records: {},
    badPairs: [],
    pendingHubRestart,
  };
  return `${JSON.stringify(state, null, 2)}\n`;
};

const runGit = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
};

const realProcess = (): RuntimePorts["process"] => ({
  run: async (command, args, options) => {
    const result = spawnSync(command, [...args], { cwd: options?.cwd, encoding: "utf8" });
    if (result.error !== undefined) return { ok: false, error: result.error.message };
    return { ok: true, value: { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 } };
  },
  isAvailable: async () => true,
});

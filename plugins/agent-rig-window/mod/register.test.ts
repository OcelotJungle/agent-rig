// Run with `claude plugin test plugins/agent-rig-window`. The world beneath the module is a map of files, a clock
// that moves when the test moves it, and fakes for the session calls.
import type { On } from "claude-code";

import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/tester";
const SESSION = "sess-1";
const DIR = `${HOME}/.agent-rig/sessions/${SESSION}`;
const POLL_MS = 1000;
const WINDOW = 200_000;
const TOKENS = 1234;
const OK = { exitCode: 0, stdout: "", stderr: "" };

// The engine hands paths over in the platform spelling (C:home...); the fake files are keyed by one spelling.
const CLAUDE_PID = "4242";
const norm = (path: string): string => path.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");

type World = {
  files: Map<string, string>;
  dirs: Set<string>;
  pidText: string;
  compactions: (string | undefined)[];
  snapshotWrites: number;
  context: { tokens?: number; window: number; breakdown?: { totalTokens: number } };
  renames: string[];
  autocompacts: string[];
  compactResult: { skip?: string };
  autocompactText?: string;
  // What `$.session.id()` answers now; a test changes it to switch the session inside the window.
  sessionId: string;
  clock: ReturnType<typeof mock.clock>;
};

// Every `$` call the module makes, answered by the test; `session.start` is the engine's own echo.
function world(on: On): World {
  const w: World = { files: new Map(), dirs: new Set(), pidText: CLAUDE_PID, compactions: [], snapshotWrites: 0, context: { tokens: TOKENS, window: WINDOW }, renames: [], autocompacts: [], compactResult: {}, sessionId: SESSION, clock: mock.clock(on) };
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("env.get", (_, e) => ({ value: e.name === "HOME" ? HOME : undefined }));
  on("session.id", () => ({ value: w.sessionId }));
  on("session.usage", () => ({ value: { startedAt: 0, context: w.context, rateLimits: [{ kind: "five_hour", percentUsed: 5 }] } }));
  on("fs.write", (_, e) => {
    w.files.set(norm(e.path), e.text);
    if (norm(e.path).includes("/usage.json")) w.snapshotWrites++;
    return { value: undefined };
  });
  on("fs.read", (_, e) => {
    const text = w.files.get(norm(e.path));
    return text === undefined ? { deny: "missing" } : { value: text };
  });
  on("fs.list", (_, e) => ({
    value:
    [...w.files.keys()]
      .filter(path => path.startsWith(`${norm(e.path)}/`))
      .map(path => ({ name: path.slice(norm(e.path).length + 1), kind: "file" as const, size: 0, mtimeMs: 0, isLink: false })),
  }));
  // mv and rm, the only commands the module runs.
  on("process.run", (_, e) => {
    const [command, ...args] = e.argv;
    if (command === "mv") {
      const [, from, to] = args;
      const text = from === undefined ? undefined : w.files.get(norm(from));
      if (from !== undefined && to !== undefined && text !== undefined) {
        w.files.delete(norm(from));
        w.files.set(norm(to), text);
      }
    } else if (command === "rm") {
      for (const path of args.slice(1)) w.files.delete(norm(path));
    } else if (command === "sh") {
      return { value: { exitCode: 0, stdout: w.pidText, stderr: "" } };
    } else if (command === "mkdir") {
      // Plain mkdir fails on an existing directory (the claim); -p never does.
      const path = norm(args[args.length - 1] ?? "");
      if (args[0] !== "-p") {
        if (w.dirs.has(path)) return { value: { exitCode: 1, stdout: "", stderr: "exists" } };
        w.dirs.add(path);
      }
    }
    return { value: OK };
  });
  on("session.compact", (_, e) => {
    w.compactions.push(e.instructions);
    if (w.compactResult.skip !== undefined) return { skip: w.compactResult.skip };
    w.context = { window: WINDOW, breakdown: { totalTokens: 13_000 } };
    return { messages: [{ role: "user" as const, text: "summary", toolUses: [] }], tokensBefore: 163_000, tokensAfter: 13_000 };
  });
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.run", (_, e) => {
    if (e.command === "autocompact") {
      w.autocompacts.push(e.args);
      return w.autocompactText === undefined ? {} : { text: w.autocompactText };
    }
    w.renames.push(e.args);
    return { value: {} };
  });
  return w;
}

const request = (w: World, id: string, body: unknown) => w.files.set(`${DIR}/requests/${id}.json`, typeof body === "string" ? body : JSON.stringify(body));
const response = (w: World, id: string): Record<string, unknown> | undefined => {
  const text = w.files.get(`${DIR}/responses/${id}.json`);
  return text === undefined ? undefined : JSON.parse(text);
};
const start = ($: { session: { start: (a: { cwd: string; surface: "terminal"; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

test("a snapshot is written at start and on every measure, with the measure's rate limits", async ($, on) => {
  const w = world(on);
  await start($);
  const first = JSON.parse(w.files.get(`${DIR}/usage.json`) ?? "null");
  expect(first.context.tokens).toBe(TOKENS);
  expect(first.rateLimits[0].kind).toBe("five_hour");
  expect(typeof first.at).toBe("string");

  const rateLimits = [{ kind: "seven_day", percentUsed: 42 }];
  await $.session.measure({ context: { tokens: 9, window: WINDOW }, rateLimits, changed: ["rateLimits"] });
  await w.clock.settle();
  const second = JSON.parse(w.files.get(`${DIR}/usage.json`) ?? "null");
  expect(second.rateLimits).toEqual(rateLimits);
  // No stray temp file stays beside the snapshot.
  expect([...w.files.keys()].filter(path => path.includes(".tmp"))).toEqual([]);
});

test("usage and mode are answered at once; the request is removed", async ($, on) => {
  const w = world(on);
  await start($);
  request(w, "u1", { id: "u1", op: "usage" });
  request(w, "m1", { id: "m1", op: "mode" });
  await w.clock.advance(POLL_MS);
  const usage = response(w, "u1");
  expect(usage?.ok).toBe(true);
  expect(JSON.stringify(usage?.result)).toContain(String(TOKENS));
  const mode = response(w, "m1");
  expect(mode?.ok).toBe(false);
  expect(String(mode?.error)).toContain("permission mode");
  expect(w.files.has(`${DIR}/requests/u1.json`)).toBe(false);
  expect(w.files.has(`${DIR}/requests/m1.json`)).toBe(false);
});

test("compact and rename run when no turn runs", async ($, on) => {
  const w = world(on);
  await start($);
  request(w, "c1", { id: "c1", op: "compact", args: { instructions: "keep the plan" } });
  request(w, "r1", { id: "r1", op: "rename", args: { name: "  new   name " } });
  await w.clock.advance(POLL_MS);
  expect(w.compactions).toEqual(["keep the plan"]);
  expect(w.renames).toEqual(["new name"]);
  expect(response(w, "c1")?.ok).toBe(true);
  expect(response(w, "r1")?.result).toEqual({ name: "new name" });
  expect(w.files.has(`${DIR}/requests/c1.json`)).toBe(false);
});

test("a rig compact request rewrites usage once after compaction with the engine's post-compaction context", async ($, on) => {
  const w = world(on);
  await start($);
  expect(w.snapshotWrites).toBe(1);
  request(w, "c1", { id: "c1", op: "compact" });
  await w.clock.advance(POLL_MS);
  const snapshot = JSON.parse(w.files.get(`${DIR}/usage.json`) ?? "null");
  expect(snapshot.context).toEqual({ window: WINDOW, breakdown: { totalTokens: 13_000 } });
  expect(w.snapshotWrites).toBe(2);
});

test("a request whose claim directory another process made is neither run nor answered here", async ($, on) => {
  const w = world(on);
  await start($);
  w.dirs.add(`${DIR}/claims/c1`);
  request(w, "c1", { id: "c1", op: "compact" });
  request(w, "c2", { id: "c2", op: "compact" });
  await w.clock.advance(POLL_MS * 2);
  expect(w.compactions.length).toBe(1);
  expect(response(w, "c1")).toBeUndefined();
  expect(w.files.has(`${DIR}/requests/c1.json`)).toBe(true);
  expect(response(w, "c2")?.ok).toBe(true);
  expect(w.files.get(`${DIR}/claims/c2/pid`)).toBe(CLAUDE_PID);
});

test("a claim records no pid when the environment variable is not a positive integer", async ($, on) => {
  const w = world(on);
  w.pidText = "";
  await start($);
  request(w, "c1", { id: "c1", op: "compact" });
  await w.clock.advance(POLL_MS * 2);
  expect(response(w, "c1")?.ok).toBe(true);
  expect(w.files.has(`${DIR}/claims/c1/pid`)).toBe(false);
});

test("autocompact runs the session's own command and answers the window, with the command text when there is one", async ($, on) => {
  const w = world(on);
  w.autocompactText = "  Window set  ";
  await start($);
  request(w, "a1", { id: "a1", op: "autocompact", args: { window: 333000 } });
  await w.clock.advance(POLL_MS);
  expect(w.autocompacts).toEqual(["333000"]);
  expect(response(w, "a1")).toEqual({ id: "a1", ok: true, result: { window: 333000, text: "Window set" } });
  expect(w.files.has(`${DIR}/requests/a1.json`)).toBe(false);

  w.autocompactText = undefined;
  request(w, "a2", { id: "a2", op: "autocompact", args: { window: "auto" } });
  await w.clock.advance(POLL_MS);
  expect(w.autocompacts).toEqual(["333000", "auto"]);
  expect(response(w, "a2")?.result).toEqual({ window: "auto" });
  expect(w.renames).toEqual([]);
});

test("autocompact with bad args is an error response and runs nothing", async ($, on) => {
  const w = world(on);
  await start($);
  const bad: unknown[] = [undefined, 0, -1, 1.5, "333k", "AUTO", "5", null, true];
  bad.forEach((window, i) => request(w, `b${i}`, { id: `b${i}`, op: "autocompact", args: { window } }));
  request(w, "bnone", { id: "bnone", op: "autocompact" });
  await w.clock.advance(POLL_MS);
  for (const id of [...bad.keys()].map(i => `b${i}`).concat("bnone")) {
    expect(response(w, id)?.ok).toBe(false);
    expect(String(response(w, id)?.error)).toContain("window");
  }
  expect(w.autocompacts).toEqual([]);
});

test("an autocompact request that arrives during a turn waits until the turn ends", async ($, on) => {
  const w = world(on);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  await start($);
  await $.turn.start({ text: "hi", turnId: "t1" });
  request(w, "a1", { id: "a1", op: "autocompact", args: { window: "auto" } });
  await w.clock.advance(POLL_MS * 3);
  expect(w.autocompacts).toEqual([]);
  expect(response(w, "a1")).toBeUndefined();
  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
  await w.clock.advance(POLL_MS);
  expect(w.autocompacts).toEqual(["auto"]);
  expect(response(w, "a1")?.ok).toBe(true);
});

test("a compaction skipped by a hook is answered as a result with the reason", async ($, on) => {
  const w = world(on);
  w.compactResult = { skip: "vetoed" };
  await start($);
  request(w, "c1", { id: "c1", op: "compact" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "c1")?.result).toEqual({ skip: "vetoed" });
});

test("a request that arrives during a turn waits until the turn ends", async ($, on) => {
  const w = world(on);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  await start($);
  await $.turn.start({ text: "hi", turnId: "t1" });
  request(w, "c1", { id: "c1", op: "compact" });
  request(w, "r1", { id: "r1", op: "rename", args: { name: "x" } });
  await w.clock.advance(POLL_MS * 3);
  expect(w.compactions).toEqual([]);
  expect(response(w, "c1")).toBeUndefined();
  expect(w.files.has(`${DIR}/requests/c1.json`)).toBe(true);

  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "c1")?.ok).toBe(true);
  expect(response(w, "r1")?.ok).toBe(true);
  expect(w.compactions.length).toBe(1);
});

test("a malformed request or an unknown op is an error response, never a crash", async ($, on) => {
  const w = world(on);
  await start($);
  request(w, "bad1", "{not json");
  request(w, "bad2", "[1]");
  request(w, "bad3", { id: "other", op: "usage" });
  request(w, "bad4", { id: "bad4", op: "explode" });
  request(w, "bad5", { id: "bad5", op: "usage", args: 7 });
  request(w, "bad6", { id: "bad6", op: "rename", args: {} });
  await w.clock.advance(POLL_MS);
  for (const id of ["bad1", "bad2", "bad3", "bad4", "bad5", "bad6"]) {
    expect(response(w, id)?.ok).toBe(false);
    expect(w.files.has(`${DIR}/requests/${id}.json`)).toBe(false);
  }
  expect(String(response(w, "bad4")?.error)).toContain("unknown op");
  // The queue still works afterwards.
  request(w, "ok1", { id: "ok1", op: "usage" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "ok1")?.ok).toBe(true);
});

test("a request whose id is not a safe file name is ignored", async ($, on) => {
  const w = world(on);
  await start($);
  for (const id of ["a b", "..x", "x.y", "a".repeat(65)]) request(w, id, { id, op: "usage" });
  w.files.set(`${DIR}/requests/note.txt`, "{}");
  await w.clock.advance(POLL_MS);
  expect([...w.files.keys()].filter(path => path.includes("/responses/"))).toEqual([]);
});

// The session a window runs can change after the process started (a resume or /clear inside the window):
// the engine fires no second session.start for it, so the module follows `$.session.id()` as it polls.
const SWITCHED = "sess-2";
const SWITCHED_DIR = `${HOME}/.agent-rig/sessions/${SWITCHED}`;
const requestIn = (w: World, dir: string, id: string, body: unknown) => w.files.set(`${dir}/requests/${id}.json`, JSON.stringify(body));

test("after the session changes inside the window, requests come from the new session's directory and usage is written there", async ($, on) => {
  const w = world(on);
  await start($);
  expect(w.files.has(`${DIR}/usage.json`)).toBe(true);
  w.sessionId = SWITCHED;
  requestIn(w, SWITCHED_DIR, "c1", { id: "c1", op: "compact" });
  requestIn(w, SWITCHED_DIR, "u1", { id: "u1", op: "usage" });
  await w.clock.advance(POLL_MS);
  expect(w.files.has(`${SWITCHED_DIR}/usage.json`)).toBe(true);
  expect(w.compactions.length).toBe(1);
  expect(JSON.parse(w.files.get(`${SWITCHED_DIR}/responses/c1.json`) ?? "null")?.ok).toBe(true);
  expect(JSON.parse(w.files.get(`${SWITCHED_DIR}/responses/u1.json`) ?? "null")?.ok).toBe(true);
  expect(w.files.has(`${SWITCHED_DIR}/requests/c1.json`)).toBe(false);
  // Nothing of the new session is written under the old one.
  expect([...w.files.keys()].filter(path => path.startsWith(`${DIR}/`))).toEqual([`${DIR}/usage.json`]);
  // A later measurement lands in the new directory too.
  const before = w.files.get(`${SWITCHED_DIR}/usage.json`);
  await $.session.measure({ context: { tokens: 9, window: WINDOW }, rateLimits: [{ kind: "seven_day", percentUsed: 42 }], changed: ["rateLimits"] });
  await w.clock.settle();
  expect(w.files.get(`${SWITCHED_DIR}/usage.json`)).not.toBe(before);
});

test("a request claimed before the session changed is still answered in the directory it came from", async ($, on) => {
  const w = world(on);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  await start($);
  await $.turn.start({ text: "hi", turnId: "t1" });
  request(w, "c1", { id: "c1", op: "compact" });
  await w.clock.advance(POLL_MS);
  expect(w.files.get(`${DIR}/claims/c1/state`)).toBe("waiting");
  w.sessionId = SWITCHED;
  await w.clock.advance(POLL_MS);
  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
  await w.clock.advance(POLL_MS);
  expect(JSON.parse(w.files.get(`${DIR}/responses/c1.json`) ?? "null")?.ok).toBe(true);
  expect(w.files.has(`${DIR}/requests/c1.json`)).toBe(false);
  expect(w.files.has(`${SWITCHED_DIR}/responses/c1.json`)).toBe(false);
});

test("a session id that is not usable switches the window off until a usable one returns", async ($, on) => {
  const w = world(on);
  await start($);
  w.sessionId = "bad id";
  request(w, "u1", { id: "u1", op: "usage" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "u1")).toBeUndefined();
  w.sessionId = SESSION;
  await w.clock.advance(POLL_MS);
  expect(response(w, "u1")?.ok).toBe(true);
});

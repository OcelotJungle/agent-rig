// Two windows (two Claude processes with one session id) over one request folder. Run with
// `claude plugin test plugins/agent-rig-window`; no engine is involved, the Deps are a map of files.
import { expect, test } from "claude-code/testing";

import type { Deps } from "./window";

import { Window } from "./window";

const DIR = "/home/tester/.agent-rig/sessions/sess-1";
const TOKENS = 1;
const PID = 4242;

type Shared = { files: Map<string, string>; dirs: Set<string>; writes: string[]; states: string[]; now: number };

const shared = (): Shared => ({ files: new Map(), dirs: new Set(), writes: [], states: [], now: 1_000_000 });

// One process's view of the shared folder; `ran` records what this process executed.
function process(s: Shared, ran: string[], dirOf: () => string = () => DIR): Deps {
  return {
    list: async dir => [...s.files.keys()].filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")).map(path => path.slice(dir.length + 1)),
    read: async path => s.files.get(path),
    writeAtomic: async (path, text) => {
      s.files.set(path, text);
      s.writes.push(path);
      if (path.endsWith("/state")) s.states.push(`${path.split("/").slice(-2)[0]}:${text}`);
    },
    remove: async path => {
      s.files.delete(path);
    },
    // mkdir: atomic, fails on an existing directory.
    claim: async dir => {
      if (s.dirs.has(dir)) return false;
      s.dirs.add(dir);
      return true;
    },
    removeTree: async dir => {
      s.dirs.delete(dir);
      for (const path of [...s.files.keys()]) if (path.startsWith(`${dir}/`)) s.files.delete(path);
    },
    usage: async () => ({ context: { tokens: TOKENS, window: 10 }, rateLimits: [] }),
    compact: async () => {
      ran.push("compact");
      return { tokensBefore: 2, tokensAfter: 1 };
    },
    rename: async name => void ran.push(`rename:${name}`),
    autocompact: async () => {
      ran.push("autocompact");
      return undefined;
    },
    prompt: async text => {
      ran.push(`prompt:${text}`);
      return {};
    },
    now: () => s.now,
    pid: PID,
    sessionDir: async () => dirOf(),
  };
}

const put = (s: Shared, id: string, body: unknown) => s.files.set(`${DIR}/requests/${id}.json`, JSON.stringify(body));
const answers = (s: Shared) => s.writes.filter(path => path.includes("/responses/"));

test("one request is run once and answered once by two windows on one folder", async () => {
  const s = shared();
  const ranA: string[] = [];
  const ranB: string[] = [];
  const a = new Window(process(s, ranA));
  const b = new Window(process(s, ranB));
  put(s, "c1", { id: "c1", op: "compact" });
  put(s, "r1", { id: "r1", op: "rename", args: { name: "x" } });
  put(s, "u1", { id: "u1", op: "usage" });
  await Promise.all([a.poll(), b.poll()]);
  await Promise.all([a.poll(), b.poll()]);
  expect([...ranA, ...ranB].sort()).toEqual(["compact", "rename:x"]);
  expect(answers(s).sort()).toEqual([`${DIR}/responses/c1.json`, `${DIR}/responses/r1.json`, `${DIR}/responses/u1.json`]);
  expect(JSON.parse(s.files.get(`${DIR}/responses/c1.json`) ?? "null").ok).toBe(true);
  // Both windows are silent afterwards: no request comes back.
  await Promise.all([a.poll(), b.poll()]);
  expect(answers(s)).toHaveLength(3);
});

test("only a completed main conversation compaction rewrites usage with its live breakdown", async () => {
  const s = shared();
  const deps = process(s, []);
  deps.usage = async () => ({ context: { window: 10, breakdown: { totalTokens: 13_000 } }, rateLimits: [] });
  const w = new Window(deps);

  await w.compacted("manual", undefined, false);
  const snapshot = JSON.parse(s.files.get(`${DIR}/usage.json`) ?? "null");
  expect(snapshot.context).toEqual({ window: 10, breakdown: { totalTokens: 13_000 } });
  expect(s.writes.filter(path => path === `${DIR}/usage.json`)).toHaveLength(1);

  await w.compacted("auto", "agent-1", false);
  await w.compacted("precompute", undefined, false);
  await w.compacted("plugin", undefined, true);
  expect(s.writes.filter(path => path === `${DIR}/usage.json`)).toHaveLength(1);
});

test("a queued post-compaction snapshot reads after an earlier measurement and stays newest", async () => {
  const s = shared();
  const deps = process(s, []);
  let release: (() => void) | undefined;
  const earlierRead = new Promise<void>(resolve => {
    release = resolve;
  });
  let reads = 0;
  let compacted = false;
  deps.usage = async () => {
    reads++;
    if (reads === 1) {
      await earlierRead;
      return { context: { window: 10, breakdown: { totalTokens: 20_000 } }, rateLimits: [] };
    }
    return {
      context: compacted ? { window: 10, breakdown: { totalTokens: 13_000 } } : { window: 10 },
      rateLimits: [],
    };
  };
  const w = new Window(deps);
  const earlier = w.measured();
  compacted = true;
  const later = w.compacted("manual", undefined, false);

  await flush();
  expect(reads).toBe(1);
  release?.();
  await Promise.all([earlier, later]);

  expect(reads).toBe(2);
  expect(JSON.parse(s.files.get(`${DIR}/usage.json`) ?? "null").context).toEqual({
    window: 10,
    breakdown: { totalTokens: 13_000 },
  });
});

test("a compact request rewrites usage after compaction and before its response, but skip does not", async () => {
  const s = shared();
  const deps = process(s, []);
  let compacted = false;
  deps.usage = async () => ({
    context: compacted ? { window: 10, breakdown: { totalTokens: 13_000 } } : { tokens: TOKENS, window: 10 },
    rateLimits: [],
  });
  deps.compact = async () => {
    compacted = true;
    return { tokensBefore: 20_000, tokensAfter: 13_000 };
  };
  const w = new Window(deps);
  put(s, "c1", { id: "c1", op: "compact" });
  await w.poll();
  await flush();

  const usagePath = `${DIR}/usage.json`;
  const responsePath = `${DIR}/responses/c1.json`;
  expect(JSON.parse(s.files.get(usagePath) ?? "null").context).toEqual({ window: 10, breakdown: { totalTokens: 13_000 } });
  expect(s.writes.indexOf(usagePath)).toBeLessThan(s.writes.indexOf(responsePath));
  expect(s.writes.filter(path => path === usagePath)).toHaveLength(1);

  const skipped = shared();
  const skippedDeps = process(skipped, []);
  skippedDeps.compact = async () => ({ skip: "vetoed" });
  const skippedWindow = new Window(skippedDeps);
  put(skipped, "c2", { id: "c2", op: "compact" });
  await skippedWindow.poll();
  await flush();
  expect(skipped.writes.filter(path => path === usagePath)).toHaveLength(0);
  expect(skipped.writes.indexOf(`${DIR}/responses/c2.json`)).toBeGreaterThanOrEqual(0);
});

test("a claimed request records the claimant pid, and a window forgets ids answered by the other", async () => {
  const s = shared();
  const a = new Window(process(s, []));
  const b = new Window(process(s, []));
  a.turn(true);
  b.turn(true);
  put(s, "c1", { id: "c1", op: "compact" });
  await a.poll();
  await b.poll();
  expect(s.files.get(`${DIR}/claims/c1/pid`)).toBe(String(PID));
  await a.poll();
  expect(s.files.get(`${DIR}/claims/c1/pid`)).toBe(String(PID));
  a.turn(false);
  await a.poll();
  await flush();
  expect(s.files.has(`${DIR}/responses/c1.json`)).toBe(true);
});

test("a request answered and removed before the late window claims it is not run again", async () => {
  const s = shared();
  const ran: string[] = [];
  put(s, "c1", { id: "c1", op: "compact" });
  // The window listed the request, then rig removed the request and the claim; the claim is free again.
  const deps = process(s, ran);
  const list = deps.list;
  deps.list = async dir => {
    const names = await list(dir);
    s.files.delete(`${DIR}/requests/c1.json`);
    return names;
  };
  const w = new Window(deps);
  await w.poll();
  expect(ran).toEqual([]);
  expect(s.dirs.has(`${DIR}/claims/c1`)).toBe(false);
});

// Lets the chained promises of a window settle without a real wait.
const MICROTASK_ROUNDS = 20;
const flush = async () => {
  for (let i = 0; i < MICROTASK_ROUNDS; i++) await Promise.resolve();
};

test("a request during a turn writes waiting, then running once the turn ends", async () => {
  const s = shared();
  const w = new Window(process(s, []));
  w.turn(true);
  put(s, "c1", { id: "c1", op: "compact" });
  await w.poll();
  await flush();
  expect(s.states).toEqual(["c1:waiting"]);
  w.turn(false);
  await flush();
  expect(s.states).toEqual(["c1:waiting", "c1:running"]);
  expect(s.files.has(`${DIR}/responses/c1.json`)).toBe(true);
});

test("a request with no turn running writes only running, and immediate ops write nothing", async () => {
  const s = shared();
  const w = new Window(process(s, []));
  put(s, "c1", { id: "c1", op: "compact" });
  put(s, "u1", { id: "u1", op: "usage" });
  put(s, "m1", { id: "m1", op: "mode", args: { mode: "plan" } });
  await w.poll();
  await flush();
  expect(s.states).toEqual(["c1:running"]);
});

test("a second request queued behind a running first writes waiting, then running", async () => {
  const s = shared();
  const deps = process(s, []);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  deps.compact = async () => {
    await gate;
    return { tokensBefore: 2, tokensAfter: 1 };
  };
  const w = new Window(deps);
  put(s, "c1", { id: "c1", op: "compact" });
  put(s, "r1", { id: "r1", op: "rename", args: { name: "x" } });
  await w.poll();
  await flush();
  expect(s.states).toEqual(["c1:running", "r1:waiting"]);
  release();
  await flush();
  expect(s.states).toEqual(["c1:running", "r1:waiting", "r1:running"]);
});

test("a rejected compaction goes back to waiting and is not rewritten while it stays so", async () => {
  const s = shared();
  const deps = process(s, []);
  let rejects = 1;
  deps.compact = async () => {
    if (rejects-- > 0) throw new Error("a turn is running");
    return { tokensBefore: 2, tokensAfter: 1 };
  };
  const w = new Window(deps);
  put(s, "c1", { id: "c1", op: "compact" });
  await w.poll();
  await flush();
  expect(s.states).toEqual(["c1:running", "c1:waiting"]);
  await w.poll();
  await flush();
  expect(s.states).toEqual(["c1:running", "c1:waiting", "c1:running"]);
});

const MULTILINE_TEXT = "  Continue \"the task\" \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c: 100% & done!\nsecond line  ";

test("a prompt request submits the exact text once and answers ok", async () => {
  const s = shared();
  const ran: string[] = [];
  const w = new Window(process(s, ran));
  put(s, "p1", { id: "p1", op: "prompt", args: { text: MULTILINE_TEXT } });
  await w.poll();
  await flush();
  await w.poll();
  await flush();
  expect(ran).toEqual([`prompt:${MULTILINE_TEXT}`]);
  expect(JSON.parse(s.files.get(`${DIR}/responses/p1.json`) ?? "null")).toEqual({ id: "p1", ok: true, result: {} });
  expect(s.files.has(`${DIR}/requests/p1.json`)).toBe(false);
});

test("a prompt request with no text is an error answer and submits nothing", async () => {
  const s = shared();
  const ran: string[] = [];
  const w = new Window(process(s, ran));
  const bad: unknown[] = [undefined, "", "  \n ", 5, null, ["x"]];
  bad.forEach((text, i) => put(s, `b${i}`, { id: `b${i}`, op: "prompt", args: { text } }));
  put(s, "b-none", { id: "b-none", op: "prompt" });
  await w.poll();
  await flush();
  expect(ran).toEqual([]);
  for (const id of ["b0", "b1", "b2", "b3", "b4", "b5", "b-none"]) {
    const answer = JSON.parse(s.files.get(`${DIR}/responses/${id}.json`) ?? "null");
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("args.text");
  }
});

test("a prompt request waits for the turn to end, then submits", async () => {
  const s = shared();
  const ran: string[] = [];
  const w = new Window(process(s, ran));
  w.turn(true);
  put(s, "p1", { id: "p1", op: "prompt", args: { text: "go on" } });
  await w.poll();
  await flush();
  expect(ran).toEqual([]);
  expect(s.states).toEqual(["p1:waiting"]);
  expect(s.files.has(`${DIR}/responses/p1.json`)).toBe(false);
  w.turn(false);
  await flush();
  expect(ran).toEqual(["prompt:go on"]);
  expect(s.states).toEqual(["p1:waiting", "p1:running"]);
  expect(JSON.parse(s.files.get(`${DIR}/responses/p1.json`) ?? "null").ok).toBe(true);
});

test("a claimed prompt whose sender withdrew it while a turn ran is never submitted, never answered, and its claim is removed", async () => {
  const s = shared();
  const ran: string[] = [];
  const w = new Window(process(s, ran));
  w.turn(true);
  put(s, "p1", { id: "p1", op: "prompt", args: { text: "go on" } });
  await w.poll();
  await flush();
  expect(s.states).toEqual(["p1:waiting"]);
  // rig's deadline withdraws the request and removes its claim; the module still holds the id in its queue.
  s.files.delete(`${DIR}/requests/p1.json`);
  w.turn(false);
  await flush();
  expect(ran).toEqual([]);
  expect(answers(s)).toEqual([]);
  expect(s.dirs.has(`${DIR}/claims/p1`)).toBe(false);
  expect([...s.files.keys()].filter(path => path.includes("/claims/p1"))).toEqual([]);
  // The next request is served: a dropped head does not block the queue.
  put(s, "p2", { id: "p2", op: "prompt", args: { text: "next" } });
  await w.poll();
  await flush();
  expect(ran).toEqual(["prompt:next"]);
});

test("a prompt a hook refused, or a submit that fails, is an error answer and is not submitted again", async () => {
  const s = shared();
  const deps = process(s, []);
  let calls = 0;
  deps.prompt = async () => {
    calls++;
    if (calls === 1) return { drop: "blocked by a hook" };
    throw new Error("no session");
  };
  const w = new Window(deps);
  put(s, "p1", { id: "p1", op: "prompt", args: { text: "one" } });
  put(s, "p2", { id: "p2", op: "prompt", args: { text: "two" } });
  await w.poll();
  await flush();
  await w.poll();
  await flush();
  expect(calls).toBe(2);
  const first = JSON.parse(s.files.get(`${DIR}/responses/p1.json`) ?? "null");
  expect(first.ok).toBe(false);
  expect(first.error).toContain("blocked by a hook");
  const second = JSON.parse(s.files.get(`${DIR}/responses/p2.json`) ?? "null");
  expect(second.ok).toBe(false);
  expect(second.error).toContain("no session");
});

test("when the session changes, a claimed request is answered in its own directory, an unclaimed one of the old session is left, and the new directory is served", async () => {
  const OTHER = "/home/tester/.agent-rig/sessions/sess-2";
  const s = shared();
  let current = DIR;
  const deps = process(s, [], () => current);
  let rejects = 1;
  deps.compact = async () => {
    if (rejects-- > 0) throw new Error("a turn is running");
    return { tokensBefore: 2, tokensAfter: 1 };
  };
  const w = new Window(deps);
  await w.measured();
  put(s, "c1", { id: "c1", op: "compact" });
  await w.poll();
  await flush();
  // c1 is claimed and waits for a retry; a request left unclaimed in the old directory after the switch is not served.
  current = OTHER;
  s.files.set(`${DIR}/requests/late.json`, JSON.stringify({ id: "late", op: "usage" }));
  s.files.set(`${OTHER}/requests/n1.json`, JSON.stringify({ id: "n1", op: "usage" }));
  await w.poll();
  await flush();
  expect(s.files.has(`${OTHER}/usage.json`)).toBe(true);
  expect(s.files.has(`${OTHER}/responses/n1.json`)).toBe(true);
  expect(s.files.has(`${DIR}/responses/late.json`)).toBe(false);
  expect(s.files.has(`${DIR}/responses/c1.json`)).toBe(true);
  expect(s.files.has(`${OTHER}/responses/c1.json`)).toBe(false);
  expect(s.files.has(`${DIR}/requests/c1.json`)).toBe(false);
});

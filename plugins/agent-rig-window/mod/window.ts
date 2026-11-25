// What the window does with the session's files: snapshots of usage and a request queue. The module runs inside
// Claude Code with no Node, so everything outside comes in as Deps (the engine's `$` calls, wired in register.ts).
import type { Request, Response, Usage, UsageSnapshot } from "./protocol";

import { CLAIM_PID_FILE, CLAIM_STATE_FILE, CLAIM_STATE_RUNNING, CLAIM_STATE_WAITING, CLAIMS_DIR, errorText, idOfFile, parseRequest, responseText } from "./protocol";

const REQUESTS_DIR = "requests";
const RESPONSES_DIR = "responses";
const USAGE_FILE = "usage.json";
const RESPONSE_SUFFIX = ".json";
// Polls in a row on which a compaction failed with no turn running before the failure is answered:
// a turn may start just as it is tried (the same rule the telegram hub's module uses).
const COMPACT_TRIES = 3;
const MODE_UNAVAILABLE = "the permission mode is not exposed by the engine API";

// The part of the engine's session.compact result the answer needs.
export type Compaction = { skip?: string; tokensBefore?: number; tokensAfter?: number };

export type Deps = {
  // The directory of the session the window runs now (`<home>/.agent-rig/sessions/<id>`), read when it is used:
  // a process can change its session (resume, /clear) after start. undefined when there is no usable session id.
  sessionDir(): Promise<string | undefined>;
  // File names in the directory; empty when it is missing.
  list(dir: string): Promise<string[]>;
  // The file's text; undefined when it cannot be read.
  read(path: string): Promise<string | undefined>;
  // Writes the file whole or not at all, creating directories.
  writeAtomic(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  // Takes the claim directory: true for the one caller that made it, false when it already exists (any other
  // refusal rejects). The step is atomic across processes: it is what makes one request run in one process.
  claim(dir: string): Promise<boolean>;
  removeTree(dir: string): Promise<void>;
  usage(): Promise<Usage>;
  // Compacts the conversation; rejects while a turn runs.
  compact(instructions: string | undefined): Promise<Compaction>;
  // Runs the session's own /rename; the engine queues it until the session is idle.
  rename(name: string): Promise<void>;
  // Runs the session's own /autocompact with the window (a number or "auto"); resolves to the command's text, if any.
  autocompact(window: number | "auto"): Promise<string | undefined>;
  // Submits a prompt as the session's own turn (the engine's prompt.submit, the call it makes for a typed prompt);
  // resolves once the prompt entered or was queued, not when its turn ends. `drop` is the reason a hook refused it.
  prompt(text: string): Promise<{ drop?: string }>;
  now(): number;
  // This process's Claude pid, when it is known.
  readonly pid: number | undefined;
};

// A claimed request keeps the directory it was claimed in: it is answered there even if the session changed since.
type Pending = { request: Request; dir: string; failed: number };

export class Window {
  // Ids picked up and not yet answered and removed: a request is handled once.
  private seen = new Set<string>();
  // Ids this window claimed and has not answered, with the session directory each was claimed in: they are not
  // forgotten while the request file stays.
  private claimed = new Map<string, string>();
  private pending: Pending[] = [];
  // The last state written for each claimed id, so a state is written only when it changes.
  private states = new Map<string, string>();
  private polling = false;
  private working = false;
  private turnRuns = false;
  private rateLimits: Usage["rateLimits"] | undefined;
  private snapshotWrites: Promise<void> = Promise.resolve();
  // The session directory the window serves now; follows deps.sessionDir() (see sync).
  private dir: string | undefined;
  // Whether sync has read the session once: the first read is not a change of session.
  private known = false;

  constructor(private deps: Deps) {}

  // Called at session start and from the session.measure hook; `rateLimits` is the measure event's reading.
  measured(rateLimits?: Usage["rateLimits"]): Promise<void> {
    if (rateLimits !== undefined) this.rateLimits = rateLimits;
    this.snapshotWrites = this.snapshotWrites.then(async () => {
      const dir = await this.sync();
      if (dir !== undefined) await this.deps.writeAtomic(`${dir}/${USAGE_FILE}`, JSON.stringify(await this.snapshot()));
    }).catch(() => {
      // The files are not writable now: the next measurement tries again.
    });
    return this.snapshotWrites;
  }

  // Rewrites usage only after a completed compaction of the main conversation; precompute does not change it.
  async compacted(trigger: "manual" | "auto" | "plugin" | "precompute", agentId: string | undefined, skipped: boolean): Promise<void> {
    if (agentId === undefined && trigger !== "precompute" && !skipped) await this.measured();
  }

  // Called from the turn hooks of the main loop.
  turn(runs: boolean): void {
    this.turnRuns = runs;
    if (!runs) void this.work();
  }

  // Called by the module's timer: picks up the requests that arrived and answers those that need no idle session.
  async poll(): Promise<void> {
    void this.work();
    if (this.polling) return;
    this.polling = true;
    try {
      const known = this.known;
      const before = this.dir;
      const dir = await this.sync();
      // The session changed: its usage is written in the new directory at once, not at the next measurement.
      // (The first directory the window learns is not a change: measured() at start writes it.)
      if (known && dir !== before) await this.measured();
      if (dir === undefined) return;
      const names = await this.deps.list(`${dir}/${REQUESTS_DIR}`);
      const listed = new Set<string>();
      for (const name of [...names].sort()) {
        const id = idOfFile(name);
        if (id === undefined) continue;
        listed.add(id);
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        await this.intake(dir, id);
      }
      // An id whose request is gone (another window answered it) is forgotten.
      for (const id of this.seen) if (!listed.has(id) && !this.claimed.has(id)) this.seen.delete(id);
    } catch {
      // The directory cannot be read now: the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  // Moves the window to the session the process runs now. What belonged to the previous session (the ids seen in
  // its request folder) is dropped; a request already claimed stays in the work lists with its own directory and is
  // answered there. Process-wide state (a running turn, the account's rate limits) is not the session's and stays.
  private async sync(): Promise<string | undefined> {
    const dir = await this.deps.sessionDir();
    this.known = true;
    if (dir !== this.dir) {
      this.dir = dir;
      this.seen = new Set(this.claimed.keys());
    }
    return dir;
  }

  private async snapshot(): Promise<UsageSnapshot> {
    const usage = await this.deps.usage();
    const snapshot: UsageSnapshot = {
      at: new Date(this.deps.now()).toISOString(),
      context: usage.context,
      rateLimits: this.rateLimits ?? usage.rateLimits,
    };
    if (usage.cost !== undefined) snapshot.cost = usage.cost;
    return snapshot;
  }

  // Records which process holds the claim: rig tells a dead claimant from the identity of this pid. Without a known
  // pid nothing is written, and rig waits for the request's own timeout.
  private async recordPid(dir: string, id: string): Promise<void> {
    const pid = this.deps.pid;
    if (pid === undefined) return;
    try {
      await this.deps.writeAtomic(`${dir}/${CLAIMS_DIR}/${id}/${CLAIM_PID_FILE}`, String(pid));
    } catch {
      // The claim stays without a pid: rig waits for the request's own timeout.
    }
  }

  // Writes claims/<id>/state when the state changes: rig reports progress from it (waiting for the turn, running).
  private async recordState(dir: string, id: string, state: string): Promise<void> {
    if (this.states.get(id) === state) return;
    this.states.set(id, state);
    try {
      await this.deps.writeAtomic(`${dir}/${CLAIMS_DIR}/${id}/${CLAIM_STATE_FILE}`, state);
    } catch {
      // Like the pid file, the state is advisory: without it rig reports no progress, and the request is unaffected.
    }
  }

  // One request, one executor: the window that makes the claim directory runs and answers the request; another
  // process with the same session id (a second window, `claude -p --resume`) finds the claim taken and skips it.
  private async intake(dir: string, id: string): Promise<void> {
    const claimDir = `${dir}/${CLAIMS_DIR}/${id}`;
    try {
      if (!(await this.deps.claim(claimDir))) return;
    } catch {
      // The claim could not be tried: the next poll tries again.
      this.seen.delete(id);
      return;
    }
    await this.recordPid(dir, id);
    // Read after the claim: a request already answered and removed (rig then removes its claim) is not run again.
    const text = await this.deps.read(`${dir}/${REQUESTS_DIR}/${id}.json`);
    if (text === undefined) {
      await this.deps.removeTree(claimDir).catch(() => undefined);
      this.seen.delete(id);
      return;
    }
    this.claimed.set(id, dir);
    const parsed = parseRequest(id, text);
    if (!parsed.ok) return this.answer(dir, { id, ok: false, error: parsed.error });
    const request = parsed.value;
    // The read-only ops answer at once; compact, rename, autocompact and prompt wait for the turn to end.
    if (request.op === "usage") {
      try {
        return await this.answer(dir, { id, ok: true, result: await this.snapshot() });
      } catch (e) {
        return this.answer(dir, { id, ok: false, error: errorText(e) });
      }
    }
    if (request.op === "mode") return this.answer(dir, { id, ok: false, error: MODE_UNAVAILABLE });
    // A request that cannot start in this pass (a turn runs, or another request is ahead of it) is marked waiting; one
    // that work() starts at once is never marked.
    const blocked = this.turnRuns || this.pending.length > 0;
    this.pending.push({ request, dir, failed: 0 });
    if (blocked) await this.recordState(dir, id, CLAIM_STATE_WAITING);
    void this.work();
  }

  // The turn-gated requests, oldest first, one at a time, each once no turn runs.
  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let head = this.pending[0]; head && !this.turnRuns; head = this.pending[0]) {
        await this.recordState(head.dir, head.request.id, CLAIM_STATE_RUNNING);
        // rig's deadline removes the request file first and reads this state after. So after `running` is written the
        // request is checked again: if it is gone, rig has withdrawn it (and said "not run"), and it is dropped here;
        // if it is still there, rig reads `running` and says "may still complete". The two never disagree.
        if ((await this.deps.read(`${head.dir}/${REQUESTS_DIR}/${head.request.id}.json`)) === undefined) {
          await this.drop(head);
          continue;
        }
        const outcome = await this.run(head);
        if (outcome === undefined) {
          // Rejected (a turn runs or just started): it waits for a later try.
          await this.recordState(head.dir, head.request.id, CLAIM_STATE_WAITING);
          return;
        }
        this.pending.shift();
        await this.answer(head.dir, outcome);
      }
    } finally {
      this.working = false;
    }
  }

  // A request its sender withdrew: nothing runs and nothing is answered, and every trace of it (the lists, the claim
  // directory, the state just written) goes.
  private async drop(head: Pending): Promise<void> {
    const { id } = head.request;
    this.pending.shift();
    this.seen.delete(id);
    this.claimed.delete(id);
    this.states.delete(id);
    await this.deps.removeTree(`${head.dir}/${CLAIMS_DIR}/${id}`).catch(() => undefined);
  }

  // undefined: not done, tried again at the next poll.
  private async run(head: Pending): Promise<Response | undefined> {
    const { request } = head;
    try {
      if (request.op === "rename") {
        const name = typeof request.args.name === "string" ? request.args.name.replace(/\s+/g, " ").trim() : "";
        if (name === "") return { id: request.id, ok: false, error: "args.name must be a non-empty string" };
        await this.deps.rename(name);
        return { id: request.id, ok: true, result: { name } };
      }
      if (request.op === "prompt") {
        // The text goes as given: no trimming, so the turn starts with exactly what rig sent.
        const text = request.args.text;
        if (typeof text !== "string" || text.trim() === "") return { id: request.id, ok: false, error: "args.text must be a non-empty string" };
        const submitted = await this.deps.prompt(text);
        // A hook refused the prompt: it never entered, so the sender is told rather than shown a success.
        if (submitted.drop !== undefined) return { id: request.id, ok: false, error: `the prompt was refused: ${submitted.drop}` };
        return { id: request.id, ok: true, result: {} };
      }
      if (request.op === "autocompact") {
        const window = request.args.window;
        if (window !== "auto" && !(typeof window === "number" && Number.isSafeInteger(window) && window > 0)) {
          return { id: request.id, ok: false, error: 'args.window must be a positive integer or "auto"' };
        }
        const text = (await this.deps.autocompact(window))?.trim();
        return { id: request.id, ok: true, result: text ? { window, text } : { window } };
      }
      const instructions = typeof request.args.instructions === "string" ? request.args.instructions : undefined;
      const compaction = await this.deps.compact(instructions);
      if (compaction.skip === undefined) await this.measured();
      return { id: request.id, ok: true, result: compaction };
    } catch (e) {
      // Rejected with a turn running, or one just starting: tried again.
      if (request.op === "compact" && (this.turnRuns || ++head.failed < COMPACT_TRIES)) return undefined;
      return { id: request.id, ok: false, error: errorText(e) };
    }
  }

  // Writes the response, then removes the request; an id whose request could not be removed stays seen.
  private async answer(dir: string, response: Response): Promise<void> {
    try {
      await this.deps.writeAtomic(`${dir}/${RESPONSES_DIR}/${response.id}${RESPONSE_SUFFIX}`, responseText(response));
      await this.deps.remove(`${dir}/${REQUESTS_DIR}/${response.id}.json`);
      this.seen.delete(response.id);
      this.claimed.delete(response.id);
      this.states.delete(response.id);
    } catch {
      // The answer is not written or the request not removed: the id stays seen, so it is not run twice.
    }
  }
}

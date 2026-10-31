import type { LockDependencies, LockHandle } from "../src/lock.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";
import { TAKEOVER_STALE_MS, acquireLock, tryAcquireLock } from "../src/lock.js";
import { err, ok } from "../src/result.js";
import { MemoryFileSystem } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const LOCK_PATH = "/home/test/.agent-rig/rig.lock";
const POLL_INTERVAL_MS = 1;
const DEAD_PID = 55;
const DEAD_START = 100;
const FIRST_PID = 11;
const FIRST_START = 101;
const SECOND_PID = 22;
const SECOND_START = 202;
const UNKNOWN_ANSWERS_BEFORE_DEAD = 2;
const HOLD_TURNS = 5;
const TAKEOVER_PATH = `${LOCK_PATH}.takeover`;
const WAIT_POLLS_BEFORE_RELEASE = 3;
const ignoreNotice = (): void => undefined;

// Runs a callback right before the first destructive step on the lock file, so a test can place another process exactly
// between "this process decided the lock is stale" and "this process removes it".
class InterleavingFileSystem extends MemoryFileSystem {
	interleave: (() => Promise<void>) | null = null;

	override async rename(from: string, to: string): Promise<void> {
		await this.fire(from);
		return super.rename(from, to);
	}

	override async remove(path: string): Promise<void> {
		await this.fire(path);
		return super.remove(path);
	}

	private async fire(path: string): Promise<void> {
		if (path !== LOCK_PATH || this.interleave === null) return;
		const run = this.interleave;
		this.interleave = null;
		await run();
	}
}

const dependenciesFor = (
	fs: MemoryFileSystem,
	pid: number,
	startTime: number,
	ownerStartTime: (pid: number) => Promise<Result<number | null>>,
	sleep: () => Promise<void> = async () => undefined,
	now: () => number = () => 0,
): LockDependencies => ({
	fs,
	home: HOME,
	process: { pid, startTime, ownerStartTime },
	clock: { sleep, now },
	pollIntervalMs: POLL_INTERVAL_MS,
});

const liveOwners = (alive: Map<number, number>) => async (pid: number): Promise<Result<number | null>> => ok(alive.get(pid) ?? null);

describe("lock takeover of a stale lock", () => {
	test("two waiters on one stale lock produce exactly one owner at a time", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const alive = new Map([[FIRST_PID, FIRST_START], [SECOND_PID, SECOND_START]]);
		let holders = 0;
		let maxHolders = 0;
		let acquiredCount = 0;
		const yieldTurn = (): Promise<void> => Promise.resolve();
		const contender = async (pid: number, startTime: number): Promise<void> => {
			const result = await acquireLock(dependenciesFor(fs, pid, startTime, liveOwners(alive), yieldTurn), ignoreNotice);
			if (!result.ok) throw new Error(result.error);
			holders += 1;
			acquiredCount += 1;
			maxHolders = Math.max(maxHolders, holders);
			for (let turn = 0; turn < HOLD_TURNS; turn += 1) await yieldTurn();
			holders -= 1;
			await result.value.release();
		};

		await Promise.all([contender(FIRST_PID, FIRST_START), contender(SECOND_PID, SECOND_START)]);

		expect(acquiredCount).toBe(2);
		expect(maxHolders).toBe(1);
		expect(fs.files.has(LOCK_PATH)).toBe(false);
		expect(fs.files.has(TAKEOVER_PATH)).toBe(false);
	});

	test("while one process is deleting the stale lock another cannot touch the lock", async () => {
		const fs = new InterleavingFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const alive = new Map([[SECOND_PID, SECOND_START]]);
		const captured: { second: Result<LockHandle> | null } = { second: null };
		fs.interleave = async () => {
			captured.second = await acquireLock(dependenciesFor(fs, SECOND_PID, SECOND_START, liveOwners(alive), async () => { throw new Error("blocked by takeover"); }), ignoreNotice);
			expect(fs.files.has(TAKEOVER_PATH)).toBe(true);
		};

		const first = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(alive)), ignoreNotice);

		expect(first.ok).toBe(true);
		expect(captured.second !== null && !captured.second.ok).toBe(true);
		expect(fs.files.get(LOCK_PATH)).toBe(`${JSON.stringify({ pid: FIRST_PID, startTime: FIRST_START })}\n`);
		expect(fs.files.has(TAKEOVER_PATH)).toBe(false);
	});

	test("a takeover file left by a killed process does not block forever", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		fs.seed(TAKEOVER_PATH, "0");
		const now = TAKEOVER_STALE_MS + 1;

		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()), async () => undefined, () => now), ignoreNotice);

		expect(result.ok).toBe(true);
	});

	test("a fresh takeover file makes the waiter wait until it grows old", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let now = 0;
		fs.seed(TAKEOVER_PATH, String(now));
		let sleeps = 0;

		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()), async () => { sleeps += 1; now += TAKEOVER_STALE_MS / 2; }, () => now), ignoreNotice);

		expect(result.ok).toBe(true);
		expect(sleeps).toBeGreaterThanOrEqual(2);
	});

	test("a takeover is not blocked by a live lock and leaves no helper files", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), ignoreNotice);
		expect(result.ok).toBe(true);
		expect([...fs.files.keys()].sort()).toEqual([LOCK_PATH]);
	});
});

describe("lock when the owner cannot be inspected", () => {
	test("an unknown answer counts as running: the lock is kept and the caller waits", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let questions = 0;
		let sleeps = 0;
		const result = await acquireLock(dependenciesFor(
			fs,
			FIRST_PID,
			FIRST_START,
			async () => {
				questions += 1;
				return questions <= UNKNOWN_ANSWERS_BEFORE_DEAD ? err("powershell failed") : ok(null);
			},
			async () => { sleeps += 1; expect(fs.files.get(LOCK_PATH)).toContain(`"pid":${DEAD_PID}`); },
		), ignoreNotice);
		expect(result.ok).toBe(true);
		expect(sleeps).toBe(UNKNOWN_ANSWERS_BEFORE_DEAD);
	});

	test("a throwing inspector also counts as running", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, async () => { throw new Error("boom"); }));
		expect(result).toEqual(ok(null));
		expect(fs.files.has(LOCK_PATH)).toBe(true);
	});
});

describe("lock when waiting is not wanted", () => {
	test("tryAcquireLock returns null at once while a live owner holds the lock", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const result = await tryAcquireLock(dependenciesFor(
			fs,
			FIRST_PID,
			FIRST_START,
			liveOwners(new Map([[SECOND_PID, SECOND_START]])),
			async () => { throw new Error("must not wait"); },
		));
		expect(result).toEqual(ok(null));
	});

	test("tryAcquireLock takes a free lock", async () => {
		const fs = new MemoryFileSystem();
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())));
		expect(result.ok && result.value !== null).toBe(true);
	});
});

describe("lock file creation failure", () => {
	test("a failed exclusive write becomes an error result, not an exception", async () => {
		const fs = new MemoryFileSystem();
		fs.writeExclusive = async () => err("disk full");
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), ignoreNotice);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("disk full");
	});
});

describe("lock wait notice", () => {
	test("a busy lock calls the notice once, before the first wait, however many polls pass", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const timeline: string[] = [];
		let polls = 0;
		const result = await acquireLock(dependenciesFor(
			fs,
			FIRST_PID,
			FIRST_START,
			liveOwners(new Map([[SECOND_PID, SECOND_START]])),
			async () => {
				timeline.push("wait");
				polls += 1;
				if (polls === WAIT_POLLS_BEFORE_RELEASE) fs.files.delete(LOCK_PATH);
			},
		), () => { timeline.push("notice"); });

		expect(result.ok).toBe(true);
		expect(timeline).toEqual(["notice", "wait", "wait", "wait"]);
	});

	test("a free lock does not call the notice", async () => {
		const fs = new MemoryFileSystem();
		let notices = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), () => { notices += 1; });
		expect(result.ok).toBe(true);
		expect(notices).toBe(0);
	});

	test("a stale lock taken over at once does not call the notice", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let notices = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), () => { notices += 1; });
		expect(result.ok).toBe(true);
		expect(notices).toBe(0);
	});
});

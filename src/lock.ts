import type { FileSystem } from "./file-system.js";
import type { Result } from "./result.js";

import { joinPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";

export type LockOwner = { pid: number; startTime: number };
export type LockDependencies = {
	fs: FileSystem;
	home: string;
	lockPath?: string;
	process: {
		pid: number;
		startTime: number;
		// ok(number): start time of the running process; ok(null): no such process; err: could not find out.
		ownerStartTime(pid: number): Promise<Result<number | null>>;
	};
	clock: { sleep(milliseconds: number): Promise<void>; now(): number };
	pollIntervalMs: number;
};
export type LockHandle = { release(): Promise<Result<void>> };

const parseOwner = (text: string): LockOwner | null => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (!("pid" in value) || typeof value.pid !== "number" || !("startTime" in value) || typeof value.startTime !== "number") return null;
	return { pid: value.pid, startTime: value.startTime };
};

// Unknown counts as running: taking a live lock is worse than waiting a little longer.
const ownerMayBeRunning = async (owner: LockOwner, dependencies: LockDependencies): Promise<boolean> => {
	if (!Number.isInteger(owner.pid) || !Number.isFinite(owner.startTime)) return false;
	try {
		const start = await dependencies.process.ownerStartTime(owner.pid);
		if (!start.ok) return true;
		return start.value === owner.startTime;
	} catch {
		return true;
	}
};

const createHandle = (fs: FileSystem, lockPath: string, owner: LockOwner): LockHandle => {
	let released = false;
	return {
		release: async () => {
			if (released) return ok(undefined);
			try {
				const current = parseOwner(await fs.readText(lockPath));
				if (current?.pid === owner.pid && current.startTime === owner.startTime) await fs.remove(lockPath);
				released = true;
				return ok(undefined);
			} catch (error) {
				return err(`Could not release rig lock: ${errorText(error)}`);
			}
		},
	};
};

// A takeover takes milliseconds (one read and one delete). A takeover file older than this belongs to a process that was
// killed in the middle of it; 30 seconds is far above any real takeover and still unblocks waiters quickly.
export const TAKEOVER_STALE_MS = 30_000;

const takeoverPathOf = (lockPath: string): string => `${lockPath}.takeover`;

// Only the holder of the exclusively created takeover file may delete a stale lock. Under it the lock is read again and
// deleted only if its owner is still dead. Nobody else deletes a lock (a live owner releases its own, which a dead one
// cannot), and normal acquire only creates, so the lock cannot change between the check and the delete.
const takeOverStale = async (fs: FileSystem, lockPath: string, dependencies: LockDependencies): Promise<void> => {
	const takeoverPath = takeoverPathOf(lockPath);
	const stamp = String(dependencies.clock.now());
	const created = await fs.writeExclusive(takeoverPath, stamp);
	if (!created.ok || !created.value) {
		await clearDeadTakeover(fs, takeoverPath, dependencies);
		await dependencies.clock.sleep(dependencies.pollIntervalMs);
		return;
	}
	try {
		let current: LockOwner | null;
		try {
			current = parseOwner(await fs.readText(lockPath));
		} catch {
			return;
		}
		if (current !== null && !(await ownerMayBeRunning(current, dependencies))) await fs.remove(lockPath);
	} finally {
		await fs.remove(takeoverPath).catch(() => undefined);
	}
};

const clearDeadTakeover = async (fs: FileSystem, takeoverPath: string, dependencies: LockDependencies): Promise<void> => {
	try {
		const text = await fs.readText(takeoverPath);
		const startedAt = Number(text);
		const dead = !Number.isFinite(startedAt) || dependencies.clock.now() - startedAt > TAKEOVER_STALE_MS;
		// Only the file we judged dead is removed: a fresh one made by someone else in the meantime has other text.
		if (dead && (await fs.readText(takeoverPath)) === text) await fs.remove(takeoverPath);
	} catch {
		// Already gone or unreadable: the next round decides.
	}
};

// onWait is null when the caller does not wait: then a live owner means ok(null) at once.
const acquire = async (dependencies: LockDependencies, onWait: (() => void) | null): Promise<Result<LockHandle | null>> => {
	const fs = dependencies.fs;
	const lockPath = dependencies.lockPath ?? joinPath(dependencies.home, ".agent-rig", "rig.lock");
	try {
		await fs.ensureDirectory(joinPath(dependencies.home, ".agent-rig"));
		let announced = false;
		while (true) {
			const owner: LockOwner = { pid: dependencies.process.pid, startTime: dependencies.process.startTime };
			const created = await fs.writeExclusive(lockPath, `${JSON.stringify(owner)}\n`);
			if (!created.ok) return err(`Could not acquire rig lock: ${created.error}`);
			if (created.value) return ok(createHandle(fs, lockPath, owner));
			let existingText: string;
			try {
				existingText = await fs.readText(lockPath);
			} catch {
				continue;
			}
			const existing = parseOwner(existingText);
			if (existing === null) return err("rig.lock is malformed; remove it after confirming no rig process is running");
			if (await ownerMayBeRunning(existing, dependencies)) {
				if (onWait === null) return ok(null);
				if (!announced) {
					announced = true;
					onWait();
				}
				await dependencies.clock.sleep(dependencies.pollIntervalMs);
				continue;
			}
			await takeOverStale(fs, lockPath, dependencies);
		}
	} catch (error) {
		return err(`Could not acquire rig lock: ${errorText(error)}`);
	}
};

// onWait runs at most once, right before the first wait, and only when a live owner holds the lock.
export const acquireLock = async (dependencies: LockDependencies, onWait: () => void): Promise<Result<LockHandle>> => {
	const acquired = await acquire(dependencies, onWait);
	if (!acquired.ok) return acquired;
	return acquired.value === null ? err("Could not acquire rig lock: it is held by another process") : ok(acquired.value);
};

// Takes the lock only if it is free right now; ok(null) means another live process holds it.
export const tryAcquireLock = (dependencies: LockDependencies): Promise<Result<LockHandle | null>> => acquire(dependencies, null);

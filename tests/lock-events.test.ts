import type { EventDependencies } from "../src/events.js";
import type { FileSystem } from "../src/file-system.js";
import type { LockDependencies } from "../src/lock.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";
import { appendEvent, trimEvents } from "../src/events.js";
import { acquireLock } from "../src/lock.js";
import { ok } from "../src/result.js";

const TEST_EVENT_FILE_THRESHOLD_BYTES = 1024 * 1024;

class MemoryFileSystem implements FileSystem {
	readonly files = new Map<string, string>();
	readonly directories = new Set<string>();
	readonly unreadablePaths = new Set<string>();
	private sequence = 0;

	async readText(path: string): Promise<string> {
		if (this.unreadablePaths.has(path)) throw new Error("EACCES");
		const value = this.files.get(path);
		if (value === undefined) throw new Error("ENOENT");
		return value;
	}
	async writeText(path: string, value: string): Promise<void> { this.files.set(path, value); }
	async appendText(path: string, value: string): Promise<void> { this.files.set(path, (this.files.get(path) ?? "") + value); }
	async rename(from: string, to: string): Promise<void> {
		const value = this.files.get(from);
		if (value === undefined) throw new Error("ENOENT");
		this.files.set(to, value);
		this.files.delete(from);
	}
	async remove(path: string): Promise<void> { this.files.delete(path); }
	async ensureDirectory(path: string): Promise<void> { this.directories.add(path); }
	async writeExclusive(path: string, value: string): Promise<Result<boolean>> {
		if (this.files.has(path)) return ok(false);
		this.files.set(path, value);
		return ok(true);
	}
	async resolveTarget(path: string): Promise<string> { return path; }
	async modeOf(): Promise<number | null> { return null; }
	async writeDurable(path: string, value: string): Promise<void> { this.files.set(path, value); }
	async listDirectory(): Promise<Array<{ name: string; directory: boolean }>> { return []; }
	uniqueSuffix(): string { this.sequence += 1; return String(this.sequence); }
}

describe("lock", () => {
	test("waits until the first owner releases, and ignores a reused PID", async () => {
		const fs = new MemoryFileSystem();
		const makeDependencies = (pid: number, startTime: number, ownerStarts: Map<number, number>, onSleep: () => void): LockDependencies => ({
			fs,
			home: "/home/test",
				process: { pid, startTime, ownerStartTime: async (ownerPid) => ok(ownerStarts.get(ownerPid) ?? null) },
			clock: { sleep: async () => { onSleep(); }, now: () => Date.now() },
			pollIntervalMs: 5,
		});
		const starts = new Map([[11, 101]]);
		const first = await acquireLock(makeDependencies(11, 101, starts, () => undefined), () => undefined);
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		let waited = false;
		const secondPromise = acquireLock(makeDependencies(22, 202, starts, () => { waited = true; void first.value.release(); }), () => undefined);
		const second = await secondPromise;
		expect(waited).toBe(true);
		expect(second.ok).toBe(true);
		if (second.ok) await second.value.release();
	});

	test("takes over when a live PID belongs to a different process start", async () => {
		const fs = new MemoryFileSystem();
		const lockPath = "/home/test/.agent-rig/rig.lock";
		fs.files.set(lockPath, JSON.stringify({ pid: 55, startTime: 100 }));
		const result = await acquireLock({
			fs, home: "/home/test", process: { pid: 66, startTime: 200, ownerStartTime: async () => ok(999) },
			clock: { sleep: async () => undefined, now: () => Date.now() }, pollIntervalMs: 1,
		}, () => undefined);
		expect(result.ok).toBe(true);
		if (result.ok) await result.value.release();
	});

	test("takes over a lock from a dead process", async () => {
		const fs = new MemoryFileSystem();
		const lockPath = "/home/test/.agent-rig/rig.lock";
		fs.files.set(lockPath, JSON.stringify({ pid: 55, startTime: 100 }));
		const result = await acquireLock({
			fs, home: "/home/test", process: { pid: 66, startTime: 200, ownerStartTime: async () => ok(null) },
			clock: { sleep: async () => undefined, now: () => Date.now() }, pollIntervalMs: 1,
		}, () => undefined);
		expect(result.ok).toBe(true);
		if (result.ok) await result.value.release();
	});
});

describe("events", () => {
	test("appends one JSON line", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = {
			fs, home: "/home/test", now: () => "2026-10-30T00:00:00.000Z", createId: () => "event-1",
		};
		await appendEvent(dependencies, { level: "info", type: "update-ok", text: "prêt" });
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		expect(fs.files.get(eventPath)).toBe('{"id":"event-1","time":"2026-10-30T00:00:00.000Z","level":"info","type":"update-ok","text":"prêt"}\n');
	});

	test("keeps the file byte-identical when the offset leaves an unread tail", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = { fs, home: "/home/test", now: () => "", createId: () => "" };
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		const eventText = `${"x".repeat(TEST_EVENT_FILE_THRESHOLD_BYTES + 1)} queue-é`;
		fs.files.set(eventPath, eventText);
		fs.files.set("/home/test/.agent-rig/events.offset", "4");

		const result = await trimEvents(dependencies);

		expect(result.ok).toBe(true);
		expect(fs.files.get(eventPath)).toBe(eventText);
	});

	test("empties an over-threshold file when fully read and leaves the offset alone", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = { fs, home: "/home/test", now: () => "", createId: () => "" };
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		const offsetPath = "/home/test/.agent-rig/events.offset";
		const eventText = "x".repeat(TEST_EVENT_FILE_THRESHOLD_BYTES + 1);
		const offsetText = `${new TextEncoder().encode(eventText).length}\n`;
		fs.files.set(eventPath, eventText);
		fs.files.set(offsetPath, offsetText);

		const result = await trimEvents(dependencies);

		expect(result.ok).toBe(true);
		expect(fs.files.get(eventPath)).toBe("");
		expect(fs.files.get(offsetPath)).toBe(offsetText);
	});

	test("keeps an under-threshold file unchanged even when fully read", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = { fs, home: "/home/test", now: () => "", createId: () => "" };
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		const eventText = "x".repeat(TEST_EVENT_FILE_THRESHOLD_BYTES);
		fs.files.set(eventPath, eventText);
		fs.files.set("/home/test/.agent-rig/events.offset", `${eventText.length}`);

		const result = await trimEvents(dependencies);

		expect(result.ok).toBe(true);
		expect(fs.files.get(eventPath)).toBe(eventText);
	});

	test("keeps the file unchanged when the offset is missing", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = { fs, home: "/home/test", now: () => "", createId: () => "" };
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		const eventText = "x".repeat(TEST_EVENT_FILE_THRESHOLD_BYTES + 1);
		fs.files.set(eventPath, eventText);

		const result = await trimEvents(dependencies);

		expect(result.ok).toBe(true);
		expect(fs.files.get(eventPath)).toBe(eventText);
	});

	test("keeps the file unchanged when the offset is unreadable", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = { fs, home: "/home/test", now: () => "", createId: () => "" };
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		const offsetPath = "/home/test/.agent-rig/events.offset";
		const eventText = "x".repeat(TEST_EVENT_FILE_THRESHOLD_BYTES + 1);
		fs.files.set(eventPath, eventText);
		fs.files.set(offsetPath, `${eventText.length}`);
		fs.unreadablePaths.add(offsetPath);

		const result = await trimEvents(dependencies);

		expect(result.ok).toBe(true);
		expect(fs.files.get(eventPath)).toBe(eventText);
	});

	test("keeps the file unchanged when the offset is malformed", async () => {
		const fs = new MemoryFileSystem();
		const dependencies: EventDependencies = { fs, home: "/home/test", now: () => "", createId: () => "" };
		const eventPath = "/home/test/.agent-rig/events.jsonl";
		const eventText = "x".repeat(TEST_EVENT_FILE_THRESHOLD_BYTES + 1);
		fs.files.set(eventPath, eventText);
		fs.files.set("/home/test/.agent-rig/events.offset", "not-an-offset");

		const result = await trimEvents(dependencies);

		expect(result.ok).toBe(true);
		expect(fs.files.get(eventPath)).toBe(eventText);
	});
});

import type { ChildProcess } from "node:child_process";

import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { closeLaunchedWindow } from "../src/launch-window.js";

// The real console reader and the real window closer against a hidden console process this test starts itself: it holds no window
// on the desktop (windowsHide) and is killed by its own pid. Windows only: other hosts have no console reader.

// A child that is slower to print than this is not coming; the text is polled, never slept for a fixed time.
const POLL_MS = 100;
const POLL_TRIES = 100;
const SCREEN_LINE = "Do you trust this folder?";
const PING_COUNT = 60;

let child: ChildProcess | null = null;

afterEach(async () => {
	const pid = child?.pid;
	child = null;
	if (pid === undefined) return;
	const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
	await new Promise((resolve) => killer.once("exit", resolve));
});

// A hidden cmd that writes two lines straight onto its console screen, then idles. Its command line carries `--resume <id>` the way a launch does.
const hiddenWindow = (id: string): ChildProcess => spawn("cmd.exe", ["/d", "/c", `(echo ${SCREEN_LINE}) > CONOUT$ & (echo 1. Yes) > CONOUT$ & ping -n ${PING_COUNT} 127.0.0.1 > nul & rem --resume ${id}`], { windowsHide: true, stdio: "ignore", windowsVerbatimArguments: true });

const created = await createRealRuntime();
if (!created.ok) throw new Error(created.error);
const runtime = created.value;

test.skipIf(process.platform !== "win32")("the real reader returns the screen of a hidden console, and the closer reads it then kills the window by pid", async () => {
	const id = randomUUID();
	const spawnedAt = new Date(Date.now() - 1000);
	child = hiddenWindow(id);
	const pid = child.pid;
	if (pid === undefined) throw new Error("the hidden process did not start");
	let text = "";
	for (let tries = 0; tries < POLL_TRIES && !text.includes(SCREEN_LINE); tries += 1) {
		const read = await runtime.process.readConsoleText(pid);
		text = read.ok ? read.value : "";
		if (!text.includes(SCREEN_LINE)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	expect(text).toContain(`${SCREEN_LINE}\n1. Yes`);
	const closed = await closeLaunchedWindow(runtime, { sessionId: id, earlier: new Set(), spawnedAt });
	expect(closed.killed).toEqual([pid]);
	expect(closed.excerpt).toContain(SCREEN_LINE);
	const after = await runtime.process.listProcesses();
	expect(after.ok && after.value.some((entry) => entry.pid === pid && entry.commandLine.includes(id))).toBe(false);
});

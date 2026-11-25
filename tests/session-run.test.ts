import type { SpawnLaunch } from "../src/commands/session-run.js";
import type { Platform } from "../src/feature.js";
import type { ProcessEntry } from "../src/ports.js";
import type { Result } from "../src/result.js";
import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { findCswap, launchRegistrationDeadline, modeCommand, prepareLaunch, resolveLaunch, runSession, transcriptMode } from "../src/commands/session-run.js";
import { buildLaunchCommand } from "../src/launch-command.js";
import { messagesFor } from "../src/messages.js";
import { lookupSession, PROMPT_TIMEOUT_MS, SESSION_POLL_MS } from "../src/session-core.js";
import { apiFail, apiOk } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { withSessionEnding } from "../src/session-ending.js";
import { baseManifest, createMemoryRuntime, FAKE_OWNER_CREATED, seedFeature, seedHubManifest } from "./fakes/memory-runtime.js";
import { ACCOUNT_ONE, answerAccountLookup, answerOwnerQueries, DEFAULT_LOGIN, ownerLine, seedDefaultLogin } from "./fakes/session-owner-fixture.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const CREATED = "2026-01-01";
// The two-second failure-detection grace documented for session launches.
const LAUNCH_GRACE_MS = 2000;
const session: SessionRecord = { id: ID, cwd: "/work", transcriptPath: "/transcript", copyOf: null, startedAt: CREATED, processes: [] };
const raw = { session_id: ID, cwd: session.cwd, transcript_path: session.transcriptPath, pid: 42, pid_created: CREATED, started_at: CREATED, ended_at: CREATED, config_dir: "/cfg/1-test" };
const code = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;
// Control characters, then every character that some launch-line parser reads as syntax or that is not in the identifier alphabet.
const CONTROL = ["\t", "\n", "\r", "\x03", "\x15"];
const CMD_LINE = ["&", "|", "<", ">", "^", "%", "\"", "!"];
const NOT_IDENTIFIER = [...CONTROL, ...CMD_LINE, ";", "#", "(", ")", "'", "$", "~", "+", "=", ",", "[", "]", "\\", "/", "*", "?", ":", " "];
// The launch as resolveLaunch does it: one cswap lookup, handed to prepareLaunch.
// A spawn that runs the launch step like the real one, then `after`, and answers with the step's decision and a deadline.
// A step that stays declines the launch: nothing is spawned and `after` does not run.
const fakeSpawn = (h: ReturnType<typeof setup>, after: () => void = () => undefined, deadline: number | null = null): SpawnLaunch => async (_command, before) => {
	const gate = await before();
	if (!gate.ok) return gate;
	if (gate.value.kind === "stay") return apiOk({ kind: "declined", outcome: gate.value.outcome });
	after();
	return apiOk({ kind: "spawned", decision: gate.value.decision, deadline: deadline ?? launchRegistrationDeadline(h.runtime.clock.now().getTime()) });
};
// A fakeSpawn that first runs `ahead` with the number of the try, on every try, before the step: another writer acting between the reading and the writing.
const spawnWith = (h: ReturnType<typeof setup>, ahead: (call: number) => void, after: () => void = () => undefined): SpawnLaunch => {
	const inner = fakeSpawn(h, after);
	let calls = 0;
	return (command, before) => { ahead(++calls); return inner(command, before); };
};
const EVENTS_PATH = `${ROOT}/events.jsonl`;
// The rig events written so far: their level, type and text.
const eventsOf = (h: ReturnType<typeof setup>): { level: string; type: string; text: string }[] =>
	(h.fs.files.get(EVENTS_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || !("level" in value) || !("type" in value) || !("text" in value) || typeof value.level !== "string" || typeof value.type !== "string" || typeof value.text !== "string") throw new Error("bad event line");
		return { level: value.level, type: value.type, text: value.text };
	});
const REFUSED = "owner-switch-unavailable";
const POLL_MS = SESSION_POLL_MS;
const recordWith = (pid: number, pidCreated: string | null): string => JSON.stringify({ ...raw, pid, pid_created: pidCreated, ended_at: null });
const prepare = async (h: ReturnType<typeof createMemoryRuntime>, record: SessionRecord, account: string, mode: string | null) => prepareLaunch(h.runtime, record, account, mode, await findCswap(h.runtime));
const setup = () => {
	const h = createMemoryRuntime();
	h.fs.directories.add("/work");
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify(raw));
	h.fs.seed("/transcript", `${ownerLine(DEFAULT_LOGIN, ID)}\n`);
	seedDefaultLogin(h);
	answerOwnerQueries(h, { 1: ACCOUNT_ONE });
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	return h;
};

test("a session with a drifted record launches in its transcript's original directory", async () => {
	const h = setup();
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, cwd: "/work/sub" }));
	h.fs.seed("/transcript", '{"type":"mode"}\n{"cwd":"/work"}\n');
	h.fs.seed("/usr/bin/tmux", "");
	const record = await lookupSession(h.runtime, ID);
	if (!record.ok) throw new Error(record.error.message);
	const command = await prepare(h, record.value, "", null);
	expect(command.ok && command.value[command.value.indexOf("-c") + 1]).toBe("/work");
});

// The launch answer for a directory: the refusal message, or "ok" when the directory passed the check.
const launchRefusal = async (platform: Platform, cwd: string): Promise<string> => {
	const h = createMemoryRuntime(platform);
	h.fs.directories.add(cwd);
	const result = await prepare(h, { ...session, cwd }, "", null);
	return result.ok ? "ok" : result.error.message;
};
// The launch answer for one plugin of the enabled telegram feature, resolved from a hub marketplace with the given name.
const pluginAnswer = async (plugin: string, market: string): Promise<string> => {
	const h = setup();
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: { telegram: true }, records: {}, badPairs: [], pendingHubRestart: null }));
	seedFeature(h.fs, "/repo", { ...baseManifest(), name: "telegram", plugins: [plugin] });
	seedHubManifest(h.fs, "/hub", market);
	const result = await prepare(h, session, "", null);
	return result.ok ? "ok" : result.error.message;
};
// A Linux launch finds its launchers as files on the fake PATH (/usr/bin:/bin); tests that launch need them present.
const seedLaunchers = (h: ReturnType<typeof setup>): void => {
	h.fs.seed("/usr/bin/tmux", "");
	h.fs.seed("/usr/bin/cswap", "");
};

describe("session run and mode", () => {
	test("looks up the account without collecting limit information", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
		const calls: string[][] = [];
		h.runtime.process.run = async (_command, args) => { calls.push([...args]); return ok({ stdout: '{"accounts":{"/cfg/1-test":{"present":true,"account":12}},"categories":{}}', stderr: "", exitCode: 0 }); };
		await runSession(h.runtime, session, "plan", null, fakeSpawn(h));
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("batch");
		expect(calls[0]).toContain("/cfg/1-test");
		expect(h.fs.textReads.some((path) => path.endsWith("/usage.json"))).toBe(false);
	});
	test("account helper failure with cswap present returns its own code carrying the reason", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/cswap", "");
		for (const output of [ok({ stdout: "", stderr: "broken", exitCode: 2 }), ok({ stdout: "garbage", stderr: "", exitCode: 0 })]) {
			h.runtime.process.run = async () => output;
			let launched = false;
			const result = await runSession(h.runtime, session, "plan", null, fakeSpawn(h, () => { launched = true; }));
			expect(code(result)).toBe("launch-account-lookup");
			expect(launched).toBe(false);
		}
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		const failed = await runSession(h.runtime, session, "plan", null, fakeSpawn(h));
		expect(failed.ok ? "ok" : failed.error.message).toContain("broken");
	});
	test("account helper failure with cswap absent still launches without an account", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/tmux", "");
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		let launched = false;
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		const result = await runSession(h.runtime, session, "plan", null, fakeSpawn(h, () => { launched = true; h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null })); }));
		expect(launched).toBe(true);
		expect(result).toEqual(apiOk({ session: ID, pid: 43, mode: "plan", account: null, ownerSwitch: "unchanged" }));
	});
	test("a recorded account without cswap is refused like a requested one", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/tmux", "");
		h.runtime.process.run = async () => ok({ stdout: '{"accounts":{"/cfg/1-test":{"present":true,"account":12}},"categories":{}}', stderr: "", exitCode: 0 });
		let launched = false;
		const result = await runSession(h.runtime, session, "plan", null, fakeSpawn(h, () => { launched = true; }));
		expect(code(result)).toBe("launch-invalid");
		expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchNoCswap());
		expect(launched).toBe(false);
	});
	test("mode resolves the new launch before stopping the session", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/cswap", "");
		h.fs.seed("/transcript", JSON.stringify({ type: "permission-mode", permissionMode: "plan" }));
		h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, ended_at: null }));
		h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, "42": CREATED });
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		const killed: number[] = [];
		h.runtime.process.killTree = async (pid) => { killed.push(pid); return ok(undefined); };
		const result = await modeCommand(h.runtime, [ID, "auto"], () => {});
		expect(code(result)).toBe("launch-account-lookup");
		expect(killed).toEqual([]);
	});
	test("uses catalogue errors in both languages", async () => {
		for (const language of ["en", "ru"] as const) {
			const h = setup();
			h.runtime.language = language;
			const result = await prepare(h, session, "1", "unknown");
			expect(result.ok ? "ok" : result.error.message).toBe(messagesFor(language).session.launchMode());
		}
	});
	test("builds commands for every platform and rejects unsafe inputs", async () => {
		const h = setup();
		const facts = { platform: "windows", cwd: "/work", session: ID, account: "12", mode: "plan", plugins: ["custom@market"], cswap: "cswap.exe", terminal: null, tmux: null } as const;
		expect(buildLaunchCommand({ ...facts, plugins: [...facts.plugins] })).toEqual(["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", "/work", "cmd.exe", "/c", `"cswap.exe" run 12 --share-history -- --channels plugin:custom@market --resume ${ID} --permission-mode plan & exit /b 0`]);
		expect(buildLaunchCommand({ ...facts, plugins: [], account: "", mode: null, cswap: null })).toEqual(["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", "/work", "cmd.exe", "/c", `claude --resume ${ID} & exit /b 0`]);
		expect(buildLaunchCommand({ ...facts, plugins: [], account: "", mode: null })).toContain(`"cswap.exe" run --share-history -- --resume ${ID} & exit /b 0`);
		expect(buildLaunchCommand({ ...facts, platform: "darwin", plugins: [], cwd: "/a b/c'd", cswap: null, mode: null })).toEqual(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal" to do script (item 1 of argv)', "-e", "end run", "--", `cd -- '/a b/c'\\''d' && exec 'claude' '--resume' '${ID}'`]);
		expect(buildLaunchCommand({ ...facts, platform: "linux", plugins: [], terminal: "/usr/bin/x-terminal-emulator", cswap: "/usr/bin/cswap" })).toEqual(["/usr/bin/x-terminal-emulator", "-e", "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", "/work", "/usr/bin/cswap", "run", "12", "--share-history", "--", "--resume", ID, "--permission-mode", "plan"]);
		expect(buildLaunchCommand({ ...facts, platform: "linux", plugins: [], tmux: "/usr/bin/tmux", cswap: "/usr/bin/cswap" })).toEqual(["/usr/bin/tmux", "new-session", "-d", "-c", "/work", "/usr/bin/cswap", "run", "12", "--share-history", "--", "--resume", ID, "--permission-mode", "plan"]);
		expect(buildLaunchCommand({ ...facts, platform: "linux", plugins: [] })).toBeNull();
		for (const [account, mode] of [["bad&", "plan"], ["1", "unknown"]]) expect(code(await prepare(h, session, account, mode))).toBe("launch-invalid");
		for (const character of NOT_IDENTIFIER) {
			expect(code(await prepare(h, session, `1${character}`, null))).toBe("launch-invalid");
			expect(code(await prepare(h, session, "", `plan${character}`))).toBe("launch-invalid");
			expect(code(await prepare(h, { ...session, id: `${ID.slice(0, -1)}${character}` }, "", null))).toBe("launch-invalid");
		}
		expect(code(await prepare(h, session, "1", null))).toBe("launch-invalid");
		expect(code(await prepare(h, session, "", null))).toBe("launch-unavailable");
	});
	test("refuses a directory whose characters the launch line cannot carry, per platform", async () => {
		const message = messagesFor("en").session.launchDirectory();
		for (const character of CMD_LINE) expect(await launchRefusal("windows", `C:/bad${character}dir`)).toBe(message);
		for (const character of CONTROL) expect(await launchRefusal("windows", `C:/bad${character}dir`)).toBe(message);
		for (const character of CONTROL) expect(await launchRefusal("darwin", `/bad${character}dir`)).toBe(message);
		for (const character of [";", "#"]) expect(await launchRefusal("linux", `/bad${character}dir`)).toBe(message);
	});
	test("escapes a semicolon in a Windows directory for the wt.exe subcommand delimiter", async () => {
		for (const [cwd, escaped] of [["C:/a;b", "C:/a\\;b"], ["C:/a\\;b", "C:/a\\\\;b"]]) {
			const h = createMemoryRuntime("windows");
			h.fs.directories.add(cwd);
			h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
			const result = await prepare(h, { ...session, cwd }, "", null);
			expect(result.ok && result.value[result.value.indexOf("-d") + 1]).toBe(escaped);
		}
	});
	test("refuses a plugin or marketplace name the launch line cannot carry", async () => {
		const message = messagesFor("en").session.launchPlugin();
		for (const character of NOT_IDENTIFIER) {
			expect(await pluginAnswer(`p${character}x`, "test-market")).toBe(message);
			expect(await pluginAnswer("test-channel", `m${character}x`)).toBe(message);
			expect(await pluginAnswer(`p${character}x@test-market`, "test-market")).toBe(message);
		}
	});
	test("reads last transcript mode including default and malformed records", async () => {
		const h = setup();
		h.fs.seed("/transcript", `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\ninvalid\n${JSON.stringify({ type: "permission-mode", permissionMode: "default" })}\n`);
		expect(await transcriptMode(h.runtime, "/transcript")).toBe("manual");
		expect(await modeCommand(h.runtime, [ID, "manual"], () => {})).toEqual(apiOk({ session: ID, mode: "manual", changed: false }));
	});
	test("resolves channels from the enabled feature and hub marketplace manifests", async () => {
		const h = setup();
		seedLaunchers(h);
		h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: { telegram: true }, records: {}, badPairs: [], pendingHubRestart: null }));
		seedFeature(h.fs, "/repo", { ...baseManifest(), name: "telegram", plugins: ["test-channel"] });
		seedHubManifest(h.fs, "/hub", "test-market");
		const result = await prepare(h, session, "", null);
		expect(result.ok && result.value).toContain("plugin:test-channel@test-market");
	});
	test("launches the display terminal from the full path it was found at", async () => {
		const h = setup();
		h.environment.set("WAYLAND_DISPLAY", "wayland-1");
		h.fs.seed("/usr/bin/x-terminal-emulator", "");
		h.fs.seed("/usr/bin/tmux", "");
		const result = await prepare(h, session, "", null);
		expect(result.ok && result.value[0]).toBe("/usr/bin/x-terminal-emulator");
	});
	test("launches tmux from the full path it was found at when no display terminal is on PATH", async () => {
		const h = setup();
		h.environment.set("WAYLAND_DISPLAY", "wayland-1");
		h.fs.seed("/usr/bin/tmux", "");
		const result = await prepare(h, session, "", null);
		expect(result.ok && result.value[0]).toBe("/usr/bin/tmux");
	});
	test("reports launch-unavailable when neither a display terminal nor tmux is on PATH", async () => {
		const h = setup();
		h.environment.set("WAYLAND_DISPLAY", "wayland-1");
		expect(code(await prepare(h, session, "", null))).toBe("launch-unavailable");
	});
	test("runs cswap from the full path it was found at inside tmux", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/tmux", "");
		h.fs.seed("/usr/bin/cswap", "");
		const result = await prepare(h, session, "12", null);
		expect(result.ok && result.value).toEqual(["/usr/bin/tmux", "new-session", "-d", "-c", "/work", "/usr/bin/cswap", "run", "12", "--share-history", "--", "--resume", ID]);
	});
	test("runs claude directly inside tmux when cswap is not on PATH", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/tmux", "");
		const result = await prepare(h, session, "", null);
		expect(result.ok && result.value).toEqual(["/usr/bin/tmux", "new-session", "-d", "-c", "/work", "claude", "--resume", ID]);
	});
	test("reports spawn failure and timeout", async () => {
		const h = setup();
		seedLaunchers(h);
		expect(code(await runSession(h.runtime, session, "plan", "1", async () => apiFail("launch-failed", "stderr")))).toBe("launch-failed");
		expect(code(await runSession(h.runtime, session, "plan", "1", fakeSpawn(h)))).toBe("launch-timeout");
	});
	test("reports stderr from detached launch failure", async () => {
		const h = setup();
		seedLaunchers(h);
		h.runtime.process.spawnDetached = async () => ({ ok: false, error: "launch error" });
		const result = await runSession(h.runtime, session, "plan", "1");
		expect(result.ok ? "ok" : result.error.message).toContain("launch error");
	});
	test("a launch that retries twice prepares the stderr directory once", async () => {
		const h = setup();
		seedLaunchers(h);
		const UNKNOWN_PID = 44;
		const SPAWNED_PID = 43;
		h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: UNKNOWN_PID, pid_created: null, ended_at: null }));
		h.runtime.process.createdAt = async () => ok({ [String(UNKNOWN_PID)]: h.runtime.clock.now().getTime() < 2 * POLL_MS ? CREATED : null, [String(SPAWNED_PID)]: CREATED });
		h.runtime.process.spawnDetached = async () => {
			h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: SPAWNED_PID, ended_at: null }));
			return ok({ exited: false, exitCode: null, stderr: "" });
		};
		const listed: string[] = [];
		const list = h.fs.listDirectory.bind(h.fs);
		h.fs.listDirectory = async (path) => { listed.push(path); return list(path); };
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect(listed.filter((path) => path === `${ROOT}/launch-stderr`)).toHaveLength(1);
	});
	test("retries stderr cleanup on a later launch after a child releases its file", async () => {
		const h = setup();
		seedLaunchers(h);
		const directory = `${ROOT}/launch-stderr`;
		const originalRemove = h.fs.remove.bind(h.fs);
		let locked = "";
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		h.fs.remove = async (path) => { if (path === locked) throw new Error("file is open"); await originalRemove(path); };
		h.runtime.process.spawnDetached = async (_command, _grace, _limit, path) => {
			h.fs.seed(path, "stderr");
			locked = path;
			h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null }));
			return ok({ exited: false, exitCode: null, stderr: "" });
		};
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect((await h.fs.listDirectory(directory)).length).toBe(1);
		const previous = locked;
		locked = "";
		now += LAUNCH_GRACE_MS;
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect(h.fs.files.has(previous)).toBe(false);
		expect((await h.fs.listDirectory(directory)).length).toBe(1);
	});
	test("removes an unlocked stderr file and preserves a concurrent launch's diagnostic window", async () => {
		const h = setup();
		seedLaunchers(h);
		const directory = `${ROOT}/launch-stderr`;
		const concurrent = `${directory}/0-other.log`;
		h.fs.seed(concurrent, "diagnostic");
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		h.runtime.process.spawnDetached = async (_command, _grace, _limit, path) => {
			h.fs.seed(path, "stderr");
			h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null }));
			return ok({ exited: false, exitCode: null, stderr: "" });
		};
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect((await h.fs.listDirectory(directory)).map((entry) => entry.name)).toEqual(["0-other.log"]);
	});
	test("rejects a live session and accepts a newly recorded process", async () => {
		const h = setup();
		seedLaunchers(h);
		h.runtime.process.createdAt = async () => ok({ "42": CREATED, "43": CREATED });
		expect(code(await runSession(h.runtime, { ...session, processes: [{ pid: 42, pidCreated: CREATED, startedAt: CREATED }] }, "plan", "1"))).toBe("session-running");
		const answer = await runSession(h.runtime, session, "plan", "1", fakeSpawn(h, () => { h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null })); }));
		expect(answer).toEqual(apiOk({ session: ID, pid: 43, mode: "plan", account: 1, ownerSwitch: "written" }));
	});
	describe("an owner switch that cannot be made yet is retried on the clock, then refused", () => {
		const SPAWNED_PID = 43;
		const UNKNOWN_PID = 44;
		const registerSpawned = (h: ReturnType<typeof setup>): void => h.fs.seed(`${ROOT}/sessions/${ID}.json`, recordWith(SPAWNED_PID, CREATED));
		// The clock's sleeps: each one is a try waited out.
		const trackSleeps = (h: ReturnType<typeof setup>): number[] => {
			const sleeps: number[] = [];
			const advance = h.runtime.clock.sleep;
			h.runtime.clock.sleep = async (ms) => { sleeps.push(ms); await advance(ms); };
			return sleeps;
		};
		test("a process of unknown creation time that goes away after two polls: the owner line is written and the launch registers", async () => {
			const h = setup();
			seedLaunchers(h);
			const sleeps = trackSleeps(h);
			// The process of unknown creation time is alive for the first two polls, then gone; the spawned one is alive.
			h.runtime.process.createdAt = async () => ok({ [String(UNKNOWN_PID)]: h.runtime.clock.now().getTime() < 2 * POLL_MS ? CREATED : null, [String(SPAWNED_PID)]: CREATED });
			let spawned = 0;
			const result = await runSession(h.runtime, session, "plan", "1", spawnWith(h, (call) => { if (call === 1) h.fs.seed(`${ROOT}/sessions/${ID}.json`, recordWith(UNKNOWN_PID, null)); }, () => { spawned++; registerSpawned(h); }));
			expect(result).toEqual(apiOk({ session: ID, pid: SPAWNED_PID, mode: "plan", account: 1, ownerSwitch: "written" }));
			expect(spawned).toBe(1);
			expect(sleeps).toEqual([POLL_MS, POLL_MS]);
			expect(await h.fs.readText("/transcript")).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n${ownerLine(ACCOUNT_ONE, ID)}\n`);
			expect(eventsOf(h)).toEqual([]);
		});
		test("a process of unknown creation time that never goes away: refused at the registration deadline with its pid, no spawn, one warn event", async () => {
			const h = setup();
			seedLaunchers(h);
			const sleeps = trackSleeps(h);
			const before = await h.fs.readText("/transcript");
			h.runtime.process.createdAt = async () => ok({ [String(UNKNOWN_PID)]: CREATED });
			let spawned = 0;
			const result = await runSession(h.runtime, session, "plan", "1", spawnWith(h, (call) => { if (call === 1) h.fs.seed(`${ROOT}/sessions/${ID}.json`, recordWith(UNKNOWN_PID, null)); }, () => { spawned++; }));
			expect(code(result)).toBe(REFUSED);
			expect(result.ok ? "" : result.error.message).toContain("process-unknown");
			expect(result.ok ? "" : result.error.message).toContain(String(UNKNOWN_PID));
			expect(spawned).toBe(0);
			// Every wait is one poll or less, and together they are the registration budget counted from the first try.
			expect(sleeps.every((ms) => ms > 0 && ms <= POLL_MS)).toBe(true);
			expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(launchRegistrationDeadline(0));
			expect(await h.fs.readText("/transcript")).toBe(before);
			const events = eventsOf(h);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ level: "warn", type: "owner-switch-refused" });
			expect(events[0].text).toContain(ID);
			expect(events[0].text).toContain("process-unknown");
			expect(events[0].text).toContain(String(UNKNOWN_PID));
		});
		test("a busy transcript that is free again after two polls: written on the third try", async () => {
			const h = setup();
			seedLaunchers(h);
			const sleeps = trackSleeps(h);
			h.runtime.process.createdAt = async () => ok({ [String(SPAWNED_PID)]: CREATED });
			let busy = 2;
			const append = h.fs.appendBytes.bind(h.fs);
			h.fs.appendBytes = async (path, value) => {
				if (busy > 0) { busy--; throw Object.assign(new Error("file is open"), { code: "EBUSY" }); }
				await append(path, value);
			};
			const result = await runSession(h.runtime, session, "plan", "1", fakeSpawn(h, () => registerSpawned(h)));
			expect(result).toEqual(apiOk({ session: ID, pid: SPAWNED_PID, mode: "plan", account: 1, ownerSwitch: "written" }));
			expect(sleeps).toEqual([POLL_MS, POLL_MS]);
			expect(await h.fs.readText("/transcript")).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n${ownerLine(ACCOUNT_ONE, ID)}\n`);
		});
		test("a transcript that stays busy is refused as locked at the deadline", async () => {
			const h = setup();
			seedLaunchers(h);
			const before = await h.fs.readText("/transcript");
			h.fs.appendBytes = async () => { throw Object.assign(new Error("file is open"), { code: "EBUSY" }); };
			let spawned = 0;
			const result = await runSession(h.runtime, session, "plan", "1", fakeSpawn(h, () => { spawned++; }));
			expect(code(result)).toBe(REFUSED);
			expect(result.ok ? "" : result.error.message).toContain("locked");
			expect(spawned).toBe(0);
			expect(await h.fs.readText("/transcript")).toBe(before);
			expect(eventsOf(h).map((event) => event.type)).toEqual(["owner-switch-refused"]);
		});
		test("a transcript that grew with no owner line is written at the new size and the launch goes on", async () => {
			const h = setup();
			seedLaunchers(h);
			h.runtime.process.createdAt = async () => ok({ [String(SPAWNED_PID)]: CREATED });
			const before = await h.fs.readText("/transcript");
			const result = await runSession(h.runtime, session, "plan", "1", spawnWith(h, () => { h.fs.seed("/transcript", `${before}{"type":"user","message":"late"}\n`); }, () => registerSpawned(h)));
			expect(result).toEqual(apiOk({ session: ID, pid: SPAWNED_PID, mode: "plan", account: 1, ownerSwitch: "written" }));
			expect(await h.fs.readText("/transcript")).toBe(`${before}{"type":"user","message":"late"}\n${ownerLine(ACCOUNT_ONE, ID)}\n`);
		});
		// Each reason that retrying cannot change: the launch is refused on the first try, with nothing spawned.
		const permanent: [string, string, (h: ReturnType<typeof setup>) => void | Promise<void>][] = [
			["no-owner-line", "no-owner-line", (h) => { h.fs.seed("/transcript", '{"type":"user","message":"hello"}\n'); }],
			["owner-line-unknown", "owner-line-unknown", (h) => { h.fs.seed("/transcript", `${JSON.stringify({ type: "session-owner", accountUuid: DEFAULT_LOGIN.accountUuid, organizationUuid: DEFAULT_LOGIN.organizationUuid, sessionId: ID, extra: "key" })}\n`); }],
			// A second transcript of the session in the record's own config directory.
			["several-transcripts", "several-transcripts", (h) => {
				h.fs.seed(`/cfg/1-test/projects/other/${ID}.jsonl`, `${ownerLine(DEFAULT_LOGIN, ID)}\n`);
				h.fs.directories.add("/cfg/1-test/projects");
				h.fs.directories.add("/cfg/1-test/projects/other");
			}],
		];
		for (const [name, reason, prepare] of permanent) {
			test(`${name}: refused on the first try with no spawn and one warn event`, async () => {
				const h = setup();
				seedLaunchers(h);
				const sleeps = trackSleeps(h);
				await prepare(h);
				const record = await lookupSession(h.runtime, ID);
				if (!record.ok) throw new Error(record.error.message);
				let spawned = 0;
				const result = await runSession(h.runtime, record.value, "plan", "1", fakeSpawn(h, () => { spawned++; }));
				expect(code(result)).toBe(REFUSED);
				expect(result.ok ? "" : result.error.message).toContain(reason);
				expect(spawned).toBe(0);
				expect(sleeps).toEqual([]);
				expect(eventsOf(h)).toMatchObject([{ level: "warn", type: "owner-switch-refused" }]);
			});
		}
		test("a transcript that shrank after the scan: refused as transcript-changed on the first try with no spawn", async () => {
			const h = setup();
			seedLaunchers(h);
			const sleeps = trackSleeps(h);
			let spawned = 0;
			const result = await runSession(h.runtime, session, "plan", "1", spawnWith(h, () => { h.fs.seed("/transcript", "x\n"); }, () => { spawned++; }));
			expect(code(result)).toBe(REFUSED);
			expect(result.ok ? "" : result.error.message).toContain("transcript-changed");
			expect(spawned).toBe(0);
			expect(sleeps).toEqual([]);
			expect(await h.fs.readText("/transcript")).toBe("x\n");
			expect(eventsOf(h)).toMatchObject([{ level: "warn", type: "owner-switch-refused" }]);
		});
	});
	test("an account the helper does not know fails before the spawn and before the transcript is touched", async () => {
		const h = setup();
		seedLaunchers(h);
		const before = await h.fs.readText("/transcript");
		let launched = false;
		const result = await runSession(h.runtime, session, "plan", "7", fakeSpawn(h, () => { launched = true; }));
		expect(code(result)).toBe("launch-account-lookup");
		expect(launched).toBe(false);
		expect(await h.fs.readText("/transcript")).toBe(before);
	});
	test("a live session is refused before the transcript is touched", async () => {
		const h = setup();
		seedLaunchers(h);
		h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		const ownerAtSpawn: string[] = [];
		const result = await runSession(h.runtime, { ...session, processes: [{ pid: 42, pidCreated: CREATED, startedAt: CREATED }] }, "plan", "1", fakeSpawn(h, () => { ownerAtSpawn.push("spawned"); }, 0));
		expect(code(result)).toBe("session-running");
		expect(ownerAtSpawn).toEqual([]);
		expect(await h.fs.readText("/transcript")).toBe(`${ownerLine(DEFAULT_LOGIN, ID)}\n`);
	});
	test("a launch with no account to switch to launches without writing and returns right after the grace with no pid", async () => {
		const h = setup();
		seedLaunchers(h);
		h.fs.files.delete("/home/test/.claude.json");
		h.fs.files.delete("/usr/bin/cswap");
		const before = await h.fs.readText("/transcript");
		const sleeps: number[] = [];
		const advance = h.runtime.clock.sleep;
		h.runtime.clock.sleep = async (ms) => { sleeps.push(ms); await advance(ms); };
		let spawned = 0;
		const result = await runSession(h.runtime, session, "plan", null, fakeSpawn(h, () => { spawned++; }));
		expect(spawned).toBe(1);
		expect(result).toEqual(apiOk({ session: ID, pid: null, mode: "plan", account: null, ownerSwitch: "none" }));
		expect(sleeps).toEqual([]);
		expect(await h.fs.readText("/transcript")).toBe(before);
		expect(eventsOf(h)).toEqual([]);
	});
	test("with cswap and no account number there is no owner switch to make (account-unknown): the launch goes on as before", async () => {
		const h = setup();
		seedLaunchers(h);
		h.runtime.process.run = async () => ok({ stdout: '{"accounts":{"/cfg/1-test":{"present":true,"account":null}},"categories":{}}', stderr: "", exitCode: 0 });
		const result = await runSession(h.runtime, session, "plan", null, fakeSpawn(h));
		expect(result).toEqual(apiOk({ session: ID, pid: null, mode: "plan", account: null, ownerSwitch: "none" }));
	});
	describe("the owner line is written under a fresh check", () => {
		const REGISTERED_PID = 43;
		const MARKER_PATH = `${ROOT}/sessions/${ID}/ending.json`;
		// A line another writer appends to the transcript after the owner scan.
		const LATE_LINE = '{"type":"user","message":"late"}\n';
		const registeredRecord = JSON.stringify({ ...raw, pid: REGISTERED_PID, ended_at: null });
		// The process table of a launch: rig's own pid, and the process that registers late (alive once it is recorded).
		const answerProcessTable = (h: ReturnType<typeof setup>): void => {
			const own = String(h.runtime.lock.process.pid);
			h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), String(pid) === own ? FAKE_OWNER_CREATED : pid === REGISTERED_PID ? CREATED : null])));
		};
		// Runs the action once, at the first account-helper query: after run's and mode's first live check and record read.
		const afterFirstLiveCheck = (h: ReturnType<typeof setup>, action: () => void): void => {
			const query = h.runtime.process.run.bind(h.runtime.process);
			let done = false;
			h.runtime.process.run = async (command, args, options) => {
				if (!done) { done = true; action(); }
				return query(command, args, options);
			};
		};
		// Runs the action when the launch transition reads the marker for its takeover check (the second marker read of a run).
		const atLaunchTransition = (h: ReturnType<typeof setup>, action: () => Promise<void>): void => {
			const read = h.fs.readText.bind(h.fs);
			let reads = 0;
			h.fs.readText = async (path) => {
				if (path === MARKER_PATH && ++reads === 2) await action();
				return read(path);
			};
		};
		// Counts the spawns; with `registers` the spawned process records itself, as a live Claude Code does.
		const countSpawns = (h: ReturnType<typeof setup>, registers = false): { count: () => number } => {
			let spawned = 0;
			h.runtime.process.spawnDetached = async () => {
				spawned++;
				if (registers) h.fs.seed(`${ROOT}/sessions/${ID}.json`, recordWith(REGISTERED_PID, CREATED));
				return ok({ exited: false, exitCode: null, stderr: "" });
			};
			return { count: () => spawned };
		};
		const runJson = async (h: ReturnType<typeof setup>, args: string[]): Promise<unknown> => {
			const lines: string[] = [];
			await runCli(args, (line) => lines.push(line), h.runtime);
			return JSON.parse(lines.join(""));
		};
		test("run refuses session-running when a process registers after its first live check", async () => {
			const h = setup();
			seedLaunchers(h);
			answerProcessTable(h);
			const before = await h.fs.readText("/transcript");
			afterFirstLiveCheck(h, () => h.fs.seed(`${ROOT}/sessions/${ID}.json`, registeredRecord));
			const spawns = countSpawns(h);
			expect(await runJson(h, ["session", "run", ID, "--account", "1"])).toMatchObject({ error: { code: "session-running" } });
			expect(await h.fs.readText("/transcript")).toBe(before);
			expect(spawns.count()).toBe(0);
		});
		test("run writes the owner line at the new size and launches when the transcript grew after the scan", async () => {
			const h = setup();
			seedLaunchers(h);
			answerProcessTable(h);
			const before = await h.fs.readText("/transcript");
			atLaunchTransition(h, async () => { await h.fs.appendBytes("/transcript", new TextEncoder().encode(LATE_LINE)); });
			const spawns = countSpawns(h, true);
			expect(await runJson(h, ["session", "run", ID, "--account", "1"])).toMatchObject({ pid: REGISTERED_PID, ownerSwitch: "written" });
			expect(await h.fs.readText("/transcript")).toBe(`${before}${LATE_LINE}${ownerLine(ACCOUNT_ONE, ID)}\n`);
			expect(spawns.count()).toBe(1);
		});
		test("run is refused, with no window, when the transcript shrank after the scan", async () => {
			const h = setup();
			seedLaunchers(h);
			atLaunchTransition(h, async () => { h.fs.seed("/transcript", "x\n"); });
			const spawns = countSpawns(h);
			expect(await runJson(h, ["session", "run", ID, "--account", "1"])).toMatchObject({ error: { code: REFUSED } });
			expect(spawns.count()).toBe(0);
			expect(await h.fs.readText("/transcript")).toBe("x\n");
			expect(eventsOf(h)).toMatchObject([{ level: "warn", type: "owner-switch-refused" }]);
			expect(await h.fs.stat(MARKER_PATH)).toBeNull();
		});
		test("mode is refused, with no window, by the same owner switch", async () => {
			const h = setup();
			seedLaunchers(h);
			h.fs.seed("/transcript", `${ownerLine(DEFAULT_LOGIN, ID)}\n${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`);
			answerAccountLookup(h, '{"accounts":{"/cfg/1-test":{"present":true,"account":1}},"categories":{}}');
			atLaunchTransition(h, async () => { h.fs.seed("/transcript", "x\n"); });
			const spawns = countSpawns(h);
			expect(code(await modeCommand(h.runtime, [ID, "auto"], () => {}))).toBe(REFUSED);
			expect(spawns.count()).toBe(0);
			expect(eventsOf(h)).toMatchObject([{ level: "warn", type: "owner-switch-refused" }]);
		});
		test("a stop that takes the marker over while a launch waits for a process of unknown creation time still wins", async () => {
			const h = setup();
			seedLaunchers(h);
			const UNKNOWN_PID = 44;
			const own = String(h.runtime.lock.process.pid);
			h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), String(pid) === own ? FAKE_OWNER_CREATED : CREATED])));
			// The process of unknown creation time appears before the first try's step, so that try stays.
			atLaunchTransition(h, async () => { h.fs.seed(`${ROOT}/sessions/${ID}.json`, recordWith(UNKNOWN_PID, null)); });
			const advance = h.runtime.clock.sleep;
			h.runtime.clock.sleep = async (ms) => {
				h.fs.seed(MARKER_PATH, JSON.stringify({ ...JSON.parse(await h.fs.readText(MARKER_PATH)), takenOver: true }));
				await advance(ms);
			};
			const before = await h.fs.readText("/transcript");
			const spawns = countSpawns(h);
			expect(await runJson(h, ["session", "run", ID, "--account", "1"])).toMatchObject({ error: { code: "session-ending" } });
			expect(spawns.count()).toBe(0);
			expect(await h.fs.readText("/transcript")).toBe(before);
			expect(eventsOf(h)).toEqual([]);
		});
		test("a stop that took the marker over before the launch transition is seen before the owner line is written", async () => {
			const h = setup();
			seedLaunchers(h);
			const before = await h.fs.readText("/transcript");
			atLaunchTransition(h, async () => { h.fs.seed(MARKER_PATH, JSON.stringify({ ...JSON.parse(await h.fs.readText(MARKER_PATH)), takenOver: true })); });
			const spawns = countSpawns(h);
			expect(await runJson(h, ["session", "run", ID, "--account", "1"])).toMatchObject({ error: { code: "session-ending" } });
			expect(await h.fs.readText("/transcript")).toBe(before);
			expect(spawns.count()).toBe(0);
		});
		test("mode uses the record read after its stop: a process registered after the first read is seen", async () => {
			const h = setup();
			seedLaunchers(h);
			answerProcessTable(h);
			h.fs.seed("/transcript", `${ownerLine(DEFAULT_LOGIN, ID)}\n${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`);
			const before = await h.fs.readText("/transcript");
			answerAccountLookup(h, '{"accounts":{"/cfg/1-test":{"present":true,"account":1}},"categories":{}}');
			afterFirstLiveCheck(h, () => h.fs.seed(`${ROOT}/sessions/${ID}.json`, registeredRecord));
			const spawns = countSpawns(h);
			expect(code(await modeCommand(h.runtime, [ID, "auto"], () => {}))).toBe("session-running");
			expect(await h.fs.readText("/transcript")).toBe(before);
			expect(spawns.count()).toBe(0);
		});
	});
	describe("a launch with a prompt hands the text to the registered process through the window request queue", () => {
		// Every character a launch line could break on: quotes, cmd.exe syntax, a line break, Cyrillic (\u escapes: no Cyrillic in sources).
		const PROMPT = "continue \"after\" the limit: 100% & !done; ^x | y\n\u0434\u0430\u043b\u044c\u0448\u0435";
		const PROMPT_PID = 43;
		const CLAIMANT_PID = 99;
		const CLAIMANT_CREATED = "2026-01-02T00:00:00.000Z";
		// The fake clock starts far from 0, after every creation time the table answers, so a modification time of 0 reads as ancient.
		const LAUNCHED_AT_MS = Date.parse("2026-02-01T00:00:00.000Z");
		const STALE_MS = 60_000;
		const LATE_MODULE_POLLS = 3;
		const SESSION_DIR = `${ROOT}/sessions/${ID}`;
		const USAGE_PATH = `${SESSION_DIR}/usage.json`;
		const REQUESTS_DIR = `${SESSION_DIR}/requests`;
		type ModuleBehaviour = "answers" | "fails" | "claims-and-hangs" | "claimant-dies" | "silent";
		type UsageSnapshot = "fresh" | "stale" | "late" | "absent";
		const requestOf = (text: string): { id: string; op: string; text: string } | null => {
			const value: unknown = JSON.parse(text);
			if (typeof value !== "object" || value === null || !("id" in value) || !("op" in value) || !("args" in value)) return null;
			const { id, op, args } = value;
			if (typeof id !== "string" || typeof op !== "string" || typeof args !== "object" || args === null || !("text" in args) || typeof args.text !== "string") return null;
			return { id, op, text: args.text };
		};
		// A launch's world: the spawned process registers itself (unless `registers` is false), its module writes a usage snapshot as
		// `usage` says and then answers the requests the way `module` says. The module acts whenever the clock sleeps.
		const world = (module: ModuleBehaviour, usage: UsageSnapshot, registers = true, withAccount = false) => {
			const h = setup();
			seedLaunchers(h);
			// Without an account the launch has no owner switch to make; with one the owner line is written.
			if (!withAccount) h.runtime.process.run = async () => ok({ stdout: '{"accounts":{"/cfg/1-test":{"present":true,"account":null}},"categories":{}}', stderr: "", exitCode: 0 });
			let now = LAUNCHED_AT_MS;
			let claimantAlive = true;
			let usageWritten = false;
			let windowInspections = 0;
			const seen: { op: string; text: string }[] = [];
			const handled = new Set<string>();
			const own = String(h.runtime.lock.process.pid);
			h.runtime.clock.now = () => new Date(now);
			h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), String(pid) === own ? FAKE_OWNER_CREATED : pid === CLAIMANT_PID ? (claimantAlive ? CLAIMANT_CREATED : null) : pid === PROMPT_PID ? CREATED : null])));
			const listProcesses = h.runtime.process.listProcesses.bind(h.runtime.process);
			h.runtime.process.listProcesses = async () => { windowInspections++; return listProcesses(); };
			const writeUsage = (at: number): void => { usageWritten = true; h.fs.seed(USAGE_PATH, "{}"); h.fs.mtimes.set(USAGE_PATH, at); };
			// A snapshot left by an earlier process of the session.
			if (usage === "stale") writeUsage(LAUNCHED_AT_MS - STALE_MS);
			const onSpawn = (): void => {
				if (registers) h.fs.seed(`${SESSION_DIR}.json`, recordWith(PROMPT_PID, CREATED));
				if (usage === "fresh") writeUsage(now);
			};
			const actAsModule = (): void => {
				const path = [...h.fs.files.keys()].find((file) => file.startsWith(`${REQUESTS_DIR}/`) && file.endsWith(".json"));
				if (path === undefined) return;
				if (handled.has(path)) {
					if (module === "claimant-dies") claimantAlive = false;
					return;
				}
				handled.add(path);
				const request = requestOf(h.fs.files.get(path) ?? "null");
				if (request === null) throw new Error("the request is not well formed");
				seen.push({ op: request.op, text: request.text });
				const claim = `${SESSION_DIR}/claims/${request.id}`;
				const respond = (answer: object): void => h.fs.seed(`${SESSION_DIR}/responses/${request.id}.json`, JSON.stringify({ id: request.id, ...answer }));
				if (module === "answers") respond({ ok: true, result: {} });
				else if (module === "fails") respond({ ok: false, error: "no turn to start" });
				else if (module !== "silent") {
					h.fs.directories.add(claim);
					h.fs.mtimes.set(claim, now);
					h.fs.seed(`${claim}/state`, "running");
					if (module === "claimant-dies") h.fs.seed(`${claim}/pid`, String(CLAIMANT_PID));
				}
			};
			h.runtime.clock.sleep = async (ms) => {
				now += ms;
				if (usage === "late" && !usageWritten && now >= LAUNCHED_AT_MS + LATE_MODULE_POLLS * POLL_MS) writeUsage(now);
				actAsModule();
			};
			return { h, seen, onSpawn, spawn: fakeSpawn(h, onSpawn), elapsed: () => now - LAUNCHED_AT_MS, windowInspections: () => windowInspections };
		};
		const launchWith = (w: ReturnType<typeof world>, prompt: string | null) => runSession(w.h.runtime, session, null, null, w.spawn, prompt);
		const failure = (result: Awaited<ReturnType<typeof launchWith>>): { code: string; message: string } => result.ok ? { code: "ok", message: "" } : result.error;
		test("the text arrives as a prompt request, and the launch reports it delivered with the process", async () => {
			const w = world("answers", "fresh");
			expect(await launchWith(w, PROMPT)).toEqual(apiOk({ session: ID, pid: PROMPT_PID, mode: null, account: null, ownerSwitch: "none", promptDelivered: true }));
			expect(w.seen).toEqual([{ op: "prompt", text: PROMPT }]);
			expect(w.windowInspections()).toBe(0);
			expect(eventsOf(w.h)).toEqual([]);
		});
		test("a launch with no owner switch to make and no prompt still returns at once, without the pid and without a request", async () => {
			const w = world("answers", "fresh");
			expect(await launchWith(w, null)).toEqual(apiOk({ session: ID, pid: null, mode: null, account: null, ownerSwitch: "none" }));
			expect(w.seen).toEqual([]);
		});
		test("a module that comes up a few polls after the process registered still gets the text", async () => {
			const w = world("answers", "late");
			expect(await launchWith(w, PROMPT)).toMatchObject({ ok: true, value: { pid: PROMPT_PID, promptDelivered: true } });
			expect(w.seen).toEqual([{ op: "prompt", text: PROMPT }]);
			expect(w.elapsed()).toBeGreaterThanOrEqual(LATE_MODULE_POLLS * POLL_MS);
		});
		test("a process that never registers is the launch-timeout refusal, which closes the window and says the text was not delivered", async () => {
			const w = world("answers", "fresh", false);
			const refusal = failure(await launchWith(w, PROMPT));
			expect(refusal.code).toBe("launch-timeout");
			expect(refusal.message).toContain(messagesFor("en").session.launchPromptNotSent());
			expect(w.seen).toEqual([]);
			expect(w.windowInspections()).toBeGreaterThan(0);
		});
		test("the same refusal without a prompt does not claim anything about a prompt", async () => {
			const w = world("answers", "fresh", false, true);
			const refusal = failure(await runSession(w.h.runtime, session, null, "1", w.spawn));
			expect(refusal.code).toBe("launch-timeout");
			expect(refusal.message).not.toContain(messagesFor("en").session.launchPromptNotSent());
		});
		for (const usage of ["stale", "absent"] as const) {
			test(`a registered process whose usage snapshot is ${usage} has no module of its own: prompt-not-delivered with the pid, no request, window kept`, async () => {
				const w = world("answers", usage);
				const refusal = failure(await launchWith(w, PROMPT));
				expect(refusal.code).toBe("prompt-not-delivered");
				expect(refusal.message).toContain(`process ${PROMPT_PID}`);
				expect(refusal.message).toContain(messagesFor("en").session.promptModuleNotUp());
				expect(w.seen).toEqual([]);
				expect(w.windowInspections()).toBe(0);
				expect(eventsOf(w.h)).toMatchObject([{ level: "warn", type: "prompt-not-delivered", text: refusal.message }]);
			});
		}
		test("a module that answers with an error did not take the text: prompt-not-delivered with its reason, window kept", async () => {
			const w = world("fails", "fresh");
			const refusal = failure(await launchWith(w, PROMPT));
			expect(refusal.code).toBe("prompt-not-delivered");
			expect(refusal.message).toContain(`process ${PROMPT_PID}`);
			expect(refusal.message).toContain("no turn to start");
			expect(w.windowInspections()).toBe(0);
			expect(eventsOf(w.h)).toMatchObject([{ level: "warn", type: "prompt-not-delivered" }]);
		});
		test("a module that never claims the request within the prompt allowance: prompt-not-delivered", async () => {
			const w = world("silent", "fresh");
			const refusal = failure(await launchWith(w, PROMPT));
			expect(refusal.code).toBe("prompt-not-delivered");
			expect(w.elapsed()).toBeGreaterThanOrEqual(PROMPT_TIMEOUT_MS);
			expect(w.windowInspections()).toBe(0);
		});
		test("a module that began the request and did not answer in time: prompt-delivery-unknown, window kept, warn event", async () => {
			const w = world("claims-and-hangs", "fresh");
			const refusal = failure(await launchWith(w, PROMPT));
			expect(refusal.code).toBe("prompt-delivery-unknown");
			expect(refusal.message).toContain(`process ${PROMPT_PID}`);
			expect(w.elapsed()).toBeGreaterThanOrEqual(PROMPT_TIMEOUT_MS);
			expect(w.windowInspections()).toBe(0);
			expect(eventsOf(w.h)).toMatchObject([{ level: "warn", type: "prompt-delivery-unknown", text: refusal.message }]);
		});
		test("a module whose claiming process vanished mid-request: prompt-delivery-unknown", async () => {
			const w = world("claimant-dies", "fresh");
			const refusal = failure(await launchWith(w, PROMPT));
			expect(refusal.code).toBe("prompt-delivery-unknown");
			expect(w.elapsed()).toBeLessThan(PROMPT_TIMEOUT_MS);
			expect(eventsOf(w.h)).toMatchObject([{ level: "warn", type: "prompt-delivery-unknown" }]);
		});
		test("run --prompt through the CLI: the text reaches the module and is on no command line of the launch", async () => {
			const w = world("answers", "fresh", true, true);
			const argv: string[][] = [];
			w.h.runtime.process.spawnDetached = async (command) => {
				argv.push([...command]);
				w.onSpawn();
				return ok({ exited: false, exitCode: null, stderr: "" });
			};
			const lines: string[] = [];
			expect(await runCli(["session", "run", ID, "--account", "1", "--prompt", PROMPT], (line) => lines.push(line), w.h.runtime)).toBe(0);
			expect(JSON.parse(lines.join(""))).toMatchObject({ pid: PROMPT_PID, ownerSwitch: "written", promptDelivered: true });
			expect(w.seen).toEqual([{ op: "prompt", text: PROMPT }]);
			expect(argv).toHaveLength(1);
			expect(argv.flat().some((part) => part.includes(PROMPT))).toBe(false);
		});
		test("run --prompt through the CLI exits non-zero with the refusal when the text is not delivered", async () => {
			const w = world("fails", "fresh", true, true);
			w.h.runtime.process.spawnDetached = async () => { w.onSpawn(); return ok({ exited: false, exitCode: null, stderr: "" }); };
			const lines: string[] = [];
			expect(await runCli(["session", "run", ID, "--account", "1", "--prompt", PROMPT], (line) => lines.push(line), w.h.runtime)).toBe(1);
			expect(JSON.parse(lines.join(""))).toMatchObject({ error: { code: "prompt-not-delivered" } });
		});
		for (const args of [["--prompt", ""], ["--prompt"], ["--prompt", "a", "--prompt", "b"]]) {
			test(`run ${JSON.stringify(args)} is a usage error and launches nothing`, async () => {
				const w = world("answers", "fresh");
				let spawned = 0;
				w.h.runtime.process.spawnDetached = async () => { spawned++; return ok({ exited: false, exitCode: null, stderr: "" }); };
				const lines: string[] = [];
				expect(await runCli(["session", "run", ID, ...args], (line) => lines.push(line), w.h.runtime)).toBe(1);
				expect(JSON.parse(lines.join(""))).toMatchObject({ error: { code: "usage" } });
				expect(spawned).toBe(0);
			});
		}
	});
	describe("the ending marker of a launch", () => {
		const OTHER_PID = 11;
		const OTHER_CREATED = "other-rig-creation";
		// A second rig process: its own pid, known to the process table next to the runtime's own.
		const other = (h: ReturnType<typeof setup>) => {
			h.runtime.process.createdAt = async () => ok({ [String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED, [String(OTHER_PID)]: OTHER_CREATED });
			return { ...h.runtime, lock: { ...h.runtime.lock, process: { ...h.runtime.lock.process, pid: OTHER_PID } } };
		};
		test("run is refused with session-ending while a mode holds the marker", async () => {
			const h = setup();
			seedLaunchers(h);
			let spawned = false;
			h.runtime.process.spawnDetached = async () => { spawned = true; return ok({ exited: false, exitCode: null, stderr: "" }); };
			const holder = other(h);
			let refused = "";
			const held = await withSessionEnding(holder, ID, async () => {
				const lines: string[] = [];
				await runCli(["session", "run", ID], (line) => lines.push(line), h.runtime);
				refused = lines.join("");
				return apiOk(null);
			});
			expect(held.ok).toBe(true);
			expect(JSON.parse(refused)).toMatchObject({ error: { code: "session-ending" } });
			expect(spawned).toBe(false);
		});
		test("a mode started while a run is spawning is refused with session-ending", async () => {
			const h = setup();
			seedLaunchers(h);
			const rival = other(h);
			let refused = "";
			h.runtime.process.spawnDetached = async () => {
				refused = code(await modeCommand(rival, [ID, "auto"], () => {}));
				return ok({ exited: false, exitCode: null, stderr: "" });
			};
			const result = await runCli(["session", "run", ID, "--account", "1"], () => {}, h.runtime);
			expect(refused).toBe("session-ending");
			expect(result).toBe(1);
			expect(await h.fs.stat(`${ROOT}/sessions/${ID}/ending.json`)).toBeNull();
		});
	});
	describe("a launch whose process never registers closes the window it opened", () => {
		const at = (ms: number): string => new Date(ms).toISOString();
		const row = (pid: number, parent: number, name: string, commandLine: string, createdMs: number | string): ProcessEntry => ({ pid, parent, name, commandLine, createdAt: typeof createdMs === "number" ? at(createdMs) : createdMs });
		const RESUME = `claude --resume ${ID}`;
		const OTHER_ID = "22222222-2222-2222-2222-222222222222";
		const EARLIER_PID = 42;
		const TERMINAL_PID = 400;
		const FIRST_ROOT = 100;
		const FIRST_CHILD = 101;
		const SECOND_ROOT = 110;
		const SECOND_CHILD = 111;
		const SCREEN = "Do you trust the files in this folder?\n> 1. Yes, proceed\n  2. No, exit";
		// The host's table at the timeout: one launch's window (two roots, each with a payload under it), a terminal process that
		// holds every window, a process of this session from before the launch (named in the record), an older process of the same
		// session, rig's own process, another session's window and an unrelated one.
		const windowTable = (): ProcessEntry[] => [
			row(10, 1, "bun.exe", `bun rig session run ${ID} --account 1`, -50),
			row(TERMINAL_PID, 1, "WindowsTerminal.exe", `WindowsTerminal.exe --resume ${ID}`, 500),
			row(FIRST_ROOT, TERMINAL_PID, "cmd.exe", `cmd.exe /c ${RESUME} & exit /b 0`, 500),
			row(FIRST_CHILD, FIRST_ROOT, "claude.exe", RESUME, 600),
			row(102, FIRST_CHILD, "node.exe", "node mcp.js", 650),
			row(SECOND_ROOT, TERMINAL_PID, "cmd.exe", `cmd.exe /c cswap run 1 --share-history -- --resume ${ID}`, 520),
			row(SECOND_CHILD, SECOND_ROOT, "claude.exe", RESUME, 560),
			row(200, 5, "claude.exe", RESUME, -1000),
			row(EARLIER_PID, 5, "claude.exe", RESUME, CREATED),
			row(300, 5, "notepad.exe", "notepad.exe", 700),
			row(310, TERMINAL_PID, "claude.exe", `claude --resume ${OTHER_ID}`, 700),
		];
		type Probe = { killed: number[]; read: number[] };
		// The process the record names is gone: its pid now belongs to a process created later.
		const recordedProcessGone = (h: ReturnType<typeof setup>): void => {
			h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === h.runtime.lock.process.pid ? FAKE_OWNER_CREATED : "pid reused by a later process"])));
		};
		const probeWindow = (h: ReturnType<typeof setup>, table: ProcessEntry[], screen: Result<string>): Probe => {
			const probe: Probe = { killed: [], read: [] };
			recordedProcessGone(h);
			h.runtime.process.listProcesses = async () => ok(table);
			h.runtime.process.readConsoleText = async (pid) => { probe.read.push(pid); return screen; };
			h.runtime.process.killTree = async (pid) => { probe.killed.push(pid); return ok(undefined); };
			return probe;
		};
		const earlierRecord: SessionRecord = { ...session, processes: [{ pid: EARLIER_PID, pidCreated: CREATED, startedAt: CREATED }] };
		test("kills exactly the roots of this launch's processes, reads the deepest one's screen first, and refuses with the screen", async () => {
			const h = setup();
			seedLaunchers(h);
			const order: string[] = [];
			const probe = probeWindow(h, windowTable(), ok(`${SCREEN}\n\n`));
			const read = h.runtime.process.readConsoleText;
			h.runtime.process.readConsoleText = async (pid) => { order.push("read"); return read(pid); };
			const kill = h.runtime.process.killTree;
			h.runtime.process.killTree = async (pid, force) => { order.push("kill"); expect(force).toBe(true); return kill(pid, force); };
			const result = await runSession(h.runtime, earlierRecord, "plan", "1", fakeSpawn(h));
			expect(code(result)).toBe("launch-timeout");
			expect(probe.killed).toEqual([FIRST_ROOT, SECOND_ROOT]);
			expect(probe.read).toEqual([FIRST_CHILD]);
			expect(order).toEqual(["read", "kill", "kill"]);
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeoutWindowClosedScreen(SCREEN));
			const events = eventsOf(h);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ level: "warn", type: "launch-blocked-screen" });
			expect(events[0].text).toBe(messagesFor("en").session.launchBlockedScreenEvent(ID, 1, `${FIRST_ROOT}, ${SECOND_ROOT}`, SCREEN));
		});
		test("a screen that cannot be read still closes the window and refuses with no excerpt", async () => {
			const h = setup();
			seedLaunchers(h);
			const probe = probeWindow(h, windowTable(), err("the helper timed out"));
			const result = await runSession(h.runtime, earlierRecord, "plan", "1", fakeSpawn(h));
			expect(probe.killed).toEqual([FIRST_ROOT, SECOND_ROOT]);
			expect(code(result)).toBe("launch-timeout");
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeoutWindowClosed());
			expect(eventsOf(h)).toHaveLength(1);
			expect(eventsOf(h)[0].text).toBe(messagesFor("en").session.launchBlockedScreenEvent(ID, 1, `${FIRST_ROOT}, ${SECOND_ROOT}`, ""));
		});
		test("an empty screen is no excerpt", async () => {
			const h = setup();
			seedLaunchers(h);
			probeWindow(h, windowTable(), ok("\n  \n"));
			const result = await runSession(h.runtime, earlierRecord, "plan", "1", fakeSpawn(h));
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeoutWindowClosed());
		});
		test("no process of this launch in the table gives the plain timeout, no kill and no event", async () => {
			const h = setup();
			seedLaunchers(h);
			const probe = probeWindow(h, windowTable().filter((entry) => entry.pid < FIRST_ROOT || entry.pid >= 200), ok(SCREEN));
			const result = await runSession(h.runtime, earlierRecord, "plan", "1", fakeSpawn(h));
			expect(code(result)).toBe("launch-timeout");
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeout());
			expect(probe).toEqual({ killed: [], read: [] });
			expect(eventsOf(h)).toEqual([]);
		});
		test("a host with no process table gives the plain timeout", async () => {
			const h = setup();
			seedLaunchers(h);
			recordedProcessGone(h);
			h.runtime.process.listProcesses = async () => err("no process table");
			const result = await runSession(h.runtime, earlierRecord, "plan", "1", fakeSpawn(h));
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeout());
			expect(eventsOf(h)).toEqual([]);
		});
		test("a launch that registers closes nothing", async () => {
			const h = setup();
			seedLaunchers(h);
			const probe = probeWindow(h, windowTable(), ok(SCREEN));
			h.runtime.process.createdAt = async () => ok({ "43": CREATED });
			const result = await runSession(h.runtime, session, "plan", "1", fakeSpawn(h, () => h.fs.seed(`${ROOT}/sessions/${ID}.json`, recordWith(43, CREATED))));
			expect(code(result)).toBe("ok");
			expect(probe).toEqual({ killed: [], read: [] });
			expect(eventsOf(h)).toEqual([]);
		});
		test("a kill that could not be done leaves the plain timeout and no event", async () => {
			const h = setup();
			seedLaunchers(h);
			probeWindow(h, windowTable(), ok(SCREEN));
			h.runtime.process.killTree = async () => err("taskkill did not start");
			const result = await runSession(h.runtime, earlierRecord, "plan", "1", fakeSpawn(h));
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeout());
			expect(eventsOf(h)).toEqual([]);
		});
		test("the mode switch gives up the same way", async () => {
			const h = setup();
			seedLaunchers(h);
			h.fs.seed("/transcript", `${ownerLine(DEFAULT_LOGIN, ID)}\n${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`);
			h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: EARLIER_PID, ended_at: null }));
			answerAccountLookup(h, '{"accounts":{"/cfg/1-test":{"present":true,"account":1}},"categories":{}}');
			const probe = probeWindow(h, windowTable(), ok(SCREEN));
			const result = await modeCommand(h.runtime, [ID, "auto"], () => {});
			expect(code(result)).toBe("launch-timeout");
			expect(result.ok ? "" : result.error.message).toBe(messagesFor("en").session.launchTimeoutWindowClosedScreen(SCREEN));
			expect(probe.killed).toEqual([FIRST_ROOT, SECOND_ROOT]);
		});
	});
	test("CLI writes one JSON object on a mode success and run failure", async () => {
		const h = setup();
		h.fs.seed("/transcript", JSON.stringify({ type: "permission-mode", permissionMode: "plan" }));
		for (const args of [["session", "mode", ID, "plan"], ["session", "run", "missing"]]) {
			const output: string[] = [];
			await runCli(args, (line) => output.push(line), h.runtime);
			expect(output).toHaveLength(1);
			expect(typeof JSON.parse(output[0])).toBe("object");
		}
	});
});

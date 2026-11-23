import type { Platform } from "../src/feature.js";
import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { findCswap, launchRegistrationDeadline, modeCommand, prepareLaunch, resolveLaunch, runSession, transcriptMode } from "../src/commands/session-run.js";
import { buildLaunchCommand } from "../src/launch-command.js";
import { messagesFor } from "../src/messages.js";
import { lookupSession } from "../src/session-core.js";
import { apiFail, apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { baseManifest, createMemoryRuntime, FAKE_OWNER_CREATED, seedFeature, seedHubManifest } from "./fakes/memory-runtime.js";

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
const prepare = async (h: ReturnType<typeof createMemoryRuntime>, record: SessionRecord, account: string, mode: string | null) => prepareLaunch(h.runtime, record, account, mode, await findCswap(h.runtime));
const setup = () => {
	const h = createMemoryRuntime();
	h.fs.directories.add("/work");
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify(raw));
	h.fs.seed("/transcript", "{}");
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
		await runSession(h.runtime, session, "plan", null, async () => apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime())));
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
			const result = await runSession(h.runtime, session, "plan", null, async () => { launched = true; return apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime())); });
			expect(code(result)).toBe("launch-account-lookup");
			expect(launched).toBe(false);
		}
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		const failed = await runSession(h.runtime, session, "plan", null, async () => apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime())));
		expect(failed.ok ? "ok" : failed.error.message).toContain("broken");
	});
	test("account helper failure with cswap absent still launches without an account", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/tmux", "");
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		let launched = false;
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		const result = await runSession(h.runtime, session, "plan", null, async () => { launched = true; h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null })); return apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime())); });
		expect(launched).toBe(true);
		expect(result).toEqual(apiOk({ session: ID, pid: 43, mode: "plan", account: null }));
	});
	test("a recorded account without cswap is refused like a requested one", async () => {
		const h = setup();
		h.fs.seed("/usr/bin/tmux", "");
		h.runtime.process.run = async () => ok({ stdout: '{"accounts":{"/cfg/1-test":{"present":true,"account":12}},"categories":{}}', stderr: "", exitCode: 0 });
		let launched = false;
		const result = await runSession(h.runtime, session, "plan", null, async () => { launched = true; return apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime())); });
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
		expect(code(await runSession(h.runtime, session, "plan", "1", async () => apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime()))))).toBe("launch-timeout");
	});
	test("reports stderr from detached launch failure", async () => {
		const h = setup();
		seedLaunchers(h);
		h.runtime.process.spawnDetached = async () => ({ ok: false, error: "launch error" });
		const result = await runSession(h.runtime, session, "plan", "1");
		expect(result.ok ? "ok" : result.error.message).toContain("launch error");
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
		const answer = await runSession(h.runtime, session, "plan", "1", async () => { h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null })); return apiOk(launchRegistrationDeadline(h.runtime.clock.now().getTime())); });
		expect(answer).toEqual(apiOk({ session: ID, pid: 43, mode: "plan", account: 1 }));
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

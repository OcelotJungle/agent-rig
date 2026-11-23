import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { autocompactSession } from "../src/commands/session-autocompact.js";
import { compactSession } from "../src/commands/session-compact.js";
import { renameSession } from "../src/commands/session-rename.js";
import { SESSION_ENDED, SESSION_MODULE_ERROR, SESSION_NO_MODULE } from "../src/output.js";
import { AUTOCOMPACT_TIMEOUT_MS, COMPACT_TIMEOUT_MS, SESSION_TIMEOUTS } from "../src/session-core.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const CREATED = "2026-01-01T00:00:00.000000Z";
const record: SessionRecord = { id: "abc", cwd: "/work", transcriptPath: "/transcript", copyOf: null, startedAt: "2026-01-01T00:00:00Z", processes: [{ pid: 42, pidCreated: CREATED, startedAt: "2026-01-01T00:00:00Z" }] };
const raw = { session_id: record.id, cwd: record.cwd, transcript_path: record.transcriptPath, started_at: record.startedAt };
const processFile = { pid: 42, pid_created: CREATED, started_at: record.startedAt, source: "startup", config_dir: "" };

const setup = (response: unknown) => {
	const harness = createMemoryRuntime();
	harness.fs.seed(`${ROOT}/abc.json`, JSON.stringify(raw));
	harness.fs.seed("/transcript", "{}");
	harness.fs.seed(`${ROOT}/abc/usage.json`, "{}");
	harness.fs.seed(`${ROOT}/abc/processes/42.json`, JSON.stringify(processFile));
	harness.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: response }));
	harness.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), CREATED])));
	return harness;
};

const errorCode = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;

describe("session compact and rename", () => {
	test("rejects non-finite compact counts", async () => {
		const harness = setup(null);
		harness.fs.seed(`${ROOT}/abc/responses/event-1.json`, '{"id":"event-1","ok":true,"result":{"tokensBefore":1e999,"tokensAfter":1}}');
		expect(errorCode(await compactSession(harness.runtime, ["abc"], () => {}))).toBe("session-bad-response");
	});
	test("compact returns raw token counts and forwards instructions with the compact timeout", async () => {
		const harness = setup({ tokensBefore: 100, tokensAfter: 40 });
		let request: string | undefined;
		const writeText = harness.fs.writeText.bind(harness.fs);
		harness.fs.writeText = async (path, value) => {
			if (path.endsWith(".tmp")) request = value;
			await writeText(path, value);
		};
		const result = await compactSession(harness.runtime, ["abc", "--instructions", "keep decisions", "and constraints"], () => {});
		expect(result).toEqual({ ok: true, value: { session: "abc", tokensBefore: 100, tokensAfter: 40 } });
		expect(SESSION_TIMEOUTS.compact).toBe(COMPACT_TIMEOUT_MS);
		expect(JSON.parse(request ?? "null")).toMatchObject({ op: "compact", args: { instructions: "keep decisions and constraints" } });
		expect(harness.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
	});

	test("compact reports a hook skip as success data", async () => {
		const harness = setup({ skip: "vetoed" });
		expect(await compactSession(harness.runtime, ["abc"], () => {})).toEqual({ ok: true, value: { session: "abc", skip: "vetoed" } });
	});

	test("both operations report module errors", async () => {
		for (const run of [
			(runtime: ReturnType<typeof setup>["runtime"]) => compactSession(runtime, ["abc"], () => {}),
			(runtime: ReturnType<typeof setup>["runtime"]) => renameSession(runtime, ["abc", "new name"], () => {}),
		]) {
			const harness = setup(null);
			harness.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: false, error: "module failed" }));
			expect(errorCode(await run(harness.runtime))).toBe(SESSION_MODULE_ERROR);
		}
	});

	test("both operations reject an ended session before requesting the module", async () => {
		for (const run of [
			(runtime: ReturnType<typeof setup>["runtime"]) => compactSession(runtime, ["abc"], () => {}),
			(runtime: ReturnType<typeof setup>["runtime"]) => renameSession(runtime, ["abc", "new name"], () => {}),
		]) {
			const harness = setup(null);
			harness.runtime.process.createdAt = async () => ok({ "42": "different" });
			expect(errorCode(await run(harness.runtime))).toBe(SESSION_ENDED);
		}
	});

	test("both operations report a missing module through the core", async () => {
		for (const run of [
			(runtime: ReturnType<typeof setup>["runtime"]) => compactSession(runtime, ["abc"], () => {}),
			(runtime: ReturnType<typeof setup>["runtime"]) => renameSession(runtime, ["abc", "new name"], () => {}),
		]) {
			const harness = setup(null);
			harness.fs.files.delete(`${ROOT}/abc/usage.json`);
			expect(errorCode(await run(harness.runtime))).toBe(SESSION_NO_MODULE);
		}
	});

	test("rename joins arguments and returns the module name", async () => {
		const harness = setup({ name: "new name" });
		let request: string | undefined;
		const writeText = harness.fs.writeText.bind(harness.fs);
		harness.fs.writeText = async (path, value) => {
			if (path.endsWith(".tmp")) request = value;
			await writeText(path, value);
		};
		expect(await renameSession(harness.runtime, ["abc", "new", "name"], () => {})).toEqual({ ok: true, value: { session: "abc", name: "new name" } });
		expect(JSON.parse(request ?? "null")).toMatchObject({ op: "rename", args: { name: "new name" } });
	});

	test("rename rejects an empty trimmed name", async () => {
		const harness = setup(null);
		expect(errorCode(await renameSession(harness.runtime, ["abc", "  "], () => {}))).toBe("usage");
	});

	test("autocompact sends the window and returns it with the command text", async () => {
		for (const [arg, window] of [["333000", 333000], ["auto", "auto"]] as const) {
			const harness = setup({ window, text: "Auto-compact window set" });
			let request: string | undefined;
			const writeText = harness.fs.writeText.bind(harness.fs);
			harness.fs.writeText = async (path, value) => {
				if (path.endsWith(".tmp")) request = value;
				await writeText(path, value);
			};
			expect(await autocompactSession(harness.runtime, ["abc", arg], () => {})).toEqual({ ok: true, value: { session: "abc", window, text: "Auto-compact window set" } });
			expect(JSON.parse(request ?? "null")).toMatchObject({ op: "autocompact", args: { window } });
		}
		expect(SESSION_TIMEOUTS.autocompact).toBe(AUTOCOMPACT_TIMEOUT_MS);
	});

	test("autocompact omits text when the command returned none", async () => {
		const harness = setup({ window: "auto" });
		expect(await autocompactSession(harness.runtime, ["abc", "auto"], () => {})).toEqual({ ok: true, value: { session: "abc", window: "auto" } });
	});

	test("autocompact accepts only decimal digits above zero or auto", async () => {
		for (const bad of ["0", "-5", "333k", "1.5", "1e3", "AUTO", "", "0x10", "+5", "007x"]) {
			expect(errorCode(await autocompactSession(setup(null).runtime, ["abc", bad], () => {}))).toBe("usage");
		}
		expect(errorCode(await autocompactSession(setup(null).runtime, ["abc"], () => {}))).toBe("usage");
		expect(errorCode(await autocompactSession(setup(null).runtime, ["abc", "5", "6"], () => {}))).toBe("usage");
		expect(errorCode(await autocompactSession(setup(null).runtime, ["abc", "99999999999999999999"], () => {}))).toBe("usage");
	});

	test("autocompact rejects a response without the window", async () => {
		expect(errorCode(await autocompactSession(setup({ text: "x" }).runtime, ["abc", "auto"], () => {}))).toBe("session-bad-response");
	});

	test("autocompact reports module errors, an ended session and a missing module", async () => {
		const failed = setup(null);
		failed.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: false, error: "module failed" }));
		expect(errorCode(await autocompactSession(failed.runtime, ["abc", "auto"], () => {}))).toBe(SESSION_MODULE_ERROR);
		const ended = setup(null);
		ended.runtime.process.createdAt = async () => ok({ "42": "different" });
		expect(errorCode(await autocompactSession(ended.runtime, ["abc", "auto"], () => {}))).toBe(SESSION_ENDED);
		const none = setup(null);
		none.fs.files.delete(`${ROOT}/abc/usage.json`);
		expect(errorCode(await autocompactSession(none.runtime, ["abc", "auto"], () => {}))).toBe(SESSION_NO_MODULE);
	});

	test("autocompact runs through the CLI as one JSON object", async () => {
		const harness = setup({ window: 200000 });
		const output: string[] = [];
		expect(await runCli(["session", "autocompact", "abc", "200000"], (line) => output.push(line), harness.runtime)).toBe(0);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toEqual({ session: "abc", window: 200000 });
		const bad: string[] = [];
		expect(await runCli(["session", "autocompact", "abc", "333k"], (line) => bad.push(line), setup(null).runtime)).toBe(1);
		expect(JSON.parse(bad[0])).toHaveProperty("error.code", "usage");
	});

	test("both CLI subcommands keep success and failure output to one JSON object", async () => {
		for (const [args, response] of [
			[["session", "compact", "abc"], { tokensBefore: 100, tokensAfter: 40 }],
			[["session", "rename", "abc", "new name"], { name: "new name" }],
		] as const) {
			const harness = setup(response);
			const output: string[] = [];
			const code = await runCli([...args], (line) => output.push(line), harness.runtime);
			expect(code).toBe(0);
			expect(output).toHaveLength(1);
			expect(JSON.parse(output[0])).toEqual({ session: "abc", ...response });
		}
		const harness = setup(null);
		const output: string[] = [];
		const code = await runCli(["session", "rename", "abc"], (line) => output.push(line), harness.runtime);
		expect(code).toBe(1);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toHaveProperty("error.code", "usage");
	});
});

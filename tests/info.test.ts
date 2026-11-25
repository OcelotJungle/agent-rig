import type { RigState } from "../src/state.js";
import type { RuntimePorts } from "../src/ports.js";
import type { Result } from "../src/result.js";
import type { ProcessOptions, ProcessOutput } from "../src/ports.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { TAIL_BLOCK_BYTES, parseRolloutLimits } from "../src/codex-rollout.js";
import { messagesFor } from "../src/messages.js";
import { PROCESS_FAILURE_EXIT_CODE, PROCESS_SUCCESS_EXIT_CODE } from "../src/ports.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SESSIONS = `${HOME}/.agent-rig/sessions`;
const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SECONDS = 1000;
const FAILURE_EXIT_CODE = 1;
const SCRIPT_FAILURE_CODE = 2;
const TOOLS_DIRECTORY = `${REPO}/features/volunteers/tools`;
const ROLLOUT_DIRECTORY = `${HOME}/.codex/sessions/2026/10/29`;
const VOLUNTEER_TIMEOUT_MS = 5000;
const OWN_ID = "11111111-aaaa";
const SAME_ACCOUNT_ID = "22222222-bbbb";
const OTHER_ACCOUNT_ID = "33333333-cccc";
const OWN_DIRECTORY = "/cfg/1-own";
const SAME_ACCOUNT_DIRECTORY = "/cfg/1-twin";
const OTHER_ACCOUNT_DIRECTORY = "/cfg/2-other";
const SINGLE_OUTPUT_LINE = 1;
const HELPER_MESSAGE = "boom";

type Harness = ReturnType<typeof createMemoryRuntime>;
const PROJECT_DIRECTORY = "/work/project";
const DENIED_DIRECTORY = "/work/denied";
const ACCOUNT_SCRIPT = "cswap-account.py";
const DENYLIST_SCRIPT = "project-denylist.py";
type Tool = { accounts: Record<string, number | null>; allowed: Record<string, boolean>; deniedProjects: string[]; volunteers: (options?: ProcessOptions) => Result<ProcessOutput>; failure?: Result<ProcessOutput>; denylistFailure?: Result<ProcessOutput>; rawAccounts?: Record<string, unknown>; rawCategories?: Record<string, unknown> };

const iso = (ms: number): string => new Date(ms).toISOString();

const seedState = (harness: Harness, features: Record<string, boolean>): void => {
	const state: RigState = { mode: "dev", paths: { repo: REPO, hub: "/hub" }, features, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE_PATH, JSON.stringify(state));
};

const seedSession = (harness: Harness, id: string, configDir: string, usage?: unknown, cwd: string | null = PROJECT_DIRECTORY): void => {
	harness.fs.seed(`${SESSIONS}/${id}.json`, JSON.stringify({ session_id: id, config_dir: configDir, cwd, transcript_path: null, started_at: iso(NOW) }));
	if (usage !== undefined) harness.fs.seed(`${SESSIONS}/${id}/usage.json`, JSON.stringify(usage));
};

const claudeUsage = (at: number, fiveHour: number, week: number, resetFive: number, resetWeek: number, context: unknown = { tokens: 120000, breakdown: { totalTokens: 118000, autoCompactThreshold: 300000, isAutoCompactEnabled: true } }): unknown => ({
	at: iso(at),
	context,
	rateLimits: [
		{ kind: "seven_day", percentUsed: week, resetsAt: iso(resetWeek) },
		{ kind: "five_hour", percentUsed: fiveHour, resetsAt: iso(resetFive) },
	],
});

const stdout = (value: unknown): Result<ProcessOutput> => ok({ stdout: JSON.stringify(value), stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });

// The runtime whose python calls (the account tool, the project denylist tool and the volunteer script) are answered from `tool`.
// The denylist answers `allowed: false` for a category the tool does not allow and for a project listed in `deniedProjects`.
const withTool = (harness: Harness, tool: Tool, language: RuntimePorts["language"] = "en"): RuntimePorts => ({
	...harness.runtime,
	language,
	process: {
		...harness.runtime.process,
		run: async (command, args, options) => {
			harness.processCalls.push({ command, args, options });
			const [, script, subcommand, third] = args;
			if (script.endsWith(ACCOUNT_SCRIPT) && subcommand === "batch") {
				if (tool.failure) return tool.failure;
				const accounts: Record<string, unknown> = {};
				for (let index = 3; index < args.length; index += 2) {
					const name = args[index + 1];
					if (args[index] === "--config-dir") accounts[name] = { present: true, account: tool.accounts[name] ?? null };
				}
				return stdout({ accounts: { ...accounts, ...tool.rawAccounts } });
			}
			if (script.endsWith(DENYLIST_SCRIPT) && subcommand === "batch") {
				if (tool.failure) return tool.failure;
				if (tool.denylistFailure) return tool.denylistFailure;
				const projectDirectory = args[args.indexOf("--project-dir") + 1];
				const categories: Record<string, unknown> = {};
				for (let index = 3; index < args.length; index += 2) {
					const name = args[index + 1];
					if (args[index] === "--category") categories[name] = { allowed: tool.allowed[name] === true && !tool.deniedProjects.includes(projectDirectory), reason: "" };
				}
				return stdout({ categories: { ...categories, ...tool.rawCategories } });
			}
			if (script.endsWith(DENYLIST_SCRIPT) && subcommand === "check") {
				return stdout({ allowed: tool.allowed[third] === true, reason: "" });
			}
			if (script.endsWith("volunteer-models.py")) return tool.volunteers(options);
			return ok({ stdout: "", stderr: "unexpected", exitCode: PROCESS_FAILURE_EXIT_CODE });
		},
	},
});

const noVolunteers = (): Result<ProcessOutput> => ok({ stdout: "", stderr: "", exitCode: PROCESS_FAILURE_EXIT_CODE });

const tool = (overrides: Partial<Tool> = {}): Tool => ({
	accounts: { [OWN_DIRECTORY]: 1, [SAME_ACCOUNT_DIRECTORY]: 1, [OTHER_ACCOUNT_DIRECTORY]: 2 },
	allowed: { codex: true, volunteers: true },
	deniedProjects: [],
	volunteers: noVolunteers,
	...overrides,
});

type Run = { code: number; output: string[] };

const run = async (runtime: RuntimePorts, args: string[]): Promise<Run> => {
	const output: string[] = [];
	const code = await runCli(args, (line) => output.push(line), runtime);
	return { code, output };
};

// The one JSON object a command prints; fails the test when stdout is anything else.
const printed = (result: Run): unknown => {
	expect(result.output).toHaveLength(SINGLE_OUTPUT_LINE);
	return JSON.parse(result.output[0]);
};

const failure = (code: string, message: string): { code: number; body: unknown } => ({ code: FAILURE_EXIT_CODE, body: { error: { code, message } } });
const failed = (result: Run): { code: number; body: unknown } => ({ code: result.code, body: printed(result) });

const rolloutLine = (at: number, primary: unknown, secondary: unknown): string => JSON.stringify({
	timestamp: iso(at),
	type: "event_msg",
	payload: { type: "token_count", rate_limits: { limit_id: "codex", primary, secondary } },
});

const seedRollout = (harness: Harness, name: string, text: string): void => {
	harness.fs.seed(`${ROLLOUT_DIRECTORY}/${name}`, text);
};

const seedVolunteerScript = (harness: Harness): void => {
	harness.fs.seed(`${TOOLS_DIRECTORY}/volunteer-models.py`, "# stub");
};

const baseHarness = (features: Record<string, boolean>): Harness => {
	const harness = createMemoryRuntime();
	seedState(harness, features);
	return harness;
};

const infoOf = async (runtime: RuntimePorts): Promise<unknown> => {
	const result = await run(runtime, ["info", "--session", OWN_ID]);
	expect(result.code).toBe(PROCESS_SUCCESS_EXIT_CODE);
	return printed(result);
};

describe("rig info", () => {
	test("prints the raw readings of every block: freshest same-account Claude limits, Codex, volunteers, context", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 10 * MINUTE, 10, 40, NOW + 150 * MINUTE, NOW + 3 * DAY));
		seedSession(harness, SAME_ACCOUNT_ID, SAME_ACCOUNT_DIRECTORY, claudeUsage(NOW - 2 * MINUTE, 25.5, 41, NOW + HOUR, NOW + 3 * DAY));
		seedSession(harness, OTHER_ACCOUNT_ID, OTHER_ACCOUNT_DIRECTORY, claudeUsage(NOW - MINUTE, 99, 99, NOW + HOUR, NOW + 3 * DAY));
		seedRollout(harness, "rollout-2026-10-29T10-00-00-abc.jsonl", [
			rolloutLine(NOW - 5 * HOUR, { used_percent: 1, window_minutes: 300 }, null),
			rolloutLine(NOW - HOUR, { used_percent: 12.4, window_minutes: 300, resets_at: (NOW + 30 * MINUTE) / SECONDS }, { used_percent: 50, window_minutes: 10080, resets_at: (NOW - HOUR) / SECONDS }),
			"",
		].join("\n"));
		seedVolunteerScript(harness);
		const volunteers = (): Result<ProcessOutput> => stdout({
			source: "proxy",
			checked_at: iso(NOW - 6 * MINUTE),
			error: null,
			day_percent: 42.4,
			reset_in_s: 7200,
			providers: { openrouter: { used: 3, cap: 10 }, groq: { used: 1, cap: null }, custom: { used: 2, cap: 5 } },
		});

		const result = await run(withTool(harness, tool({ volunteers })), ["info", "--session", OWN_ID]);

		expect(result.code).toBe(PROCESS_SUCCESS_EXIT_CODE);
		const body = printed(result);
		expect(body).toEqual({
			session: OWN_ID,
			account: 1,
			claude: {
				at: iso(NOW - 2 * MINUTE),
				sessionId: SAME_ACCOUNT_ID,
				limits: [
					{ kind: "seven_day", percentUsed: 41, resetsAt: iso(NOW + 3 * DAY) },
					{ kind: "five_hour", percentUsed: 25.5, resetsAt: iso(NOW + HOUR) },
				],
			},
			codex: {
				at: iso(NOW - HOUR),
				limits: [
					{ windowMinutes: 300, usedPercent: 12.4, resetsAt: iso(NOW + 30 * MINUTE) },
					{ windowMinutes: 10080, usedPercent: 50, resetsAt: iso(NOW - HOUR) },
				],
			},
			volunteers: {
				at: iso(NOW - 6 * MINUTE),
				source: "proxy",
				dayPercent: 42.4,
				used: null,
				cap: null,
				resetsAt: iso(NOW - 6 * MINUTE + 7200 * SECONDS),
				providers: { openrouter: { used: 3, cap: 10 }, groq: { used: 1, cap: null }, custom: { used: 2, cap: 5 } },
			},
			context: { at: iso(NOW - 10 * MINUTE), tokens: 120000, window: null, threshold: 300000, autocompact: true },
		});
		expect(Object.keys(body ?? {})).toEqual(["session", "account", "claude", "codex", "volunteers", "context"]);
		const volunteerCall = harness.processCalls.find((call) => call.args.some((argument) => argument.endsWith("volunteer-models.py")));
		expect(volunteerCall?.args).toEqual(["-I", `${TOOLS_DIRECTORY}/volunteer-models.py`, "limits", "--json"]);
	});

	test("the codex and volunteers keys are absent when the feature is off or the category is not allowed", async () => {
		const usage = claudeUsage(NOW, 10, 40, NOW + HOUR, NOW + DAY);
		const keys = ["session", "account", "claude", "context"];

		const featureOff = baseHarness({ codex: false, volunteers: false });
		seedSession(featureOff, OWN_ID, OWN_DIRECTORY, usage);
		expect(Object.keys(await infoOf(withTool(featureOff, tool())) ?? {})).toEqual(keys);
		expect(featureOff.processCalls.filter((call) => call.args[1].endsWith(DENYLIST_SCRIPT))).toHaveLength(0);

		const refused = baseHarness({ codex: true, volunteers: true });
		seedSession(refused, OWN_ID, OWN_DIRECTORY, usage);
		expect(Object.keys(await infoOf(withTool(refused, tool({ allowed: { codex: false, volunteers: false } }))) ?? {})).toEqual(keys);
		expect(refused.processCalls.filter((call) => call.args[1].endsWith(DENYLIST_SCRIPT) && call.args[2] === "batch")).toHaveLength(1);
	});

	test("a session in a denied project hides the codex and volunteers blocks; one in an allowed project shows them", async () => {
		const usage = claudeUsage(NOW, 10, 40, NOW + HOUR, NOW + DAY);
		const denied = baseHarness({ codex: true, volunteers: true });
		seedSession(denied, OWN_ID, OWN_DIRECTORY, usage, DENIED_DIRECTORY);
		const deniedRuntime = withTool(denied, tool({ deniedProjects: [DENIED_DIRECTORY] }));
		expect(Object.keys(await infoOf(deniedRuntime) ?? {})).toEqual(["session", "account", "claude", "context"]);

		const allowed = baseHarness({ codex: true, volunteers: true });
		seedSession(allowed, OWN_ID, OWN_DIRECTORY, usage, PROJECT_DIRECTORY);
		expect(Object.keys(await infoOf(withTool(allowed, tool({ deniedProjects: [DENIED_DIRECTORY] }))) ?? {})).toEqual(["session", "account", "claude", "codex", "volunteers", "context"]);
	});

	test("the denylist is asked about the session's project directory and the enabled categories only", async () => {
		const harness = baseHarness({ codex: true, volunteers: false });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, undefined, DENIED_DIRECTORY);

		await infoOf(withTool(harness, tool()));

		const calls = harness.processCalls.filter((call) => call.args[1].endsWith(DENYLIST_SCRIPT));
		expect(calls).toHaveLength(1);
		expect(calls[0].args).toEqual(["-I", `${REPO}/base/tools/${DENYLIST_SCRIPT}`, "batch", "--project-dir", DENIED_DIRECTORY, "--category", "codex"]);
	});

	test("a session without a known project directory fails the enabled blocks, never allows them", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 10, 40, NOW + HOUR, NOW + DAY), null);

		const body = await infoOf(withTool(harness, tool()));

		const message = messagesFor("en").info.noProjectDirectory();
		expect(body).toMatchObject({
			account: 1,
			codex: { error: { code: "script-failed", message } },
			volunteers: { error: { code: "script-failed", message } },
		});
		expect(harness.processCalls.filter((call) => call.args[1].endsWith(DENYLIST_SCRIPT))).toHaveLength(0);
	});

	test("a failing denylist process fails only the codex and volunteers blocks; the account and claude blocks stay", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 10, 40, NOW + HOUR, NOW + DAY));

		const body = await infoOf(withTool(harness, tool({ denylistFailure: err("denylist spawn failed") })));

		expect(body).toMatchObject({
			account: 1,
			claude: { limits: [{ kind: "seven_day" }, { kind: "five_hour" }] },
			codex: { error: { code: "script-failed", message: "Project denylist helper: denylist spawn failed" } },
			volunteers: { error: { code: "script-failed", message: "Project denylist helper: denylist spawn failed" } },
		});
	});

	test("failed helper processes make every dependent block an error", async () => {
		const failures: Array<[Result<ProcessOutput>, string]> = [
			[err("spawn failed"), "spawn failed"],
			[err("timed out"), "timed out"],
			[ok({ stdout: "", stderr: "diagnostic", exitCode: SCRIPT_FAILURE_CODE }), "code 2: diagnostic"],
			[ok({ stdout: "garbage", stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE }), "invalid JSON"],
			[stdout({ accounts: {}, categories: {} }), "invalid"],
		];
		for (const [failure, message] of failures) {
			const harness = baseHarness({ codex: true, volunteers: true });
			seedSession(harness, OWN_ID, OWN_DIRECTORY);
			const body = await infoOf(withTool(harness, tool({ failure })));
			const text = JSON.stringify(body);
			for (const name of ["claude", "codex", "volunteers"]) expect(text).toContain(`"${name}":{"error"`);
			expect(text).toContain(message);
		}
	});

	const seedThreeSessions = (harness: Harness): void => {
		for (const [id, directory, at] of [[OWN_ID, OWN_DIRECTORY, NOW - 20 * MINUTE], [SAME_ACCOUNT_ID, SAME_ACCOUNT_DIRECTORY, NOW - 10 * MINUTE], [OTHER_ACCOUNT_ID, OTHER_ACCOUNT_DIRECTORY, NOW]] as const) {
			seedSession(harness, id, directory, claudeUsage(at, 1, 2, NOW + HOUR, NOW + DAY));
		}
	};

	test("one malformed account entry of another session is that session's error; the rest of the claude block is normal", async () => {
		const malformed: Array<Record<string, unknown>> = [{ [OTHER_ACCOUNT_DIRECTORY]: { present: "yes", account: 2 } }, { [OTHER_ACCOUNT_DIRECTORY]: { error: "ValueError: boom" } }];
		for (const rawAccounts of malformed) {
			const harness = baseHarness({ codex: true, volunteers: true });
			seedThreeSessions(harness);
			const body = await infoOf(withTool(harness, tool({ rawAccounts })));
			expect(body).toMatchObject({
				account: 1,
				claude: { sessionId: SAME_ACCOUNT_ID, skipped: [{ sessionId: OTHER_ACCOUNT_ID, error: { code: "script-failed" } }] },
			});
		}
	});

	test("an account that raised in the helper fails only the claude block when it is the session's own", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedThreeSessions(harness);
		const body = await infoOf(withTool(harness, tool({ rawAccounts: { [OWN_DIRECTORY]: { error: "ValueError: boom" } } })));
		const text = JSON.stringify(body);
		expect(text).toContain("\"claude\":{\"error\":{\"code\":\"script-failed\"");
		expect(text).toContain("boom");
		expect(body).toMatchObject({ account: null });
		expect(text.split(HELPER_MESSAGE)).toHaveLength(2);
	});

	test("a category that raised in the helper fails only its own block", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedThreeSessions(harness);
		const body = await infoOf(withTool(harness, tool({ rawCategories: { codex: { error: "OSError: boom" } } })));
		const text = JSON.stringify(body);
		expect(text).toContain("\"codex\":{\"error\":{\"code\":\"script-failed\"");
		expect(text.split(HELPER_MESSAGE)).toHaveLength(2);
		expect(body).toMatchObject({ account: 1, claude: { sessionId: SAME_ACCOUNT_ID } });
	});

	test("one account process covers all session directories", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		for (const [id, directory] of [[OWN_ID, OWN_DIRECTORY], [SAME_ACCOUNT_ID, SAME_ACCOUNT_DIRECTORY], [OTHER_ACCOUNT_ID, OTHER_ACCOUNT_DIRECTORY]]) {
			seedSession(harness, id, directory, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + DAY));
		}
		await infoOf(withTool(harness, tool()));
		const calls = harness.processCalls.filter((call) => call.args.some((arg) => arg.endsWith(ACCOUNT_SCRIPT)));
		expect(calls).toHaveLength(1);
		expect(calls[0].args).not.toContain("--category");
		for (const directory of [OWN_DIRECTORY, SAME_ACCOUNT_DIRECTORY, OTHER_ACCOUNT_DIRECTORY]) expect(calls[0].args).toContain(directory);
	});

	test("an account that cannot be determined uses only the session's own Claude limits", async () => {
		const harness = baseHarness({});
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 20 * MINUTE, 10, 40, NOW + HOUR, NOW + DAY));
		seedSession(harness, SAME_ACCOUNT_ID, SAME_ACCOUNT_DIRECTORY, claudeUsage(NOW, 77, 78, NOW + HOUR, NOW + DAY));

		const body = await infoOf(withTool(harness, tool({ accounts: {} })));

		expect(body).toMatchObject({ account: null, claude: { at: iso(NOW - 20 * MINUTE), sessionId: OWN_ID, limits: [{ kind: "seven_day", percentUsed: 40 }, { kind: "five_hour", percentUsed: 10 }] } });
	});

	test("carries no ages, durations or display names: only times, numbers and codes", async () => {
		const harness = baseHarness({ volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 5 * MINUTE, 10, 40, NOW + HOUR, NOW + DAY));
		seedVolunteerScript(harness);
		const volunteers = (): Result<ProcessOutput> => stdout({ source: "proxy", checked_at: iso(NOW), day_percent: 1, reset_in_s: 60, providers: { openrouter: { used: 1, cap: 2 } } });

		const result = await run(withTool(harness, tool({ volunteers })), ["info", "--session", OWN_ID]);

		expect(result.output.join("\n")).not.toMatch(/\bold\b|resets in|OpenRouter|\bago\b/);
	});

	test("a session without data fills each available block with its failure and still succeeds", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		const messages = messagesFor("en");

		const result = await run(withTool(harness, tool()), ["info", "--session", OWN_ID]);

		expect(result.code).toBe(PROCESS_SUCCESS_EXIT_CODE);
		expect(printed(result)).toEqual({
			session: OWN_ID,
			account: 1,
			claude: { error: { code: "no-data", message: messages.info.claudeNoData() } },
			codex: { error: { code: "no-rollout", message: messages.info.noCodexRollout() } },
			volunteers: { error: { code: "script-missing", message: messages.info.scriptMissing() } },
			context: { error: { code: "no-data", message: messages.info.noContextData() } },
		});
	});

	test("a failing volunteer script becomes an error block with a code and a reason", async () => {
		const cases: Array<[() => Result<ProcessOutput>, string, string]> = [
			[() => ok({ stdout: "", stderr: "boom\n", exitCode: SCRIPT_FAILURE_CODE }), "script-failed", "script exited with code 2: boom"],
			[() => ok({ stdout: "", stderr: "", exitCode: SCRIPT_FAILURE_CODE }), "script-failed", "script exited with code 2: no stderr"],
			[() => ok({ stdout: "not json", stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE }), "bad-output", "bad JSON from script"],
			[() => stdout({ source: "none", error: "proxy is down" }), "no-source", "proxy is down"],
			[() => stdout({ source: "none", error: null }), "no-source", "no data source"],
		];
		for (const [volunteers, code, message] of cases) {
			const harness = baseHarness({ volunteers: true });
			seedSession(harness, OWN_ID, OWN_DIRECTORY);
			seedVolunteerScript(harness);
			expect(await infoOf(withTool(harness, tool({ volunteers })))).toMatchObject({ volunteers: { error: { code, message } } });
		}
	});

	test("the volunteer reading is raw: the day percent as reported and the reset as a time, even when it has passed", async () => {
		const harness = baseHarness({ volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedVolunteerScript(harness);
		const volunteers = (): Result<ProcessOutput> => stdout({ source: "quota-file", checked_at: iso(NOW - HOUR), day_percent: 80, reset_in_s: 60, providers: {} });

		const body = await infoOf(withTool(harness, tool({ volunteers })));

		expect(body).toMatchObject({ volunteers: { at: iso(NOW - HOUR), source: "quota-file", dayPercent: 80, resetsAt: iso(NOW - HOUR + 60 * SECONDS), providers: {} } });
	});

	test("context carries the exact count, or the estimate marked as such, with the window and the auto-compact threshold when known", async () => {
		const estimated = baseHarness({});
		seedSession(estimated, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + HOUR, { breakdown: { totalTokens: 90400, autoCompactThreshold: 300000, isAutoCompactEnabled: true } }));
		expect(await infoOf(withTool(estimated, tool()))).toMatchObject({
			context: { at: iso(NOW), tokens: 90400, window: null, threshold: 300000, autocompact: true, estimated: true },
		});

		const plain = baseHarness({});
		seedSession(plain, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + HOUR, { breakdown: { totalTokens: 1_540_000, isAutoCompactEnabled: false } }));
		expect(await infoOf(withTool(plain, tool()))).toMatchObject({
			context: { at: iso(NOW), tokens: 1_540_000, window: null, autocompact: false, estimated: true },
		});

		const exact = baseHarness({});
		seedSession(exact, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + HOUR, { tokens: 45600, window: 200000 }));
		expect(await infoOf(withTool(exact, tool()))).toMatchObject({ context: { at: iso(NOW), tokens: 45600, window: 200000 } });
		expect(await infoOf(withTool(exact, tool()))).not.toMatchObject({ context: { estimated: true } });
	});

	test("block failure messages are in rig's language, the codes are not", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		const messages = messagesFor("ru");

		const body = await infoOf(withTool(harness, tool(), "ru"));

		expect(body).toMatchObject({
			claude: { error: { code: "no-data", message: messages.info.claudeNoData() } },
			codex: { error: { code: "no-rollout", message: messages.info.noCodexRollout() } },
		});
	});

	test("a bad or unknown session id fails with a JSON error and exit code 1", async () => {
		const harness = baseHarness({});
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		const runtime = withTool(harness, tool());

		for (const id of ["../x", "a/b", "a\\b", ".hidden", "a..b", " "]) {
			expect(failed(await run(runtime, ["info", "--session", id]))).toEqual(failure("bad-session", `Not a valid session id: ${id}`));
		}
		expect(failed(await run(runtime, ["info", "--session", "missing-id"]))).toEqual(failure("unknown-session", "Unknown session: missing-id"));
		expect(failed(await run(runtime, ["info"]))).toEqual(failure("usage", "Usage: rig info --session <id>"));
		expect(failed(await run(runtime, ["info", "--session"]))).toEqual(failure("usage", "Usage: rig info --session <id>"));
	});

	test("unreadable rig state fails the command with its own code", async () => {
		const harness = createMemoryRuntime();

		const result = await run(withTool(harness, tool()), ["info", "--session", OWN_ID]);

		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(printed(result)).toMatchObject({ error: { code: "state-unreadable" } });
	});
});

describe("rig info source limits", () => {
	test("a hung volunteer script is bounded by a timeout and becomes an error block; the command still exits 0", async () => {
		const harness = baseHarness({ volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedVolunteerScript(harness);
		// The fake process answers like the real runner does once the per-call timeout expires.
		const volunteers = (options?: ProcessOptions): Result<ProcessOutput> =>
			options?.timeoutMs === VOLUNTEER_TIMEOUT_MS ? err("python3 did not finish within 5 seconds and was killed.") : noVolunteers();

		const body = await infoOf(withTool(harness, tool({ volunteers })));

		expect(body).toMatchObject({ volunteers: { error: { code: "script-failed", message: "python3 did not finish within 5 seconds and was killed." } } });
	});

	test("every python helper call carries a timeout", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedVolunteerScript(harness);

		await run(withTool(harness, tool()), ["info", "--session", OWN_ID]);

		expect(harness.processCalls.length).toBeGreaterThan(0);
		for (const call of harness.processCalls) expect(call.options?.timeoutMs).toBeGreaterThan(0);
	});

	test("CODEX_HOME decides where the rollouts are read", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		harness.environment.set("CODEX_HOME", "/custom/codex");
		harness.fs.seed("/custom/codex/sessions/2026/10/29/rollout-a.jsonl", `${rolloutLine(NOW - HOUR, { used_percent: 61, window_minutes: 300 }, null)}\n`);
		seedRollout(harness, "rollout-b.jsonl", `${rolloutLine(NOW - HOUR, { used_percent: 9, window_minutes: 300 }, null)}\n`);

		const body = await infoOf(withTool(harness, tool()));

		expect(body).toMatchObject({ codex: { limits: [{ windowMinutes: 300, usedPercent: 61 }] } });
	});

	test("the newest file by mtime wins over the newest name within a date directory", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedRollout(harness, "rollout-2026-10-29T20-00-00-late-name.jsonl", `${rolloutLine(NOW - 2 * HOUR, { used_percent: 11, window_minutes: 300 }, null)}\n`);
		seedRollout(harness, "rollout-2026-10-29T08-00-00-early-name.jsonl", `${rolloutLine(NOW - HOUR, { used_percent: 77, window_minutes: 300 }, null)}\n`);
		harness.fs.mtimes.set(`${ROLLOUT_DIRECTORY}/rollout-2026-10-29T20-00-00-late-name.jsonl`, NOW - 2 * HOUR);
		harness.fs.mtimes.set(`${ROLLOUT_DIRECTORY}/rollout-2026-10-29T08-00-00-early-name.jsonl`, NOW - HOUR);

		const body = await infoOf(withTool(harness, tool()));

		expect(body).toMatchObject({ codex: { limits: [{ usedPercent: 77 }] } });
	});

	test("the last rate-limit line is found across a block boundary without reading the whole file", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		const wanted = JSON.stringify({
			timestamp: iso(NOW - HOUR),
			type: "event_msg",
			note: "é".repeat(TAIL_BLOCK_BYTES / 8),
			payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 42, window_minutes: 300 }, secondary: null } },
		});
		const older = rolloutLine(NOW - 5 * HOUR, { used_percent: 1, window_minutes: 300 }, null);
		const wantedBytes = new TextEncoder().encode(wanted).length;
		// The wanted line ends up straddling the second block counted from the end of the file.
		const tailBytes = 2 * TAIL_BLOCK_BYTES - Math.floor(wantedBytes / 2);
		const filler = (bytes: number): string => `${"x".repeat(bytes - 1)}\n`;
		const text = `${filler(8 * TAIL_BLOCK_BYTES)}${older}\n${wanted}\n${filler(tailBytes)}`;
		const path = `${ROLLOUT_DIRECTORY}/rollout-big.jsonl`;
		seedRollout(harness, "rollout-big.jsonl", text);
		const size = new TextEncoder().encode(text).length;

		const body = await infoOf(withTool(harness, tool()));

		expect(body).toMatchObject({ codex: { limits: [{ usedPercent: 42 }] } });
		expect(harness.fs.textReads).not.toContain(path);
		const reads = harness.fs.rangeReads.filter((read) => read.path === path);
		expect(reads.length).toBeGreaterThanOrEqual(3);
		expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThan(size / 2);
	});

	test("a match in the last block needs one ranged read", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		const path = `${ROLLOUT_DIRECTORY}/rollout-small.jsonl`;
		seedRollout(harness, "rollout-small.jsonl", `${"y".repeat(3 * TAIL_BLOCK_BYTES)}\n${rolloutLine(NOW - HOUR, { used_percent: 5, window_minutes: 300 }, null)}\n`);

		const body = await infoOf(withTool(harness, tool()));

		expect(body).toMatchObject({ codex: { limits: [{ usedPercent: 5 }] } });
		expect(harness.fs.rangeReads.filter((read) => read.path === path)).toHaveLength(1);
	});
});

describe("Codex rollout parsing", () => {
	test("takes the last rate-limit event and keeps each window's minutes, percent and reset time as reported", () => {
		const text = [
			rolloutLine(NOW - HOUR, { used_percent: 5, window_minutes: 300 }, null),
			"{\"broken\": \"rate_limits\"",
			rolloutLine(NOW, { used_percent: 7, window_minutes: 90, resets_at: 1000 }, { used_percent: 9, window_minutes: 10080 }),
			JSON.stringify({ timestamp: iso(NOW), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "other", primary: { used_percent: 1, window_minutes: 300 } } } }),
		].join("\n");

		expect(parseRolloutLimits(text)).toEqual({
			at: iso(NOW),
			limits: [
				{ windowMinutes: 90, usedPercent: 7, resetsAt: iso(1_000_000) },
				{ windowMinutes: 10080, usedPercent: 9, resetsAt: null },
			],
		});
	});

	test("skips events with invalid windows and text without events", () => {
		expect(parseRolloutLimits(rolloutLine(NOW, { used_percent: -1, window_minutes: 300 }, { used_percent: 1, window_minutes: 0 }))).toBeNull();
		expect(parseRolloutLimits("no events here\n")).toBeNull();
	});

	test("an older rollout answers when the newest one has no limits yet", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedRollout(harness, "rollout-2026-10-29T09-00-00-old.jsonl", `${rolloutLine(NOW - 2 * HOUR, { used_percent: 33, window_minutes: 300, resets_at: (NOW + HOUR) / SECONDS }, null)}\n`);
		seedRollout(harness, "rollout-2026-10-29T11-00-00-new.jsonl", "{\"type\":\"session_meta\"}\n");

		const body = await infoOf(withTool(harness, tool()));

		expect(body).toMatchObject({ codex: { at: iso(NOW - 2 * HOUR), limits: [{ windowMinutes: 300, usedPercent: 33, resetsAt: iso(NOW + HOUR) }] } });
	});
});

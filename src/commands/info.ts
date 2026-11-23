import type { BlockError, ClaudeLimit, ClaudeReading, CodexReading, ContextReading, InfoData, VolunteerProvider, VolunteerReading } from "../info-data.js";
import type { Messages } from "../messages.js";
import type { ApiResult } from "../output.js";
import type { RigState } from "../state.js";
import type { RuntimePorts } from "../ports.js";
import type { Result } from "../result.js";
import type { OwnerIds } from "../session-owner.js";

import { readCodexLimits } from "../codex-rollout.js";
import { joinPath, toSlashPath } from "../file-system.js";
import { isoOrNull } from "../info-data.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk } from "../output.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { err, ok } from "../result.js";
import { readRigState } from "./shared.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MS_PER_SECOND = 1000;
// A python helper that hangs must not hang `rig info`, so each helper call (account and volunteer limits) gets five seconds.
const HELPER_TIMEOUT_MS = 5 * MS_PER_SECOND;
const CODEX_HOME_VARIABLE = "CODEX_HOME";
const ACCOUNT_SCRIPT = "base/tools/account-allowlist.py";
const VOLUNTEER_TOOLS_DIRECTORY = "features/volunteers/tools";
const VOLUNTEER_SCRIPT = "volunteer-models.py";
// Bound diagnostics from an external process, as for launch stderr.
const STDERR_HEAD_LIMIT = 1000;

// Failure codes of `rig info`: a command-level failure fails the whole command, a block-level one fills only its block.
export const INFO_ERROR_BAD_SESSION = "bad-session";
export const INFO_ERROR_UNKNOWN_SESSION = "unknown-session";
export const INFO_ERROR_STATE_UNREADABLE = "state-unreadable";
const BLOCK_NO_DATA = "no-data";
const BLOCK_NO_ROLLOUT = "no-rollout";
const BLOCK_SCRIPT_MISSING = "script-missing";
const BLOCK_SCRIPT_FAILED = "script-failed";
const BLOCK_BAD_OUTPUT = "bad-output";
const BLOCK_NO_SOURCE = "no-source";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrUndefined = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const numberOrNull = (value: unknown): number | null => numberOrUndefined(value) ?? null;

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const blockError = (code: string, message: string): BlockError => ({ error: { code, message } });

const isoText = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? isoOrNull(milliseconds) : null;
};

// One usage.json, as the output carries it.
type Usage = { at: string | null; limits: ClaudeLimit[]; context: ContextReading | null };

const parseLimit = (value: unknown): ClaudeLimit | null => {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	const percentUsed = numberOrUndefined(value.percentUsed);
	if (percentUsed === undefined) return null;
	return { kind: value.kind, percentUsed, resetsAt: isoText(value.resetsAt) };
};

// `tokens` is the exact count; without it the breakdown's total is an estimate.
const parseContext = (value: Record<string, unknown>, at: string | null): ContextReading | null => {
	const context = isRecord(value.context) ? value.context : {};
	const breakdown = isRecord(context.breakdown) ? context.breakdown : {};
	const exact = numberOrUndefined(context.tokens);
	const tokens = exact ?? numberOrUndefined(breakdown.totalTokens);
	if (tokens === undefined) return null;
	const threshold = numberOrUndefined(breakdown.autoCompactThreshold);
	return {
		at,
		tokens,
		window: numberOrNull(context.window),
		...(threshold === undefined ? {} : { threshold }),
		...(typeof breakdown.isAutoCompactEnabled === "boolean" ? { autocompact: breakdown.isAutoCompactEnabled } : {}),
		...(exact === undefined ? { estimated: true as const } : {}),
	};
};

const parseUsage = (text: string): Usage | null => {
	const value = parseJson(text);
	if (!isRecord(value)) return null;
	const at = isoText(value.at);
	const limits = Array.isArray(value.rateLimits)
		? value.rateLimits.flatMap((entry: unknown) => {
			const limit = parseLimit(entry);
			return limit === null ? [] : [limit];
		})
		: [];
	return { at, limits, context: parseContext(value, at) };
};

const readOptionalText = async (runtime: RuntimePorts, path: string): Promise<string | null> => {
	try {
		return await runtime.fs.readText(path);
	} catch {
		return null;
	}
};

const runAllowlistTool = async (runtime: RuntimePorts, state: RigState, messages: Messages, args: readonly string[]): Promise<Result<Record<string, unknown>>> => {
	const result = await runtime.process.run(runtime.pythonCommand, ["-I", joinPath(state.paths.repo, ACCOUNT_SCRIPT), ...args], { timeoutMs: HELPER_TIMEOUT_MS });
	if (!result.ok) return err(messages.info.allowlistFailed(result.error));
	if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(messages.info.allowlistExit(result.value.exitCode, result.value.stderr.trim().slice(0, STDERR_HEAD_LIMIT)));
	const parsed = parseJson(result.value.stdout.trim());
	return isRecord(parsed) ? ok(parsed) : err(messages.info.allowlistBadJson());
};

// The helper answers `{error: text}` for an item whose check raised; the item fails alone.
const itemError = (answer: unknown, messages: Messages): string | null =>
	isRecord(answer) && typeof answer.error === "string" ? messages.info.allowlistItemFailed(answer.error) : null;

const parseAccount = (answer: unknown, messages: Messages): Result<number | null> => {
	const failed = itemError(answer, messages);
	if (failed !== null) return err(failed);
	if (!isRecord(answer) || typeof answer.present !== "boolean" || !(answer.account === null || (typeof answer.account === "number" && Number.isSafeInteger(answer.account)))) return err(messages.info.allowlistBadAccount());
	return ok(answer.account);
};

// The account of one config dir, read from a `batch` answer (`accounts[configDir]`).
const accountInAnswer = (answer: Result<Record<string, unknown>>, configDir: string, messages: Messages): Result<number | null> => {
	if (!answer.ok) return answer;
	const accounts = isRecord(answer.value.accounts) ? answer.value.accounts : {};
	return parseAccount(accounts[configDir], messages);
};

export const accountOf = async (runtime: RuntimePorts, state: RigState, configDir: string): Promise<Result<number | null>> => {
	const messages = messagesFor(runtime.language);
	const answer = await runAllowlistTool(runtime, state, messages, ["batch", "--config-dir", configDir]);
	return accountInAnswer(answer, configDir, messages);
};

// The ids Claude Code compares for the owner of a session, of one cswap account, from the helper's `owner --account N`
// query. The answer is `{accountUuid, organizationUuid}` or `{error: text}`; the values stay in rig's pipe.
export const ownerIdsOf = async (runtime: RuntimePorts, state: RigState, account: number): Promise<Result<OwnerIds>> => {
	const messages = messagesFor(runtime.language);
	const answer = await runAllowlistTool(runtime, state, messages, ["owner", "--account", String(account)]);
	if (!answer.ok) return answer;
	const failed = itemError(answer.value, messages);
	if (failed !== null) return err(failed);
	const { accountUuid, organizationUuid } = answer.value;
	if (typeof accountUuid !== "string" || accountUuid === "" || typeof organizationUuid !== "string" || organizationUuid === "") return err(messages.info.allowlistBadOwner());
	return ok({ accountUuid, organizationUuid });
};

const categoryShown = (state: RigState, category: "codex" | "volunteers", answer: Result<Record<string, unknown>>, messages: Messages): Result<boolean> => {
	if (state.features[category] !== true) return ok(false);
	if (!answer.ok) return answer;
	const categories = answer.value.categories;
	const entry = isRecord(categories) ? categories[category] : undefined;
	const failed = itemError(entry, messages);
	if (failed !== null) return err(failed);
	return isRecord(entry) && typeof entry.allowed === "boolean" ? ok(entry.allowed) : err(messages.info.allowlistBadCategory(category));
};

const sessionsDirectory = (runtime: RuntimePorts): string => joinPath(runtime.home, ".agent-rig", "sessions");

const sessionIdsWithRecords = async (runtime: RuntimePorts): Promise<string[]> => {
	try {
		const entries = await runtime.fs.listDirectory(sessionsDirectory(runtime));
		return entries
			.filter((entry) => !entry.directory && entry.name.endsWith(".json"))
			.map((entry) => entry.name.slice(0, -".json".length))
			.filter((id) => SAFE_SESSION_ID.test(id) && !id.includes(".."));
	} catch {
		return [];
	}
};

const readingTime = (usage: Usage): number => usage.at === null ? Number.NEGATIVE_INFINITY : Date.parse(usage.at);

// The limits belong to the account, so the freshest reading among the sessions of the same account wins. An account
// that cannot be determined means only this session's own reading.
const freshestClaudeLimits = (
	sessionId: string,
	account: number | null,
	own: Usage | null,
	others: Array<{ sessionId: string; directory: string; usage: Usage }>,
	accounts: Record<string, unknown>,
	messages: Messages,
): Result<ClaudeReading | null> => {
	const candidates: Array<{ sessionId: string; usage: Usage }> = own === null ? [] : [{ sessionId, usage: own }];
	const skipped: Array<{ sessionId: string } & BlockError> = [];
	if (account !== null) {
		for (const other of others) {
			const otherAccount = parseAccount(accounts[other.directory], messages);
			if (!otherAccount.ok) skipped.push({ sessionId: other.sessionId, ...blockError(BLOCK_SCRIPT_FAILED, otherAccount.error) });
			else if (otherAccount.value === account) candidates.push(other);
		}
	}
	let best: { sessionId: string; usage: Usage } | null = null;
	for (const candidate of candidates) {
		if (candidate.usage.limits.length === 0) continue;
		if (best === null || readingTime(candidate.usage) > readingTime(best.usage)) best = candidate;
	}
	if (best === null) return ok(null);
	return ok({ at: best.usage.at, sessionId: best.sessionId, limits: best.usage.limits, ...(skipped.length === 0 ? {} : { skipped }) });
};

const codexBlock = async (runtime: RuntimePorts, messages: Messages): Promise<CodexReading | BlockError> => {
	const codexHome = runtime.environment.get(CODEX_HOME_VARIABLE);
	const reading = await readCodexLimits(runtime.fs, codexHome === undefined || codexHome === "" ? joinPath(runtime.home, ".codex") : toSlashPath(codexHome));
	return reading === null ? blockError(BLOCK_NO_ROLLOUT, messages.info.noCodexRollout()) : reading;
};

const parseProviders = (value: unknown): Record<string, VolunteerProvider> => {
	const providers: Record<string, VolunteerProvider> = {};
	if (!isRecord(value)) return providers;
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		const used = numberOrUndefined(entry.used);
		if (used !== undefined) providers[name] = { used, cap: numberOrNull(entry.cap) };
	}
	return providers;
};

const parseVolunteerOutput = (value: unknown, messages: Messages): VolunteerReading | BlockError => {
	if (!isRecord(value)) return blockError(BLOCK_BAD_OUTPUT, messages.info.scriptBadJson());
	if (value.source === "none") {
		return blockError(BLOCK_NO_SOURCE, typeof value.error === "string" && value.error !== "" ? value.error : messages.info.noSource());
	}
	const at = isoText(value.checked_at);
	const dayPercent = numberOrUndefined(value.day_percent);
	if (at === null || dayPercent === undefined || typeof value.source !== "string") return blockError(BLOCK_BAD_OUTPUT, messages.info.scriptBadJson());
	const resetIn = numberOrUndefined(value.reset_in_s);
	return {
		at,
		source: value.source,
		dayPercent,
		used: numberOrNull(value.used),
		cap: numberOrNull(value.cap),
		resetsAt: resetIn === undefined ? null : isoOrNull(Date.parse(at) + resetIn * MS_PER_SECOND),
		providers: parseProviders(value.providers),
	};
};

const volunteerBlock = async (runtime: RuntimePorts, state: RigState, messages: Messages): Promise<VolunteerReading | BlockError> => {
	const toolsDirectory = joinPath(state.paths.repo, VOLUNTEER_TOOLS_DIRECTORY);
	let present = false;
	try {
		present = (await runtime.fs.listDirectory(toolsDirectory)).some((entry) => entry.name === VOLUNTEER_SCRIPT);
	} catch {
		present = false;
	}
	if (!present) return blockError(BLOCK_SCRIPT_MISSING, messages.info.scriptMissing());
	const result = await runtime.process.run(runtime.pythonCommand, ["-I", joinPath(toolsDirectory, VOLUNTEER_SCRIPT), "limits", "--json"], { timeoutMs: HELPER_TIMEOUT_MS });
	if (!result.ok) return blockError(BLOCK_SCRIPT_FAILED, result.error);
	if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) {
		return blockError(BLOCK_SCRIPT_FAILED, messages.info.scriptExit(result.value.exitCode, result.value.stderr.trim()));
	}
	return parseVolunteerOutput(parseJson(result.value.stdout), messages);
};

// `rig info --session <id>`: the raw readings behind the hub's /info. Every source is read on its own and a failing one
// only fills its block with an error; only a bad or unknown session, or unreadable rig state, fails the command.
export const infoCommand = async (runtime: RuntimePorts, sessionId: string): Promise<ApiResult<InfoData>> => {
	const messages = messagesFor(runtime.language);
	if (!SAFE_SESSION_ID.test(sessionId) || sessionId.includes("..")) return apiFail(INFO_ERROR_BAD_SESSION, messages.info.badSession(sessionId));
	const stateResult = await readRigState(runtime);
	if (!stateResult.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, stateResult.error);
	const state = stateResult.value;
	const recordText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), `${sessionId}.json`));
	const record = recordText === null ? undefined : parseJson(recordText);
	if (!isRecord(record)) return apiFail(INFO_ERROR_UNKNOWN_SESSION, messages.info.unknownSession(sessionId));
	const configDir = typeof record.config_dir === "string" ? record.config_dir : "";
	const usageText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), sessionId, "usage.json"));
	const own = usageText === null ? null : parseUsage(usageText);
	const others: Array<{ sessionId: string; directory: string; usage: Usage }> = [];
	for (const id of await sessionIdsWithRecords(runtime)) {
		if (id === sessionId) continue;
		const text = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), id, "usage.json"));
		const usage = text === null ? null : parseUsage(text);
		if (usage === null || usage.limits.length === 0) continue;
		const otherText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), `${id}.json`));
		const other = otherText === null ? undefined : parseJson(otherText);
		others.push({ sessionId: id, directory: isRecord(other) && typeof other.config_dir === "string" ? other.config_dir : "", usage });
	}
	const directories = [...new Set([configDir, ...others.map((other) => other.directory)])];
	const categories = (["codex", "volunteers"] as const).filter((category) => state.features[category] === true);
	const answer = await runAllowlistTool(runtime, state, messages, ["batch", ...directories.flatMap((directory) => ["--config-dir", directory]), ...categories.flatMap((category) => ["--category", category])]);
	const accounts = answer.ok && isRecord(answer.value.accounts) ? answer.value.accounts : {};
	const account = accountInAnswer(answer, configDir, messages);
	const claude = account.ok ? freshestClaudeLimits(sessionId, account.value, own, others, accounts, messages) : account;
	const codexCheck = categoryShown(state, "codex", answer, messages);
	const volunteerCheck = categoryShown(state, "volunteers", answer, messages);
	const codex = !codexCheck.ok ? blockError(BLOCK_SCRIPT_FAILED, codexCheck.error) : codexCheck.value ? await codexBlock(runtime, messages) : null;
	const volunteers = !volunteerCheck.ok ? blockError(BLOCK_SCRIPT_FAILED, volunteerCheck.error) : volunteerCheck.value ? await volunteerBlock(runtime, state, messages) : null;
	return apiOk({
		session: sessionId,
		account: account.ok ? account.value : null,
		claude: claude.ok ? claude.value ?? blockError(BLOCK_NO_DATA, messages.info.claudeNoData()) : blockError(BLOCK_SCRIPT_FAILED, claude.error),
		...(codex === null ? {} : { codex }),
		...(volunteers === null ? {} : { volunteers }),
		context: own?.context ?? blockError(BLOCK_NO_DATA, messages.info.noContextData()),
	});
};

import type { Language, Messages } from "./messages.js";
import type { LockOwner } from "./lock.js";
import type { ApiError, ApiResult, JsonValue, ProgressEvent } from "./output.js";
import type { Result } from "./result.js";
import type { RuntimePorts } from "./ports.js";
import type { UpdateStep } from "./commands/update.js";

import { applyCommand } from "./commands/apply.js";
import { checkRig } from "./commands/check.js";
import { changeFeature, featureListCommand } from "./commands/feature.js";
import { infoCommand } from "./commands/info.js";
import { installRig } from "./commands/install.js";
import { setLanguage, showLanguage } from "./commands/language.js";
import { createRealRuntime, readRealLanguage } from "./commands/real-runtime.js";
import { readStatus } from "./commands/status.js";
import { isSessionCommand, runSessionCommand } from "./commands/session.js";
import { runExecCommand } from "./commands/exec.js";
import { runExecRunner } from "./exec-core.js";
import { buildShellLaunch } from "./exec-shell.js";
import { runUpdateStep, updateRig } from "./commands/update.js";
import { DEFAULT_LANGUAGE, isLanguage, messagesFor } from "./messages.js";
import {
	apiOk,
	ERROR_CODE_FAILED,
	ERROR_CODE_INTERNAL,
	ERROR_CODE_RUNTIME,
	ERROR_CODE_USAGE,
	FAILURE_EXIT_CODE,
	renderFailure,
	renderProgress,
	renderSuccess,
	SUCCESS_EXIT_CODE,
} from "./output.js";
import { errorText, ok } from "./result.js";

const UPDATE_STEP_ARGUMENT_COUNT = 3;
// The syntax of every command, as `rig help` returns it. Raw data: no language, a client formats it.
const USAGE: string[] = [
	"rig install [--dev]",
	"rig apply",
	"rig feature [--json]",
	"rig feature <name> enable|disable",
	"rig update [--pending]",
	"rig status [--json]",
	"rig check",
	"rig language [en|ru] [--json]",
	"rig info --session <id>",
	"rig session list",
	"rig session compact <id> [--instructions <text>]",
	"rig session rename <id> <name...>",
	"rig session autocompact <id> <N|auto>",
	"rig session stop <id>",
	"rig session cleanup <id>",
	"rig session run <id> [--mode <mode>] [--account <n>] [--prompt <text>]",
	"rig session mode <id> <mode>",
	"rig exec start <shell> --cwd <dir>",
	"rig exec start rig -- <rig arguments>",
	"rig exec status <id> [--from <byte offset> [--wait <ms>]]",
	"rig exec stop <id>",
	"rig exec list",
];
const HELP: JsonValue = { usage: USAGE };

export type Command =
	| { name: "help" }
	| { name: "install"; dev: boolean }
	| { name: "apply" }
	| { name: "feature-list"; json: boolean }
	| { name: "feature-change"; feature: string; action: "enable" | "disable" }
	| { name: "update"; pending: boolean }
	| { name: "status"; json: boolean }
	| { name: "check" }
	| { name: "language"; value: Language | null; json: boolean }
	| { name: "info"; session: string }
	| { name: "session"; subcommand: string; args: string[] }
	| { name: "exec"; subcommand: string; args: string[] }
	| { name: "exec-runner"; id: string }
	| { name: "update-step"; step: UpdateStep; owner: LockOwner };
// A parse error is a function of the catalog: the language is known only after the runtime is built, and parsing stays pure.
export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: (messages: Messages) => string };

export const parseCommand = (args: string[]): ParsedCommand => {
	const [head, ...rest] = args;
	if (head === undefined || ((head === "help" || head === "--help" || head === "-h") && rest.length === 0)) return { ok: true, command: { name: "help" } };
	if (head === "install") return rest.every((argument) => argument === "--dev") && rest.length <= 1
		? { ok: true, command: { name: "install", dev: rest.includes("--dev") } }
		: { ok: false, error: (messages) => messages.cli.usageInstall() };
	if (head === "apply" && rest.length === 0) return { ok: true, command: { name: "apply" } };
	if (head === "feature" && rest.length === 1 && (rest[0] === "--json")) return { ok: true, command: { name: "feature-list", json: true } };
	if (head === "feature" && rest.length === 0) return { ok: true, command: { name: "feature-list", json: false } };
	if (head === "feature" && rest.length === 2 && rest[1] === "enable") return { ok: true, command: { name: "feature-change", feature: rest[0], action: "enable" } };
	if (head === "feature" && rest.length === 2 && rest[1] === "disable") return { ok: true, command: { name: "feature-change", feature: rest[0], action: "disable" } };
	if (head === "update" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--pending"))) return { ok: true, command: { name: "update", pending: rest.includes("--pending") } };
	if (head === "status" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) return { ok: true, command: { name: "status", json: rest.includes("--json") } };
	if (head === "check" && rest.length === 0) return { ok: true, command: { name: "check" } };
	if (head === "language") return parseLanguage(rest);
	if (head === "info") return rest.length === 2 && rest[0] === "--session"
		? { ok: true, command: { name: "info", session: rest[1] } }
		: { ok: false, error: (messages) => messages.info.usage() };
	if (head === "session") return rest.length >= 1 && isSessionCommand(rest[0])
		? { ok: true, command: { name: "session", subcommand: rest[0], args: rest.slice(1) } }
		: { ok: false, error: (messages) => messages.session.usage() };
	if (head === "exec") return rest.length >= 1 && ["start", "status", "stop", "list"].includes(rest[0])
		? { ok: true, command: { name: "exec", subcommand: rest[0], args: rest.slice(1) } }
		: { ok: false, error: (messages) => messages.exec.usage() };
	if (head === "exec-runner" && rest.length === 1) return { ok: true, command: { name: "exec-runner", id: rest[0] } };
	if (head === "update-step") return parseUpdateStep(rest) ?? { ok: false, error: (messages) => messages.cli.usageUpdateStep() };
	return { ok: false, error: (messages) => messages.cli.unknownCommand(args.join(" ")) };
};

// `rig language [en|ru] [--json]`: the value and the flag come in any order, each at most once.
const parseLanguage = (args: string[]): ParsedCommand => {
	const usage: ParsedCommand = { ok: false, error: (messages) => messages.language.usage() };
	let value: Language | null = null;
	let json = false;
	for (const argument of args) {
		if (argument === "--json" && !json) json = true;
		else if (isLanguage(argument) && value === null) value = argument;
		else return usage;
	}
	return { ok: true, command: { name: "language", value, json } };
};

// Internal command: `rig update` runs the freshly fetched code through it while the parent process holds the lock.
const parseUpdateStep = (args: string[]): ParsedCommand | null => {
	const [step, pid, startTime] = args;
	if (args.length !== UPDATE_STEP_ARGUMENT_COUNT || (step !== "apply" && step !== "check")) return null;
	const owner = { pid: Number(pid), startTime: Number(startTime) };
	if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.startTime)) return null;
	return { ok: true, command: { name: "update-step", step, owner } };
};

// Where the runtime comes from. `readLanguage` reads only the language (state.json), for the commands that need no
// runtime (usage errors); `create` builds the runtime, which reads the language itself.
export type RuntimeFactory = { readLanguage: () => Promise<Language>; create: () => Promise<Result<RuntimePorts>> };

const realRuntimeFactory: RuntimeFactory = { readLanguage: readRealLanguage, create: () => createRealRuntime() };

// What a command hands back to the CLI layer, which turns it into stdout and an exit code.
// - json: the command's typed result; the CLI prints it as the one JSON object (success) or the error object (failure).
// - legacy: a command not yet moved to typed results; it printed its own text lines through `writeLine`. Its failure is
//   still printed as the JSON error object. The guard test (tests/api-output.test.ts) lists these until they move.
// - internal: `update-step`, which `rig update` runs as a child and reads as text. It owns its stdout and exit code and
//   is outside the JSON contract.
export type CommandOutcome =
	| { kind: "json"; result: ApiResult<JsonValue> }
	| { kind: "legacy"; result: Result<void> }
	| { kind: "internal"; exitCode: number };

export type CommandContext = {
	runtime: RuntimePorts;
	// Text lines of a legacy command; goes to stdout.
	writeLine: (line: string) => void;
	// Progress of a long-running command; goes to stderr as JSON lines, never to stdout (see src/output.ts).
	writeProgress: (event: ProgressEvent) => void;
};

const ignoreProgress = (): void => {};

// Every command, keyed by name. `satisfies` keeps it equal to the `Command` union, so the guard test can enumerate commands from it.
const COMMAND_NAMES = {
	"help": true,
	"install": true,
	"apply": true,
	"feature-list": true,
	"feature-change": true,
	"update": true,
	"status": true,
	"check": true,
	"language": true,
	"info": true,
	"session": true,
	"exec": true,
	"exec-runner": true,
	"update-step": true,
} satisfies Record<Command["name"], true>;

export const commandNames: readonly string[] = Object.keys(COMMAND_NAMES);

export const runCli = async (
	args: string[],
	writeLine: (line: string) => void,
	suppliedRuntime?: RuntimePorts,
	factory: RuntimeFactory = realRuntimeFactory,
	writeProgress: (event: ProgressEvent) => void = ignoreProgress,
): Promise<number> => {
	const source: RuntimeFactory = suppliedRuntime === undefined
		? factory
		: { readLanguage: async () => suppliedRuntime.language, create: async () => ok(suppliedRuntime) };
	const parsed = parseCommand(args);
	if (!parsed.ok) {
		const messages = messagesFor(await source.readLanguage());
		writeLine(renderFailure({ code: ERROR_CODE_USAGE, message: parsed.error(messages) }));
		return FAILURE_EXIT_CODE;
	}
	const { command } = parsed;
	if (command.name === "help") {
		writeLine(renderSuccess(HELP));
		return SUCCESS_EXIT_CODE;
	}
	// The runtime reads the language from state.json once, when it is built, and carries it; nothing below reads it again.
	// If the runtime cannot be built, the error is printed in the default language.
	const runtimeResult = await source.create();
	if (!runtimeResult.ok) {
		return reportFailure(command, DEFAULT_LANGUAGE, { code: ERROR_CODE_RUNTIME, message: runtimeResult.error }, writeLine);
	}
	const runtime = runtimeResult.value;
	try {
		const outcome = await execute(command, { runtime, writeLine, writeProgress });
		if (outcome.kind === "internal") return outcome.exitCode;
		if (outcome.kind === "legacy") {
			return outcome.result.ok
				? SUCCESS_EXIT_CODE
				: reportFailure(command, runtime.language, { code: ERROR_CODE_FAILED, message: outcome.result.error }, writeLine);
		}
		if (!outcome.result.ok) return reportFailure(command, runtime.language, outcome.result.error, writeLine);
		writeLine(renderSuccess(outcome.result.value));
		return SUCCESS_EXIT_CODE;
	} catch (error) {
		return reportFailure(command, runtime.language, { code: ERROR_CODE_INTERNAL, message: messagesFor(runtime.language).failure.unexpectedFailure(errorText(error)) }, writeLine);
	}
};

// A failure is the JSON error object on stdout and a nonzero exit code. The internal `update-step` keeps its text line:
// its parent prints whatever the child says.
const reportFailure = (command: Command, language: Language, error: ApiError, writeLine: (line: string) => void): number => {
	writeLine(command.name === "update-step" ? messagesFor(language).cli.rigError(error.message) : renderFailure(error));
	return FAILURE_EXIT_CODE;
};

const legacy = (result: Result<void>): CommandOutcome => ({ kind: "legacy", result });

const execute = async (command: Command, context: CommandContext): Promise<CommandOutcome> => {
	const { runtime, writeLine } = context;
	const messages = messagesFor(runtime.language);
	switch (command.name) {
		case "help":
			return { kind: "json", result: apiOk(HELP) };
		case "install":
			return { kind: "json", result: await installRig(runtime, command.dev, context.writeProgress) };
		case "apply":
			return { kind: "json", result: await applyCommand(runtime, context.writeProgress) };
		case "feature-list":
			return { kind: "json", result: await featureListCommand(runtime) };
		case "feature-change":
			return { kind: "json", result: await changeFeature(runtime, command.feature, command.action, context.writeProgress) };
		case "update":
			return { kind: "json", result: await updateRig(runtime, command.pending, context.writeProgress) };
		case "status":
			return { kind: "json", result: await readStatus(runtime) };
		case "language":
			return { kind: "json", result: command.value === null
				? await showLanguage(runtime)
				: await setLanguage(runtime, command.value, context.writeProgress) };
		case "info":
			return { kind: "json", result: await infoCommand(runtime, command.session) };
		case "session":
			return { kind: "json", result: await runSessionCommand(runtime, command.subcommand, command.args, context.writeProgress) };
		case "exec":
			return { kind: "json", result: await runExecCommand(runtime, command.subcommand, command.args) };
		case "exec-runner":
			return { kind: "internal", exitCode: await runExecRunner(runtime, command.id, buildShellLaunch) };
		case "update-step":
			return { kind: "internal", exitCode: await runUpdateStep(runtime, command.step, command.owner, writeLine) };
		case "check":
			return { kind: "json", result: await checkRig(runtime) };
	}
};

if (import.meta.main) {
	// Stdout is only the final JSON object; progress goes to stderr (src/output.ts).
	const exitCode = await runCli(Bun.argv.slice(2), (line) => console.log(line), undefined, undefined, (event) => console.error(renderProgress(event)));
	process.exitCode = exitCode;
}

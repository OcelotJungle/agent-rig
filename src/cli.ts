import type { Language, Messages } from "./messages.js";
import type { LockOwner } from "./lock.js";
import type { Result } from "./result.js";
import type { RuntimePorts } from "./ports.js";
import type { UpdateStep } from "./commands/update.js";

import { applyCommand } from "./commands/apply.js";
import { checkRig } from "./commands/check.js";
import { changeFeature, listFeatureViews } from "./commands/feature.js";
import { installRig } from "./commands/install.js";
import { setLanguage, showLanguage } from "./commands/language.js";
import { createRealRuntime } from "./commands/real-runtime.js";
import { readLanguage } from "./commands/shared.js";
import { formatStatus, readStatus } from "./commands/status.js";
import { runUpdateStep, updateRig } from "./commands/update.js";
import { DEFAULT_LANGUAGE, isLanguage, messagesFor } from "./messages.js";

const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
const UPDATE_STEP_ARGUMENT_COUNT = 3;

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

export const runCli = async (args: string[], writeLine: (line: string) => void, suppliedRuntime?: RuntimePorts): Promise<number> => {
	const runtimeResult = suppliedRuntime === undefined ? await createRealRuntime() : { ok: true as const, value: suppliedRuntime };
	// The language is read from state.json once, here, and travels in the runtime; nothing below reads it from disk again.
	// Without a runtime (or without a readable state) the default language is used.
	const language = runtimeResult.ok ? await readLanguage(runtimeResult.value) : DEFAULT_LANGUAGE;
	if (runtimeResult.ok) runtimeResult.value.language = language;
	const messages = messagesFor(language);
	const parsed = parseCommand(args);
	if (!parsed.ok) {
		writeLine(parsed.error(messages));
		return FAILURE_EXIT_CODE;
	}
	if (parsed.command.name === "help") {
		writeLine(messages.cli.help());
		return SUCCESS_EXIT_CODE;
	}
	if (!runtimeResult.ok) {
		writeLine(messages.cli.rigError(runtimeResult.error));
		return FAILURE_EXIT_CODE;
	}
	try {
		return await execute(parsed.command, runtimeResult.value, writeLine);
	} catch (error) {
		writeLine(messages.cli.rigError(error instanceof Error ? error.message : String(error)));
		return FAILURE_EXIT_CODE;
	}
};

const execute = async (command: Command, runtime: RuntimePorts, writeLine: (line: string) => void): Promise<number> => {
	const messages = messagesFor(runtime.language);
	if (command.name === "help") {
		writeLine(messages.cli.help());
		return SUCCESS_EXIT_CODE;
	}
	if (command.name === "install") return report(await installRig(runtime, command.dev, writeLine), messages, writeLine);
	if (command.name === "apply") return report(await applyCommand(runtime, writeLine), messages, writeLine);
	if (command.name === "feature-list") {
		const result = await listFeatureViews(runtime);
		if (!result.ok) return report(result, messages, writeLine);
		if (command.json) writeLine(JSON.stringify(result.value));
		else for (const feature of result.value) writeLine(messages.cli.featureLine(feature.name, feature.enabled, feature.platformAllowed, feature.description));
		return SUCCESS_EXIT_CODE;
	}
	if (command.name === "feature-change") return report(await changeFeature(runtime, command.feature, command.action, writeLine), messages, writeLine);
	if (command.name === "update") return report(await updateRig(runtime, command.pending, writeLine), messages, writeLine);
	if (command.name === "status") {
		const result = await readStatus(runtime);
		if (!result.ok) return report(result, messages, writeLine);
		if (command.json) writeLine(JSON.stringify(result.value));
		else for (const line of formatStatus(result.value, runtime.language)) writeLine(line);
		return SUCCESS_EXIT_CODE;
	}
	if (command.name === "language") {
		const result = command.value === null
			? showLanguage(runtime, command.json, writeLine)
			: await setLanguage(runtime, command.value, command.json, writeLine);
		return report(result, messages, writeLine);
	}
	if (command.name === "update-step") return runUpdateStep(runtime, command.step, command.owner, writeLine);
	const checked = await checkRig(runtime);
	if (!checked.ok) return report(checked, messages, writeLine);
	writeLine(messages.cli.checksPassed());
	return SUCCESS_EXIT_CODE;
};

const report = (result: Result<void>, messages: Messages, writeLine: (line: string) => void): number => {
	if (result.ok) return SUCCESS_EXIT_CODE;
	writeLine(messages.cli.rigError(result.error));
	return FAILURE_EXIT_CODE;
};

if (import.meta.main) {
	const exitCode = await runCli(Bun.argv.slice(2), (line) => console.log(line));
	process.exitCode = exitCode;
}

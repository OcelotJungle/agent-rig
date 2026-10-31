import type { LockOwner } from "./lock.js";
import type { Result } from "./result.js";
import type { RuntimePorts } from "./ports.js";
import type { UpdateStep } from "./commands/update.js";

import { applyCommand } from "./commands/apply.js";
import { checkRig } from "./commands/check.js";
import { changeFeature, listFeatureViews } from "./commands/feature.js";
import { installRig } from "./commands/install.js";
import { createRealRuntime } from "./commands/real-runtime.js";
import { formatStatus, readStatus } from "./commands/status.js";
import { runUpdateStep, updateRig } from "./commands/update.js";

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
	| { name: "update-step"; step: UpdateStep; owner: LockOwner };
export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string };

export const parseCommand = (args: string[]): ParsedCommand => {
	const [head, ...rest] = args;
	if (head === undefined || ((head === "help" || head === "--help" || head === "-h") && rest.length === 0)) return { ok: true, command: { name: "help" } };
	if (head === "install") return rest.every((argument) => argument === "--dev") && rest.length <= 1
		? { ok: true, command: { name: "install", dev: rest.includes("--dev") } }
		: { ok: false, error: "Использование: rig install [--dev]" };
	if (head === "apply" && rest.length === 0) return { ok: true, command: { name: "apply" } };
	if (head === "feature" && rest.length === 1 && (rest[0] === "--json")) return { ok: true, command: { name: "feature-list", json: true } };
	if (head === "feature" && rest.length === 0) return { ok: true, command: { name: "feature-list", json: false } };
	if (head === "feature" && rest.length === 2 && rest[1] === "enable") return { ok: true, command: { name: "feature-change", feature: rest[0], action: "enable" } };
	if (head === "feature" && rest.length === 2 && rest[1] === "disable") return { ok: true, command: { name: "feature-change", feature: rest[0], action: "disable" } };
	if (head === "update" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--pending"))) return { ok: true, command: { name: "update", pending: rest.includes("--pending") } };
	if (head === "status" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) return { ok: true, command: { name: "status", json: rest.includes("--json") } };
	if (head === "check" && rest.length === 0) return { ok: true, command: { name: "check" } };
	if (head === "update-step") return parseUpdateStep(rest) ?? { ok: false, error: "Служебная команда update-step: apply|check <pid> <время запуска>" };
	return { ok: false, error: `Неизвестная команда или аргументы: ${args.join(" ")}` };
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
	const parsed = parseCommand(args);
	if (!parsed.ok) {
		writeLine(parsed.error);
		return FAILURE_EXIT_CODE;
	}
	if (parsed.command.name === "help") {
		writeLine("Использование: rig install [--dev] | apply | feature [--json] | feature <name> enable|disable | update [--pending] | status [--json] | check");
		return SUCCESS_EXIT_CODE;
	}
	const runtimeResult = suppliedRuntime === undefined ? await createRealRuntime() : { ok: true as const, value: suppliedRuntime };
	if (!runtimeResult.ok) {
		writeLine(`Ошибка rig: ${runtimeResult.error}`);
		return FAILURE_EXIT_CODE;
	}
	try {
		return await execute(parsed.command, runtimeResult.value, writeLine);
	} catch (error) {
		writeLine(`Ошибка rig: ${error instanceof Error ? error.message : String(error)}`);
		return FAILURE_EXIT_CODE;
	}
};

const execute = async (command: Command, runtime: RuntimePorts, writeLine: (line: string) => void): Promise<number> => {
	if (command.name === "help") {
		writeLine("Использование: rig install [--dev] | apply | feature [--json] | feature <name> enable|disable | update [--pending] | status [--json] | check");
		return SUCCESS_EXIT_CODE;
	}
	if (command.name === "install") return report(await installRig(runtime, command.dev, writeLine), writeLine);
	if (command.name === "apply") return report(await applyCommand(runtime, writeLine), writeLine);
	if (command.name === "feature-list") {
		const result = await listFeatureViews(runtime);
		if (!result.ok) return report(result, writeLine);
		if (command.json) writeLine(JSON.stringify(result.value));
		else for (const feature of result.value) writeLine(formatFeature(feature));
		return SUCCESS_EXIT_CODE;
	}
	if (command.name === "feature-change") return report(await changeFeature(runtime, command.feature, command.action, writeLine), writeLine);
	if (command.name === "update") return report(await updateRig(runtime, command.pending, writeLine), writeLine);
	if (command.name === "status") {
		const result = await readStatus(runtime);
		if (!result.ok) return report(result, writeLine);
		if (command.json) writeLine(JSON.stringify(result.value));
		else for (const line of formatStatus(result.value)) writeLine(line);
		return SUCCESS_EXIT_CODE;
	}
	if (command.name === "update-step") return runUpdateStep(runtime, command.step, command.owner, writeLine);
	const checked = await checkRig(runtime);
	if (!checked.ok) return report(checked, writeLine);
	writeLine("Проверки rig пройдены.");
	return SUCCESS_EXIT_CODE;
};

const formatFeature = (feature: { name: string; description: string; enabled: boolean; platformAllowed: boolean }): string => {
	const enabled = feature.enabled ? "включена" : "выключена";
	const platform = feature.platformAllowed ? "" : "; недоступна на этой платформе";
	return `${feature.name}: ${enabled}${platform} — ${feature.description}`;
};

const report = (result: Result<void>, writeLine: (line: string) => void): number => {
	if (result.ok) return SUCCESS_EXIT_CODE;
	writeLine(`Ошибка rig: ${result.error}`);
	return FAILURE_EXIT_CODE;
};

if (import.meta.main) {
	const exitCode = await runCli(Bun.argv.slice(2), (line) => console.log(line));
	process.exitCode = exitCode;
}

import type { FeatureManifest } from "../feature.js";
import type { Result } from "../result.js";
import type { RigState } from "../state.js";
import type { RuntimePorts } from "../ports.js";

import { ensureClaudeImports } from "../rules/assemble-rules.js";
import { resolvePlaceholders } from "../placeholders.js";
import { mergeSettings } from "../settings/merge-settings.js";
import { err, errorText, ok } from "../result.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { checkPrograms } from "./programs.js";
import { pathJoin, readFeatureManifests, readRigState } from "./shared.js";

const CODEX_BEGIN_MARKER = "<!-- rig:begin -->";
const CODEX_END_MARKER = "<!-- rig:end -->";
const CODEX_IMPORT_LINE = "@../.codex/AGENTS.md";
const GENERATED_IMPORT_LINE = "@../.agent-rig/generated/CLAUDE.md";
const TEST_HOOK_NAME = "rig-check";
// The same Git Bash path volunteer-run.py uses. A bare `bash` on Windows can resolve to WSL's System32\bash.exe.
const GIT_BASH_PATH = "C:/Program Files/Git/bin/bash.exe";
const TOOL_EVENTS = ["PreToolUse", "PostToolUse"] as const;
const TOOL_TEST_NAME = "Bash";
const TOOL_TEST_COMMAND = "echo rig-check";
// RestartSec=2 in the hub's install-hub-service.sh: systemd waits this long before it starts a restarted hub again.
const HUB_RESTART_PAUSE_MS = 2000;
// The next start execs after the pause; this margin covers that exec.
const SERVICE_RECHECK_MARGIN_MS = 1000;
// A hub restart ends within one pause plus the margin, so one recheck after the first pause is enough to see it running.
const SERVICE_RECHECKS = 2;

type ExpectedHook = {
	feature: string;
	event: string;
	matcher: string;
	command: string;
	args: string[];
};

// `environmentProblems` are failures to ask the environment (such as the service manager), not defects of the installed rig.
export type RigInspection = { problems: string[]; environmentProblems: string[] };

export const checkRig = async (runtime: RuntimePorts): Promise<Result<void>> => {
	const inspection = await inspectRig(runtime);
	if (!inspection.ok) return inspection;
	const all = [...inspection.value.problems, ...inspection.value.environmentProblems];
	return all.length === 0 ? ok(undefined) : err(all.join("\n"));
};

export const inspectRig = async (runtime: RuntimePorts): Promise<Result<RigInspection>> => {
	const stateResult = await readRigState(runtime);
	if (!stateResult.ok) return stateResult;
	const state = stateResult.value;
	const featuresResult = await readFeatureManifests(runtime, state.paths.repo);
	if (!featuresResult.ok) return featuresResult;
	const features = featuresResult.value;
	const enabled = new Set(features.filter((feature) => feature.name === "base" || state.features[feature.name] === true).map((feature) => feature.name));
	const problems: string[] = [];
	const expectedHooks = resolveExpectedHooks(runtime, state, features, enabled);
	if (!expectedHooks.ok) problems.push(expectedHooks.error);
	const codexPath = pathJoin(runtime.home, ".codex", "AGENTS.md");
	const generatedPath = pathJoin(runtime.home, ".agent-rig", "generated", "CLAUDE.md");
	const claudePath = pathJoin(runtime.home, ".claude", "CLAUDE.md");
	const settingsPath = pathJoin(runtime.home, ".claude", "settings.json");
	const [codex, generated, claude, settings] = await Promise.all([
		readText(runtime, codexPath),
		readText(runtime, generatedPath),
		readText(runtime, claudePath),
		readText(runtime, settingsPath),
	]);
	if (!codex.ok) problems.push(codex.error);
	else if (!hasRuleBlock(codex.value)) problems.push(`Не найден собранный блок правил: ${codexPath}`);
	if (!generated.ok) problems.push(generated.error);
	if (!claude.ok) problems.push(claude.error);
	else {
		const imports = ensureClaudeImports(claude.value);
		const importLines = claude.value.split(/\r?\n/).map((line) => line.replace(/^\uFEFF/, ""));
		if (imports !== claude.value || !importLines.includes(CODEX_IMPORT_LINE) || !importLines.includes(GENERATED_IMPORT_LINE)) {
			problems.push(`Не найдены импорты rig в ${claudePath}`);
		}
	}
	if (!settings.ok) problems.push(settings.error);
	else {
		const parsed = mergeSettings({ currentText: settings.value, desiredEntries: [], ownershipRecords: [], mode: "apply", backupPath: "" });
		if (!parsed.ok) problems.push(`settings.json недопустим: ${parsed.error}`);
		else if (expectedHooks.ok) problems.push(...missingSettingsHooks(settings.value, expectedHooks.value));
	}
	if (!await runtime.process.isAvailable(runtime.pythonCommand)) problems.push(`Не найден интерпретатор ${runtime.pythonCommand}.`);
	const programs = await checkPrograms(runtime, features, enabled);
	if (!programs.ok) problems.push(programs.error);
	const temporary = await runtime.temporary.createDirectory("rig-check-");
	if (!temporary.ok) problems.push(`Не удалось создать временную папку для проверки: ${temporary.error}`);
	else {
		try {
			if (expectedHooks.ok) {
				const hooks = await runExpectedHooks(runtime, expectedHooks.value, temporary.value);
				if (!hooks.ok) problems.push(hooks.error);
			}
			const projectTmp = await checkProjectTmp(runtime, state, temporary.value);
			if (!projectTmp.ok) problems.push(projectTmp.error);
		} finally {
			const removed = await runtime.temporary.removeDirectory(temporary.value);
			if (!removed.ok) problems.push(`Не удалось удалить временную папку ${temporary.value}: ${removed.error}`);
		}
	}
	const environmentProblems: string[] = [];
	if (state.features.telegram === true) {
		const service = await checkServiceRunning(runtime);
		if (!service.ok) environmentProblems.push(service.error);
		else if (!service.value) problems.push("Служба telegram-hub не запущена.");
	}
	return ok({ problems, environmentProblems });
};

// A hub that is mid-restart answers "not running" for a moment, so a stopped answer is asked again over the restart pause.
const checkServiceRunning = async (runtime: RuntimePorts): Promise<Result<boolean>> => {
	let running = await runtime.service.isRunning();
	for (let recheck = 0; recheck < SERVICE_RECHECKS; recheck += 1) {
		if (!running.ok || running.value) return running;
		await runtime.clock.sleep(HUB_RESTART_PAUSE_MS + SERVICE_RECHECK_MARGIN_MS);
		running = await runtime.service.isRunning();
	}
	return running;
};

// The begin marker must come first and the end marker after it.
const hasRuleBlock = (text: string): boolean => {
	const begin = text.indexOf(CODEX_BEGIN_MARKER);
	return begin !== -1 && text.indexOf(CODEX_END_MARKER, begin) !== -1;
};

const resolveExpectedHooks = (
	runtime: RuntimePorts,
	state: RigState,
	features: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
): Result<ExpectedHook[]> => {
	const placeholders = {
		CLONE: state.paths.repo,
		HUB: state.paths.hub,
		HOME: runtime.home,
		PYTHON: runtime.pythonCommand,
	};
	const hooks: ExpectedHook[] = [];
	for (const feature of features) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(runtime.platform)) continue;
		for (const hook of feature.hooks) {
			if (hook.platform !== undefined && hook.platform !== runtime.platform) continue;
			const command = resolvePlaceholders(hook.command, placeholders, `${feature.name}/${hook.event} command`);
			if (!command.ok) return command;
			const args: string[] = [];
			for (const [index, argument] of (hook.args ?? []).entries()) {
				const resolved = resolvePlaceholders(argument, placeholders, `${feature.name}/${hook.event} arg ${index}`);
				if (!resolved.ok) return resolved;
				args.push(resolved.value);
			}
			hooks.push({ feature: feature.name, event: hook.event, matcher: hook.matcher, command: command.value, args });
		}
	}
	return ok(hooks);
};

const runExpectedHooks = async (runtime: RuntimePorts, hooks: readonly ExpectedHook[], temporaryPath: string): Promise<Result<void>> => {
	for (const hook of hooks) {
		const hookEvent: Record<string, unknown> = {
			hook_event_name: hook.event,
			session_id: TEST_HOOK_NAME,
			cwd: temporaryPath,
			stop_hook_active: true,
			...toolFields(hook.event),
		};
		// The hook runs with its own temporary folder as the project, so it cannot change the real project.
		const invoked = await runtime.process.run(hook.command, hook.args, {
			cwd: temporaryPath,
			input: JSON.stringify(hookEvent),
			environment: { CLAUDE_PROJECT_DIR: temporaryPath },
		});
		if (!invoked.ok) return err(`Хук ${hook.feature}/${hook.event} не запустился: ${invoked.error}`);
		if (invoked.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) {
			return err(`Хук ${hook.feature}/${hook.event} завершился с кодом ${invoked.value.exitCode}: ${invoked.value.stderr || invoked.value.stdout}`);
		}
	}
	return ok(undefined);
};

// Tool events carry a tool name and a tool input, so the hook's own logic runs on a harmless command.
const toolFields = (event: string): Record<string, unknown> => TOOL_EVENTS.some((name) => name === event)
	? { tool_name: TOOL_TEST_NAME, tool_input: { command: TOOL_TEST_COMMAND } }
	: {};

const checkProjectTmp = async (runtime: RuntimePorts, state: RigState, temporaryPath: string): Promise<Result<void>> => {
	const scriptPath = pathJoin(state.paths.repo, "base", "hooks", "project-tmp.sh");
	const bash = runtime.platform === "windows" ? GIT_BASH_PATH : "bash";
	const bashAvailable = await runtime.process.isAvailable(bash);
	if (!bashAvailable) return err(`Не найдена программа ${bash} для проверки project-tmp.sh.`);
	const result = await runtime.process.run(bash, [scriptPath], {
		cwd: temporaryPath,
		environment: { TEMP: temporaryPath, TMP: temporaryPath, TMPDIR: temporaryPath, CLAUDE_PROJECT_DIR: temporaryPath },
	});
	if (!result.ok) return err(`Не удалось запустить project-tmp.sh: ${result.error}`);
	return result.value.exitCode === PROCESS_SUCCESS_EXIT_CODE
		? ok(undefined)
		: err(`project-tmp.sh завершился с кодом ${result.value.exitCode}: ${result.value.stderr || result.value.stdout}`);
};

// Checks that settings.json records each expected hook with the same event, matcher, command and args.
const missingSettingsHooks = (text: string, hooks: readonly ExpectedHook[]): string[] => {
	const settings = parseJson(text);
	if (!settings.ok) return [`settings.json не разобран как JSON, хуки не проверены: ${settings.error}`];
	return hooks
		.filter((hook) => !isRecordedHook(settings.value, hook))
		.map((hook) => `Хук ${hook.feature}/${hook.event} не записан в settings.json.`);
};

const parseJson = (text: string): Result<unknown> => {
	try {
		return ok(JSON.parse(text));
	} catch (error) {
		return err(errorText(error));
	}
};

const isRecordedHook = (settings: unknown, hook: ExpectedHook): boolean => {
	if (!isRecord(settings) || !isRecord(settings.hooks)) return false;
	const groups = settings.hooks[hook.event];
	if (!isUnknownArray(groups)) return false;
	return groups.some((group) => isRecord(group) && groupMatcher(group) === hook.matcher && isUnknownArray(group.hooks) && group.hooks.some((entry) => isRecordedCommand(entry, hook)));
};

// Read as merge-settings reads it: a group without a matcher key has matcher "", and a matcher that is not a string matches no hook.
const groupMatcher = (group: Record<string, unknown>): string | undefined => {
	if (group.matcher === undefined) return "";
	return typeof group.matcher === "string" ? group.matcher : undefined;
};

const isRecordedCommand = (entry: unknown, hook: ExpectedHook): boolean => {
	if (!isRecord(entry) || entry.type !== "command" || entry.command !== hook.command) return false;
	const recordedArgs: unknown = entry.args ?? [];
	return isUnknownArray(recordedArgs) && recordedArgs.length === hook.args.length
		&& recordedArgs.every((arg, index) => arg === hook.args[index]);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const readText = async (runtime: RuntimePorts, path: string): Promise<Result<string>> => {
	try {
		return ok(await runtime.fs.readText(path));
	} catch (error) {
		return err(`Не удалось прочитать ${path}: ${errorText(error)}`);
	}
};

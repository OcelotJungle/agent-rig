import type { FeatureManifest } from "../feature.js";
import type { Messages } from "../messages.js";
import type { Result } from "../result.js";
import type { RigState } from "../state.js";
import type { RuntimePorts } from "../ports.js";
import type { HookPrograms } from "../hook-programs.js";

import { toSlashPath } from "../file-system.js";
import { ensureClaudeImports } from "../rules/assemble-rules.js";
import { resolvePlaceholders } from "../placeholders.js";
import { resolveHookPrograms, resolvedHookCommand } from "../hook-programs.js";
import { mergeSettings } from "../settings/merge-settings.js";
import { messagesFor } from "../messages.js";
import { err, errorText, ok } from "../result.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { checkPrograms } from "./programs.js";
import { pathJoin, readFeatureManifests, readRigState } from "./shared.js";

const CODEX_BEGIN_MARKER = "<!-- rig:begin -->";
const CODEX_END_MARKER = "<!-- rig:end -->";
const CODEX_IMPORT_LINE = "@../.codex/AGENTS.md";
const GENERATED_IMPORT_LINE = "@../.agent-rig/generated/CLAUDE.md";
const TEST_HOOK_NAME = "rig-check";
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
	// Absent for a shell-form hook (a command string run through a shell); present for a direct exec.
	args: string[] | undefined;
	shell: string | undefined;
};

// Claude Code runs a hook with no `args` through its shell: bash by default, or the hook's `shell` field.
const DEFAULT_HOOK_SHELL = "bash";
const POWERSHELL_SHELL = "powershell";

const shellInvocation = (shell: string, platform: RuntimePorts["platform"], bash: string): { program: string; flags: string[] } | undefined => {
	if (shell === DEFAULT_HOOK_SHELL) return { program: bash, flags: ["-c"] };
	if (shell === POWERSHELL_SHELL) return { program: platform === "windows" ? "powershell" : "pwsh", flags: ["-NoProfile", "-Command"] };
	return undefined;
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
	const messages = messagesFor(runtime.language);
	const featuresResult = await readFeatureManifests(runtime, state.paths.repo);
	if (!featuresResult.ok) return featuresResult;
	const features = featuresResult.value;
	const enabled = new Set(features.filter((feature) => feature.name === "base" || state.features[feature.name] === true).map((feature) => feature.name));
	const problems: string[] = [];
	const programs = await resolveHookPrograms(runtime, features, enabled);
	const expectedHooks = programs.ok ? resolveExpectedHooks(runtime, state, features, enabled, programs.value) : programs;
	if (!expectedHooks.ok) problems.push(expectedHooks.error);
	const codexPath = pathJoin(runtime.home, ".codex", "AGENTS.md");
	const generatedPath = pathJoin(runtime.home, ".agent-rig", "generated", "CLAUDE.md");
	const claudePath = pathJoin(runtime.home, ".claude", "CLAUDE.md");
	const settingsPath = pathJoin(runtime.home, ".claude", "settings.json");
	const [codex, generated, claude, settings] = await Promise.all([
		readText(runtime, codexPath, messages),
		readText(runtime, generatedPath, messages),
		readText(runtime, claudePath, messages),
		readText(runtime, settingsPath, messages),
	]);
	if (!codex.ok) problems.push(codex.error);
	else if (!hasRuleBlock(codex.value)) problems.push(messages.check.ruleBlockMissing(codexPath));
	if (!generated.ok) problems.push(generated.error);
	if (!claude.ok) problems.push(claude.error);
	else {
		const imports = ensureClaudeImports(claude.value);
		const importLines = claude.value.split(/\r?\n/).map((line) => line.replace(/^\uFEFF/, ""));
		if (imports !== claude.value || !importLines.includes(CODEX_IMPORT_LINE) || !importLines.includes(GENERATED_IMPORT_LINE)) {
			problems.push(messages.check.importsMissing(claudePath));
		}
	}
	if (!settings.ok) problems.push(settings.error);
	else {
		problems.push(...await missingHookPrograms(runtime, settings.value, messages));
		const parsed = mergeSettings({ currentText: settings.value, desiredEntries: [], ownershipRecords: [], mode: "apply", backupPath: "", messages });
		if (!parsed.ok) problems.push(messages.check.settingsInvalid(parsed.error));
		else if (expectedHooks.ok) problems.push(...missingSettingsHooks(settings.value, expectedHooks.value, messages));
	}
	if (programs.ok && programs.value.python === "") problems.push(messages.check.interpreterMissing(runtime.pythonCommand));
	const installedPrograms = await checkPrograms(runtime, features, enabled);
	if (!installedPrograms.ok) problems.push(installedPrograms.error);
	const temporary = await runtime.temporary.createDirectory("rig-check-");
	if (!temporary.ok) problems.push(messages.check.temporaryCreateFailed(temporary.error));
	else {
		try {
			if (expectedHooks.ok) {
				const hooks = await runExpectedHooks(runtime, expectedHooks.value, temporary.value, messages, programs.ok ? programs.value.bash : "");
				if (!hooks.ok) problems.push(hooks.error);
			}
			const projectTmp = await checkProjectTmp(runtime, state, temporary.value, messages, programs.ok ? programs.value.bash : "");
			if (!projectTmp.ok) problems.push(projectTmp.error);
		} finally {
			const removed = await runtime.temporary.removeDirectory(temporary.value);
			if (!removed.ok) problems.push(messages.check.temporaryRemoveFailed(temporary.value, removed.error));
		}
	}
	const environmentProblems: string[] = [];
	if (state.features.telegram === true) {
		const service = await checkServiceRunning(runtime);
		if (!service.ok) environmentProblems.push(service.error);
		else if (!service.value) problems.push(messages.check.serviceNotRunning());
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
	programs: HookPrograms,
): Result<ExpectedHook[]> => {
	const placeholders = {
		CLONE: toSlashPath(state.paths.repo),
		HUB: toSlashPath(state.paths.hub),
		HOME: toSlashPath(runtime.home),
		PYTHON: toSlashPath(runtime.pythonCommand),
	};
	const hooks: ExpectedHook[] = [];
	for (const feature of features) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(runtime.platform)) continue;
		for (const hook of feature.hooks) {
			if (hook.platform !== undefined && hook.platform !== runtime.platform) continue;
			const command = resolvePlaceholders(resolvedHookCommand(hook.command, programs, hook.args !== undefined, hook.shell), placeholders, `${feature.name}/${hook.event} command`);
			if (!command.ok) return command;
			let args: string[] | undefined;
			if (hook.args !== undefined) {
				args = [];
				for (const [index, argument] of hook.args.entries()) {
					const resolved = resolvePlaceholders(argument, placeholders, `${feature.name}/${hook.event} arg ${index}`);
					if (!resolved.ok) return resolved;
					args.push(resolved.value);
				}
			}
			hooks.push({ feature: feature.name, event: hook.event, matcher: hook.matcher, command: command.value, args, shell: hook.shell });
		}
	}
	return ok(hooks);
};

const runExpectedHooks = async (runtime: RuntimePorts, hooks: readonly ExpectedHook[], temporaryPath: string, messages: Messages, bash: string): Promise<Result<void>> => {
	for (const hook of hooks) {
		const hookEvent: Record<string, unknown> = {
			hook_event_name: hook.event,
			session_id: TEST_HOOK_NAME,
			cwd: temporaryPath,
			stop_hook_active: true,
			...toolFields(hook.event),
		};
		// The hook runs with its own temporary folder as the project, so it cannot change the real project.
		let program = hook.command;
		let programArgs: string[] = hook.args ?? [];
		if (hook.args === undefined) {
			const invocation = shellInvocation(hook.shell ?? DEFAULT_HOOK_SHELL, runtime.platform, bash);
			if (invocation === undefined) return err(messages.check.hookShellUnknown(hook.feature, hook.event, hook.shell ?? ""));
			program = invocation.program;
			programArgs = [...invocation.flags, hook.command];
		}
		const invoked = await runtime.process.run(program, programArgs, {
			cwd: temporaryPath,
			input: JSON.stringify(hookEvent),
			environment: { CLAUDE_PROJECT_DIR: temporaryPath },
		});
		if (!invoked.ok) return err(messages.check.hookNotStarted(hook.feature, hook.event, invoked.error));
		if (invoked.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) {
			return err(messages.check.hookExitCode(hook.feature, hook.event, invoked.value.exitCode, invoked.value.stderr || invoked.value.stdout));
		}
	}
	return ok(undefined);
};

// Tool events carry a tool name and a tool input, so the hook's own logic runs on a harmless command.
const toolFields = (event: string): Record<string, unknown> => TOOL_EVENTS.some((name) => name === event)
	? { tool_name: TOOL_TEST_NAME, tool_input: { command: TOOL_TEST_COMMAND } }
	: {};

const checkProjectTmp = async (runtime: RuntimePorts, state: RigState, temporaryPath: string, messages: Messages, bash: string): Promise<Result<void>> => {
	const scriptPath = pathJoin(state.paths.repo, "base", "hooks", "project-tmp.sh");
	const bashAvailable = await runtime.process.isAvailable(bash);
	if (!bashAvailable) return err(messages.check.bashMissing(bash));
	const result = await runtime.process.run(bash, [scriptPath], {
		cwd: temporaryPath,
		environment: { TEMP: temporaryPath, TMP: temporaryPath, TMPDIR: temporaryPath, CLAUDE_PROJECT_DIR: temporaryPath },
	});
	if (!result.ok) return err(messages.check.projectTmpNotStarted(result.error));
	return result.value.exitCode === PROCESS_SUCCESS_EXIT_CODE
		? ok(undefined)
		: err(messages.check.projectTmpExitCode(result.value.exitCode, result.value.stderr || result.value.stdout));
};

// Checks that settings.json records each expected hook with the same event, matcher, command and args.
const missingSettingsHooks = (text: string, hooks: readonly ExpectedHook[], messages: Messages): string[] => {
	const settings = parseJson(text);
	if (!settings.ok) return [messages.check.settingsNotJson(settings.error)];
	return hooks
		.filter((hook) => !isRecordedHook(settings.value, hook))
		.map((hook) => messages.check.hookNotRecorded(hook.feature, hook.event));
};

const missingHookPrograms = async (runtime: RuntimePorts, text: string, messages: Messages): Promise<string[]> => {
	const parsed = parseJson(text);
	if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.hooks)) return [];
	const paths = new Set<string>();
	for (const groups of Object.values(parsed.value.hooks)) {
		if (!isUnknownArray(groups)) continue;
		for (const group of groups) {
			if (!isRecord(group) || !isUnknownArray(group.hooks)) continue;
			for (const hook of group.hooks) {
				if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") continue;
				// With `args` the command is the program path itself (it may contain spaces); without, a shell line whose first word is the program.
				const match = hook.command.replace(/^&\s+/, "").match(/^(?:'([^']+)'|"([^"]+)"|(\S+))/);
				const path = isUnknownArray(hook.args) ? hook.command : match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
				if (/^(?:[A-Za-z]:\/|\/)/.test(path)) paths.add(path);
			}
		}
	}
	const missing: string[] = [];
	for (const path of paths) if (!await runtime.process.isAvailable(path)) missing.push(messages.check.hookProgramGone(path));
	return missing;
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
	const expectedArgs = hook.args;
	if (expectedArgs === undefined) return entry.args === undefined;
	const recordedArgs: unknown = entry.args ?? [];
	return isUnknownArray(recordedArgs) && recordedArgs.length === expectedArgs.length
		&& recordedArgs.every((arg, index) => arg === expectedArgs[index]);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const readText = async (runtime: RuntimePorts, path: string, messages: Messages): Promise<Result<string>> => {
	try {
		return ok(await runtime.fs.readText(path));
	} catch (error) {
		return err(messages.check.readFailed(path, errorText(error)));
	}
};

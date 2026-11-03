import type { FeatureManifest } from "../feature.js";
import type { RigState } from "../state.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { loadFeatures } from "../feature-graph.js";
import { buildCronEntries, mergeCronEntries } from "../update/cron.js";
import { messagesFor } from "../messages.js";
import { parseState } from "../state.js";
import { err, errorText, ok } from "../result.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { pathJoin, stateWithFeatureDefaults, withRigLock } from "./shared.js";
import { installMissingPrograms } from "./programs.js";

const SERVER_REPO_PATH = ".agent-rig/repo";
const SERVER_HUB_PATH = ".agent-rig/hub";
const HUB_DIRECTORY_NAME = "claude-telegram-hub";
const CRON_INSTALL_COMMAND = "sudo apt-get install cron";
// The "no crontab for" message is localized; the C locale makes the match below language-independent.
const CRON_LIST_LOCALE = "C";
const UPDATE_LOG_PATH = ".agent-rig/update.log";

export const installRig = async (
	runtime: RuntimePorts,
	dev: boolean,
	writeLine: (line: string) => void,
): Promise<Result<void>> => withRigLock(runtime, writeLine, async () => {
	const messages = messagesFor(runtime.language);
	const paths = dev
		? await resolveDevPaths(runtime)
		: ok({ repo: pathJoin(runtime.home, SERVER_REPO_PATH), hub: pathJoin(runtime.home, SERVER_HUB_PATH) });
	if (!paths.ok) return paths;
	const loaded = await loadFeatures(runtime.fs, paths.value.repo);
	if (!loaded.ok) return loaded;
	const existing = await readExistingState(runtime);
	if (!existing.ok) return existing;
	const baseState: RigState = existing.value ?? {
		mode: dev ? "dev" : "server",
		paths: paths.value,
		features: {},
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	const withPaths: RigState = { ...baseState, mode: dev ? "dev" : "server", paths: paths.value };
	const initialized = existing.value === null
		? stateWithFeatureDefaults(withPaths, loaded.value, runtime.platform)
		: withPaths;
	const enabled = enabledNames(initialized, loaded.value);
	const programs = await installMissingPrograms(runtime, loaded.value, new Set(enabled));
	if (!programs.ok) return programs;
	for (const missing of programs.value) writeLine(messages.programs.installPackage(missing.name, missing.command));
	const applied = await applyRig(runtime, { state: initialized, mode: "install" });
	if (!applied.ok) return applied;
	const shim = await installShim(runtime, paths.value.repo);
	if (!shim.ok) return shim;
	if (!dev) {
		const cron = await installCron(runtime, paths.value.repo);
		if (!cron.ok) return cron;
	}
	writeLine(messages.install.done(dev));
	return ok(undefined);
});

const resolveDevPaths = async (runtime: RuntimePorts): Promise<Result<{ repo: string; hub: string }>> => {
	const messages = messagesFor(runtime.language);
	const result = await runtime.process.run("git", ["rev-parse", "--show-toplevel"], { cwd: runtime.currentDirectory });
	if (!result.ok) return err(messages.install.cloneNotFound(result.error));
	if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(messages.install.notGitClone(result.value.stderr || result.value.stdout));
	const repo = result.value.stdout.trim();
	if (repo.length === 0) return err(messages.install.clonePathUnknown());
	const normalized = repo.replaceAll("\\", "/");
	const worktreeMarker = "/.worktrees/";
	const worktreeIndex = normalized.lastIndexOf(worktreeMarker);
	const projectRoot = worktreeIndex < 0 ? repo : normalized.slice(0, worktreeIndex);
	const hub = runtime.resolvePath(projectRoot, "..", HUB_DIRECTORY_NAME);
	return ok({ repo, hub });
};

const readExistingState = async (runtime: RuntimePorts): Promise<Result<RigState | null>> => {
	const path = pathJoin(runtime.home, ".agent-rig", "state.json");
	try {
		const parsed = parseState(await runtime.fs.readText(path));
		return parsed.ok ? ok(parsed.value) : parsed;
	} catch (error) {
		if (isNotFound(error)) return ok(null);
		return err(messagesFor(runtime.language).install.stateReadFailed(errorText(error)));
	}
};

const installShim = async (runtime: RuntimePorts, repoPath: string): Promise<Result<void>> => {
	const binPath = pathJoin(runtime.home, ".local", "bin");
	const cliPath = runtime.resolvePath(repoPath, "src", "cli.ts");
	if (runtime.platform === "windows") {
		const bashShim = `#!/usr/bin/env bash\nexec ${shellQuote(toGitBashPath(runtime.executablePath))} run ${shellQuote(toGitBashPath(cliPath))} "$@"\n`;
		const bashWritten = await runtime.writeExecutable(pathJoin(binPath, "rig"), bashShim);
		if (!bashWritten.ok) return bashWritten;
		const cmdShim = `@echo off\r\n"${runtime.executablePath}" run "${cliPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
		return runtime.writeExecutable(pathJoin(binPath, "rig.cmd"), cmdShim);
	}
	const content = `#!/usr/bin/env bash\nexec ${shellQuote(runtime.executablePath)} run ${shellQuote(cliPath)} "$@"\n`;
	return runtime.writeExecutable(pathJoin(binPath, "rig"), content);
};

const installCron = async (runtime: RuntimePorts, repoPath: string): Promise<Result<void>> => {
	const messages = messagesFor(runtime.language);
	if (!await runtime.process.isAvailable("crontab")) {
		return err(messages.install.crontabMissing(CRON_INSTALL_COMMAND));
	}
	const entries = buildCronEntries({
		bunPath: runtime.executablePath,
		rigPath: runtime.resolvePath(repoPath, "src", "cli.ts"),
		path: runtime.pathEnvironment,
		logPath: pathJoin(runtime.home, UPDATE_LOG_PATH),
	}, messages);
	if (!entries.ok) return entries;
	const listed = await runtime.process.run("crontab", ["-l"], { environment: { LC_ALL: CRON_LIST_LOCALE } });
	if (!listed.ok) return listed;
	if (listed.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE && !listed.value.stderr.toLowerCase().includes("no crontab for")) {
		return err(messages.install.crontabReadFailed(listed.value.stderr || listed.value.stdout));
	}
	const existing = listed.value.exitCode === PROCESS_SUCCESS_EXIT_CODE ? listed.value.stdout : "";
	const merged = mergeCronEntries(existing, entries.value);
	if (merged === existing) return ok(undefined);
	const updated = await runtime.process.run("crontab", ["-"], { input: merged });
	return updated.ok && updated.value.exitCode === PROCESS_SUCCESS_EXIT_CODE
		? ok(undefined)
		: err(updated.ok ? messages.install.crontabWriteFailed(updated.value.stderr || updated.value.stdout) : updated.error);
};

const enabledNames = (state: RigState, features: readonly FeatureManifest[]): string[] =>
	features.filter((feature) => feature.name === "base" || state.features[feature.name] === true).map((feature) => feature.name);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const toGitBashPath = (path: string): string => path
	.replaceAll("\\", "/")
	.replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

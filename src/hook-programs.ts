import type { FeatureManifest } from "./feature.js";
import type { RuntimePorts } from "./ports.js";
import type { Result } from "./result.js";

import { posix } from "node:path";

import { toSlashPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { err, ok } from "./result.js";

export type HookPrograms = { python: string; bash: string; commands: ReadonlyMap<string, string> };

const absolute = (path: string): boolean => /^(?:[A-Za-z]:\/|\/)/.test(path);
const isPython = (name: string): boolean => /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(toSlashPath(name).split("/").pop() ?? "");
export const shellQuote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;
const commandParts = (command: string, direct: boolean): { program: string; suffix: string } => {
	const trimmed = command.trim();
	if (direct) return { program: trimmed, suffix: "" };
	const match = trimmed.match(/^(?:'([^']+)'|"([^"]+)"|(\S+))/);
	return { program: match?.[1] ?? match?.[2] ?? match?.[3] ?? "", suffix: trimmed.slice(match?.[0].length ?? 0) };
};

export const resolveHookPrograms = async (
	runtime: RuntimePorts, features: readonly FeatureManifest[], enabled: ReadonlySet<string>,
): Promise<Result<HookPrograms>> => {
	const cache = new Map<string, string>();
	const find = async (name: string): Promise<string | null> => {
		const cached = cache.get(name);
		if (cached !== undefined) return cached;
		let candidates: string[] = [];
		if (name === "bash" && runtime.platform === "windows") {
			const git = await runtime.process.run("git", ["--exec-path"]);
			if (git.ok && git.value.exitCode === 0) {
				const execPath = toSlashPath(git.value.stdout.trim());
				if (absolute(execPath)) candidates = [posix.normalize(`${execPath}/../../../bin/bash.exe`)];
			}
		} else if (absolute(toSlashPath(name))) candidates = [toSlashPath(name)];
		else if (name.includes("/") || name.includes("\\")) candidates = [runtime.resolvePath(name)];
		else {
			const suffix = runtime.platform === "windows" && !name.toLowerCase().endsWith(".exe") ? ".exe" : "";
			const separator = runtime.platform === "windows" ? ";" : ":";
			candidates = runtime.pathEnvironment.split(separator).map((directory) => {
				const base = toSlashPath(directory || runtime.currentDirectory);
				return absolute(base) ? `${base.replace(/\/$/, "")}/${name}${suffix}` : runtime.resolvePath(base, `${name}${suffix}`);
			});
		}
		for (const candidate of candidates) {
			if (!absolute(candidate) || (isPython(name) && /(?:^|\/)windowsapps(?:\/|$)/i.test(candidate))) continue;
			if (!await runtime.process.isAvailable(candidate)) continue;
			let resolved = candidate;
			if (runtime.platform === "windows" && isPython(name)) {
				const interpreter = await runtime.process.run(candidate, ["-I", "-c", "import sys; print(sys.executable)"]);
				if (!interpreter.ok || interpreter.value.exitCode !== 0) continue;
				const executable = toSlashPath(interpreter.value.stdout.trim());
				if (!absolute(executable) || /(?:^|\/)windowsapps(?:\/|$)/i.test(executable) || !await runtime.process.isAvailable(executable)) continue;
				resolved = executable;
			}
			cache.set(name, resolved);
			return resolved;
		}
		return null;
	};
	let python = "";
	let bash = "";
	const commands = new Map<string, string>();
	for (const feature of features) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(runtime.platform)) continue;
		for (const hook of feature.hooks) {
			if (hook.platform !== undefined && hook.platform !== runtime.platform) continue;
			const token = commandParts(hook.command, hook.args !== undefined).program;
			const name = token === "{{PYTHON}}" ? runtime.pythonCommand : token === "{{BASH}}" ? "bash" : token;
			const path = await find(name);
			if (path === null) return err(messagesFor(runtime.language).apply.hookProgramMissing(name, feature.name));
			commands.set(token, path);
			if (token === "{{PYTHON}}") python = path;
			if (name === "bash") bash = path;
		}
	}
	if (python === "") python = await find(runtime.pythonCommand) ?? "";
	if (bash === "") bash = await find("bash") ?? "";
	return ok({ python, bash, commands });
};

export const resolvedHookCommand = (command: string, programs: HookPrograms, direct: boolean, shell?: string): string => {
	const parts = commandParts(command, direct);
	const path = programs.commands.get(parts.program) ?? parts.program;
	if (direct) return path;
	if (shell === "powershell") return `& '${path.replaceAll("'", "''")}'${parts.suffix}`;
	return `${shellQuote(path)}${parts.suffix}`;
};

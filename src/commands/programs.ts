import type { FeatureManifest, ProgramManifest } from "../feature.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { messagesFor } from "../messages.js";
import { err, ok } from "../result.js";
import { pathJoin } from "./shared.js";

export type MissingSystemProgram = {
	name: string;
	command: string;
};

export const installMissingPrograms = async (
	runtime: RuntimePorts,
	features: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
): Promise<Result<MissingSystemProgram[]>> => {
	const missingSystem: MissingSystemProgram[] = [];
	const checked = new Set<string>();
	for (const feature of features) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(runtime.platform)) continue;
		for (const program of feature.programs) {
			if (program.platform !== undefined && program.platform !== runtime.platform) continue;
			if (checked.has(program.name)) continue;
			checked.add(program.name);
			const available = await runtime.process.isAvailable(program.command);
			if (available) continue;
			if (program.systemPackage) {
				if (program.installCommand === null) return err(messagesFor(runtime.language).programs.noInstallCommand(program.name));
				missingSystem.push({ name: program.name, command: program.installCommand });
				continue;
			}
			const installed = await runtime.programs.install(program.name, pathJoin(runtime.home, ".local", "bin"));
			if (!installed.ok) return installed;
			if (!await runtime.process.isAvailable(program.command)) return err(messagesFor(runtime.language).programs.stillUnavailable(program.name));
		}
	}
	return ok(missingSystem);
};

export const checkPrograms = async (
	runtime: RuntimePorts,
	features: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
): Promise<Result<string[]>> => {
	const errors: string[] = [];
	const messages = messagesFor(runtime.language);
	const checked = new Map<string, ProgramManifest>();
	for (const feature of features) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(runtime.platform)) continue;
		for (const program of feature.programs) {
			if (program.platform !== undefined && program.platform !== runtime.platform) continue;
			checked.set(program.name, program);
		}
	}
	for (const program of checked.values()) {
		if (await runtime.process.isAvailable(program.command)) continue;
		if (program.systemPackage) {
			errors.push(program.installCommand === null
				? messages.programs.systemPackageMissingNoCommand(program.name)
				: messages.programs.systemPackageMissing(program.name, program.installCommand));
		} else {
			errors.push(messages.programs.programMissing(program.name));
		}
	}
	return errors.length > 0 ? { ok: false, error: errors.join("\n") } : ok([]);
};

import type { FeatureManifest, Platform } from "../feature.js";
import type { Language } from "../messages.js";
import type { Result } from "../result.js";
import type { RigState } from "../state.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { resolveFeatureChange } from "../feature-graph.js";
import { isTranslatedLanguage, messagesFor } from "../messages.js";
import { err, ok } from "../result.js";
import { emitRigEvent, readFeatureManifests, readRigState, withRigLock } from "./shared.js";
import { installMissingPrograms } from "./programs.js";

export type FeatureView = {
	name: string;
	description: string;
	enabled: boolean;
	platformAllowed: boolean;
};

export const listFeatureViews = async (runtime: RuntimePorts): Promise<Result<FeatureView[]>> => {
	const state = await readRigState(runtime);
	if (!state.ok) return state;
	const loaded = await readFeatureManifests(runtime, state.value.paths.repo);
	if (!loaded.ok) return loaded;
	return ok(loaded.value.filter((feature) => feature.name !== "base").map((feature) => toFeatureView(feature, state.value.features, runtime.platform, runtime.language)));
};

export const changeFeature = async (
	runtime: RuntimePorts,
	name: string,
	action: "enable" | "disable",
	writeLine: (line: string) => void,
): Promise<Result<void>> => {
	const preserveLock = name === "telegram" && action === "disable";
	const messages = messagesFor(runtime.language);
	return withRigLock(runtime, writeLine, async () => {
		const stateResult = await readRigState(runtime);
		if (!stateResult.ok) return stateResult;
		const state = stateResult.value;
		const loaded = await readFeatureManifests(runtime, state.paths.repo);
		if (!loaded.ok) return loaded;
		if (name === "base") return err(messages.feature.baseCannotToggle());
		const enabled = loaded.value.filter((feature) => feature.name === "base" || state.features[feature.name] === true).map((feature) => feature.name);
		const resolved = resolveFeatureChange({ messages, features: loaded.value, enabled, name, action, platform: runtime.platform });
		if (!resolved.ok) return resolved;
		const selected = loaded.value.find((feature) => feature.name === name);
		if (selected === undefined) return err(messages.feature.unknown(name));
		const nextFeatures = { ...state.features, [name]: action === "enable" };
		const nextState = { ...state, features: nextFeatures };
		if (action === "enable") {
			const programs = await installMissingPrograms(runtime, loaded.value, new Set(resolved.value));
			if (!programs.ok) return programs;
			for (const missing of programs.value) writeLine(messages.programs.installPackage(missing.name, missing.command));
		}
		const applied = await applyRig(runtime, { state: nextState, mode: "apply" });
		if (!applied.ok) return applied;
		if (name === "telegram" && action === "enable") {
			const started = await runtime.service.start();
			if (!started.ok) return revertFeatureChange(runtime, applied.value.state, state.features, messages.feature.serviceNotStarted(started.error));
		}
		const changedText = messages.feature.changed(name, action === "enable");
		const event = await emitRigEvent(runtime, "features-changed", "info", changedText);
		if (!event.ok) return event;
		if (preserveLock) {
			writeLine(messages.feature.telegramDisabledStopping());
			const stopped = await runtime.service.stop();
			return stopped;
		}
		writeLine(changedText);
		return ok(undefined);
	}, preserveLock);
};

const revertFeatureChange = async (
	runtime: RuntimePorts,
	appliedState: RigState,
	previousFeatures: RigState["features"],
	cause: string,
): Promise<Result<never>> => {
	const reverted = await applyRig(runtime, { state: { ...appliedState, features: previousFeatures }, mode: "apply" });
	if (!reverted.ok) return err(messagesFor(runtime.language).feature.revertFailed(cause, reverted.error));
	return err(cause);
};

const toFeatureView = (feature: FeatureManifest, enabled: Record<string, boolean>, platform: Platform, language: Language): FeatureView => ({
	name: feature.name,
	description: (isTranslatedLanguage(language) ? feature.translations?.[language]?.description : undefined) ?? feature.description,
	enabled: enabled[feature.name] === true,
	platformAllowed: feature.platforms.includes(platform),
});

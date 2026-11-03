import type { FeatureManifest } from "../feature.js";
import type { RigState } from "../state.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { loadFeatures } from "../feature-graph.js";
import { acquireLock } from "../lock.js";
import { appendEvent } from "../events.js";
import { joinPath } from "../file-system.js";
import { messagesFor } from "../messages.js";
import { readState } from "../state.js";
import { err, errorText, ok } from "../result.js";

export const readRigState = async (runtime: RuntimePorts): Promise<Result<RigState>> =>
	readState(runtime.fs, runtime.home);

export const readFeatureManifests = async (runtime: RuntimePorts, repoPath: string): Promise<Result<FeatureManifest[]>> =>
	loadFeatures(runtime.fs, repoPath);

export const emitRigEvent = async (
	runtime: RuntimePorts,
	type: string,
	level: "info" | "warn" | "error",
	text: string,
): Promise<Result<void>> => {
	const event = await appendEvent({
		fs: runtime.fs,
		home: runtime.home,
		now: () => runtime.clock.nowText(),
		createId: () => runtime.ids.next(),
	}, { type, level, text });
	return event.ok ? ok(undefined) : event;
};

export const withRigLock = async <T>(
	runtime: RuntimePorts,
	writeLine: (line: string) => void,
	operation: () => Promise<Result<T>>,
	keepLockForProcessExit = false,
): Promise<Result<T>> => {
	// Printed once, before a command waits for a lock that another rig process holds. The hub shows it as plain output.
	const acquired = await acquireLock(runtime.lock, () => writeLine(messagesFor(runtime.language).lock.waiting()));
	if (!acquired.ok) return acquired;
	let result: Result<T>;
	try {
		result = await operation();
	} catch (error) {
		result = err(errorText(error));
	}
	if (keepLockForProcessExit && result.ok) return result;
	const released = await acquired.value.release();
	return released.ok ? result : released;
};

export const stateWithFeatureDefaults = (
	state: RigState,
	features: readonly FeatureManifest[],
	platform: RuntimePorts["platform"],
): RigState => {
	const nextFeatures: Record<string, boolean> = {};
	for (const feature of features) {
		if (feature.name !== "base") nextFeatures[feature.name] = feature.enabledByDefault && feature.platforms.includes(platform);
	}
	return { ...state, features: nextFeatures };
};

export const serializeRecord = (value: unknown): string => JSON.stringify(value);
export const pathJoin = joinPath;

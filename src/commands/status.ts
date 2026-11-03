import type { FeatureView } from "./feature.js";
import type { Language, Messages } from "../messages.js";
import type { RigEvent } from "../events.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { messagesFor } from "../messages.js";
import { err, ok } from "../result.js";
import { listFeatureViews } from "./feature.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { pathJoin, readRigState } from "./shared.js";
import { parseVersion, VERSION_PATHS } from "../version-manifest.js";

const UPDATE_EVENT_TYPES = ["update-ok", "update-skipped", "update-failed", "rollback"] as const;
// The only event that marks a successful update (src/update/update.ts); errors logged before it are settled.
const SUCCESS_EVENT_TYPE = "update-ok";
const STATUS_SCHEMA_VERSION = 1;

export type StatusView = {
	schemaVersion: typeof STATUS_SCHEMA_VERSION;
	mode: "dev" | "server";
	versions: { rig: string | null; hub: string | null };
	releases: { rig: string | null; hub: string | null };
	features: FeatureView[];
	lastUpdate: { type: string; time: string; level: string; text: string } | null;
	pendingHubRestart: string | null;
	errors: Array<{ type: string; time: string; text: string }>;
};

export const readStatus = async (runtime: RuntimePorts): Promise<Result<StatusView>> => {
	const state = await readRigState(runtime);
	if (!state.ok) return state;
	const features = await listFeatureViews(runtime);
	if (!features.ok) return features;
	const [rigVersion, hubVersion, events] = await Promise.all([
		readGitHead(runtime, state.value.paths.repo),
		readGitHead(runtime, state.value.paths.hub),
		readEvents(runtime),
	]);
	const [rigRelease, hubRelease] = await Promise.all([
		readGitVersion(runtime, state.value.paths.repo, rigVersion.ok ? rigVersion.value : null, VERSION_PATHS.rig),
		readGitVersion(runtime, state.value.paths.hub, hubVersion.ok ? hubVersion.value : null, VERSION_PATHS.hub),
	]);
	const parsedEvents = events.ok ? events.value : [];
	const updateEvents = parsedEvents.filter((event) => isUpdateEventType(event.type));
	const last = updateEvents[updateEvents.length - 1];
	// File order: events are appended, so an error after the last update-ok is one with a higher index. No update-ok means every error counts.
	const lastSuccessIndex = parsedEvents.map((event) => event.type).lastIndexOf(SUCCESS_EVENT_TYPE);
	const errors = parsedEvents
		.filter((event, index) => index > lastSuccessIndex && event.level === "error")
		.map((event) => ({ type: event.type, time: event.time, text: event.text }));
	return ok({
		schemaVersion: STATUS_SCHEMA_VERSION,
		mode: state.value.mode,
		versions: { rig: rigVersion.ok ? rigVersion.value : null, hub: hubVersion.ok ? hubVersion.value : null },
		releases: { rig: rigRelease, hub: hubRelease },
		features: features.value,
		lastUpdate: last === undefined ? null : { type: last.type, time: last.time, level: last.level, text: last.text },
		pendingHubRestart: state.value.pendingHubRestart,
		errors,
	});
};

// The language is not part of StatusView (the hub validates its JSON strictly); the text form gets it as an argument.
export const formatStatus = (status: StatusView, language: Language): string[] => {
	const messages = messagesFor(language);
	const lines = [
		messages.status.mode(status.mode),
		`agent-rig: ${formatRepositoryVersion(status.releases.rig, status.versions.rig, messages)}`,
		`hub: ${formatRepositoryVersion(status.releases.hub, status.versions.hub, messages)}`,
		messages.status.hubRestartPending(status.pendingHubRestart !== null),
		messages.status.language(messages.languageNames[language]),
	];
	for (const feature of status.features) lines.push(messages.status.featureLine(feature.name, feature.enabled, feature.platformAllowed));
	if (status.lastUpdate !== null) lines.push(messages.status.lastUpdate(status.lastUpdate.time, status.lastUpdate.text));
	for (const error of status.errors) lines.push(messages.status.errorLine(error.type, error.text));
	return lines;
};

const formatRepositoryVersion = (release: string | null, commit: string | null, messages: Messages): string => {
	if (commit === null) return messages.status.unknownVersion();
	return release === null ? commit : `${release} (${commit})`;
};

const readGitHead = async (runtime: RuntimePorts, path: string): Promise<Result<string>> => {
	const result = await runtime.process.run("git", ["-C", path, "rev-parse", "HEAD"]);
	if (!result.ok) return result;
	if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(result.value.stderr || result.value.stdout || "git rev-parse failed");
	return ok(result.value.stdout.trim());
};

const readGitVersion = async (runtime: RuntimePorts, path: string, commit: string | null, manifestPath: string): Promise<string | null> => {
	if (commit === null) return null;
	const result = await runtime.process.run("git", ["-C", path, "show", `${commit}:${manifestPath}`]);
	if (!result.ok || result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return null;
	return parseVersion(result.value.stdout);
};

const readEvents = async (runtime: RuntimePorts): Promise<Result<RigEvent[]>> => {
	try {
		const text = await runtime.fs.readText(pathJoin(runtime.home, ".agent-rig", "events.jsonl"));
		const events: RigEvent[] = [];
		for (const line of text.split(/\r?\n/)) {
			if (line.length === 0) continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				continue;
			}
			if (isRigEvent(value)) events.push(value);
		}
		return ok(events);
	} catch {
		return ok([]);
	}
};

const isRigEvent = (value: unknown): value is RigEvent => typeof value === "object" && value !== null && !Array.isArray(value) &&
	"id" in value && typeof value.id === "string" && "time" in value && typeof value.time === "string" &&
	"level" in value && (value.level === "info" || value.level === "warn" || value.level === "error") &&
	"type" in value && typeof value.type === "string" && "text" in value && typeof value.text === "string";

const isUpdateEventType = (value: string): boolean => UPDATE_EVENT_TYPES.some((type) => type === value);

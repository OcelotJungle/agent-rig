import type { FileSystem } from "./file-system.js";
import type { Result } from "./result.js";

import { atomicWrite, joinPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";

// A write-ahead journal of one `apply`. `entries` hold the record changes that count only when the file at `path`
// has the expected hash (`null` means the file is expected to be absent). `always` holds record changes that count
// unconditionally (a value of `null` deletes the record). `events` are sent after the final save; their ids are
// fixed when the journal is written, so a repeated send is recognised and skipped.
export type JournalEntry = { path: string; hash: string | null; records: Record<string, string | null> };
export type JournalEvent = { id: string; type: string; level: "info" | "warn" | "error"; text: string };
export type Journal = {
	entries: JournalEntry[];
	always: Record<string, string | null>;
	events: JournalEvent[];
};

export type RigState = {
	mode: "dev" | "server";
	paths: { repo: string; hub: string };
	features: Record<string, boolean>;
	records: Record<string, string>;
	badPairs: Array<{ repo: string; hub: string }>;
	pendingHubRestart: string | null;
	journal?: Journal;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
	isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
const isBooleanRecord = (value: unknown): value is Record<string, boolean> =>
	isObject(value) && Object.values(value).every((entry) => typeof entry === "boolean");
const isBadPair = (value: unknown): value is { repo: string; hub: string } =>
	isObject(value) && typeof value.repo === "string" && typeof value.hub === "string";

const isNullableStringRecord = (value: unknown): value is Record<string, string | null> =>
	isObject(value) && Object.values(value).every((entry) => entry === null || typeof entry === "string");
const isJournalEntry = (value: unknown): value is JournalEntry =>
	isObject(value) && typeof value.path === "string" && (value.hash === null || typeof value.hash === "string") &&
	isNullableStringRecord(value.records);
const isJournalEvent = (value: unknown): value is JournalEvent =>
	isObject(value) && typeof value.id === "string" && typeof value.type === "string" && typeof value.text === "string" &&
	(value.level === "info" || value.level === "warn" || value.level === "error");
const isJournal = (value: unknown): value is Journal =>
	isObject(value) && isUnknownArray(value.entries) && value.entries.every(isJournalEntry) &&
	isNullableStringRecord(value.always) &&
	isUnknownArray(value.events) && value.events.every(isJournalEvent);

export const parseState = (text: string): Result<RigState> => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return err("state.json is not valid JSON");
	}
	if (!isObject(value) || (value.mode !== "dev" && value.mode !== "server") ||
		!isObject(value.paths) || typeof value.paths.repo !== "string" || typeof value.paths.hub !== "string" ||
		!isBooleanRecord(value.features) || !isStringRecord(value.records) ||
		!isUnknownArray(value.badPairs) || !value.badPairs.every(isBadPair) ||
		!(value.pendingHubRestart === null || typeof value.pendingHubRestart === "string") ||
		!(value.journal === undefined || isJournal(value.journal))) {
		return err("state.json has an invalid shape");
	}
	const state: RigState = {
		mode: value.mode,
		paths: { repo: value.paths.repo, hub: value.paths.hub },
		features: value.features,
		records: value.records,
		badPairs: value.badPairs,
		pendingHubRestart: value.pendingHubRestart,
	};
	if (value.journal !== undefined) state.journal = value.journal;
	return ok(state);
};

export const readState = async (fs: FileSystem, home: string): Promise<Result<RigState>> => {
	try {
		return parseState(await fs.readText(joinPath(home, ".agent-rig", "state.json")));
	} catch (error) {
		return err(`Could not read state.json: ${errorText(error)}`);
	}
};

export const writeState = async (fs: FileSystem, home: string, state: RigState): Promise<Result<void>> => {
	try {
		const result = await atomicWrite(fs, joinPath(home, ".agent-rig", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
		return result.ok ? ok(undefined) : err(`Could not write state.json: ${result.error}`);
	} catch (error) {
		return err(`Could not write state.json: ${errorText(error)}`);
	}
};

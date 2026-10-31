import type { AssetOperations, FileSystem as AssetFileSystem } from "./assets/installer.js";
import type { FileSystem } from "./file-system.js";
import type { Result } from "./result.js";
import type { Journal, JournalEntry, JournalEvent } from "./state.js";

import { hashContent, hashText } from "./content-hash.js";
import { appendEvent } from "./events.js";
import { joinPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";

const EVENTS_FILE = "events.jsonl";
const NOT_FOUND = "not-found";
const SETTINGS_RECORD_PREFIX = "setting:";
const ASSET_RECORD_PREFIX = "asset:";
const PLUGIN_RECORD_PREFIX = "plugin:";

export type JournalDependencies = {
	fs: FileSystem;
	assetFs: AssetFileSystem;
	home: string;
	clock: { nowText(): string };
	ids: { next(): string };
};

export type PlannedEvent = Pick<JournalEvent, "type" | "level" | "text">;

export type JournalInput = {
	oldRecords: Readonly<Record<string, string>>;
	newRecords: Readonly<Record<string, string>>;
	assetOperations: AssetOperations;
	settingsPath: string;
	// The text that will be written to settings.json, or null when the file is not rewritten.
	settingsText: string | null;
	events: readonly JournalEvent[];
};

export const isRigRecordKey = (key: string): boolean =>
	key.startsWith(SETTINGS_RECORD_PREFIX) || key.startsWith(ASSET_RECORD_PREFIX) || key.startsWith(PLUGIN_RECORD_PREFIX);

export const planEvents = (dependencies: JournalDependencies, events: readonly PlannedEvent[]): JournalEvent[] =>
	events.map((event) => ({ id: dependencies.ids.next(), type: event.type, level: event.level, text: event.text }));

// A killed apply leaves a journal. A file that has the hash the journal expects was written by rig, so its ownership
// records are taken; a file that does not is untouched, so its old record stays. Nothing is left frozen either way.
export const recoverRecords = async (
	dependencies: JournalDependencies,
	journal: Journal,
	records: Readonly<Record<string, string>>,
	settingsPath: string,
): Promise<Result<Record<string, string>>> => {
	const recovered: Record<string, string> = { ...records };
	for (const entry of journal.entries) {
		const current = await currentHash(dependencies, entry.path, settingsPath);
		if (!current.ok) return current;
		if (current.value === entry.hash) applyRecordChanges(recovered, entry.records);
	}
	applyRecordChanges(recovered, journal.always);
	return ok(recovered);
};

// Sorts every changed ownership record under the file whose write makes it true, or under `always`.
export const buildJournal = (input: JournalInput): Journal => {
	const assetHashes = new Map<string, string | null>();
	for (const write of input.assetOperations.writes) assetHashes.set(write.path, hashContent(write.content));
	for (const path of input.assetOperations.removals) assetHashes.set(path, null);
	const settingsHash = input.settingsText === null ? undefined : hashText(input.settingsText);

	const entries = new Map<string, JournalEntry>();
	const always: Record<string, string | null> = {};
	const attach = (path: string, hash: string | null, key: string, value: string | null): void => {
		const entry = entries.get(path) ?? { path, hash, records: {} };
		entry.records[key] = value;
		entries.set(path, entry);
	};

	const keys = new Set([...Object.keys(input.oldRecords), ...Object.keys(input.newRecords)].filter(isRigRecordKey));
	for (const key of keys) {
		const oldValue = input.oldRecords[key];
		const newValue = input.newRecords[key];
		if (oldValue === newValue) continue;
		const value = newValue ?? null;
		if (key.startsWith(ASSET_RECORD_PREFIX)) {
			const path = key.slice(ASSET_RECORD_PREFIX.length);
			const hash = assetHashes.get(path);
			if (hash !== undefined) {
				attach(path, hash, key, value);
				continue;
			}
		}
		if (key.startsWith(SETTINGS_RECORD_PREFIX) && settingsHash !== undefined) {
			attach(input.settingsPath, settingsHash, key, value);
			continue;
		}
		always[key] = value;
	}
	return { entries: [...entries.values()], always, events: [...input.events] };
};

// Sends events once: an id that is already in the log was sent by a run that was killed before it finished.
export const emitJournalEvents = async (
	dependencies: JournalDependencies,
	events: readonly JournalEvent[],
): Promise<Result<void>> => {
	if (events.length === 0) return ok(undefined);
	const logged = await readLog(dependencies);
	if (!logged.ok) return logged;
	for (const event of events) {
		if (logged.value.includes(`"id":${JSON.stringify(event.id)}`)) continue;
		const appended = await appendEvent({
			fs: dependencies.fs,
			home: dependencies.home,
			now: () => dependencies.clock.nowText(),
			createId: () => event.id,
		}, { type: event.type, level: event.level, text: event.text });
		if (!appended.ok) return appended;
	}
	return ok(undefined);
};

const applyRecordChanges = (records: Record<string, string>, changes: Readonly<Record<string, string | null>>): void => {
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) delete records[key];
		else records[key] = value;
	}
};

const currentHash = async (
	dependencies: JournalDependencies,
	path: string,
	settingsPath: string,
): Promise<Result<string | null>> => {
	if (path === settingsPath) {
		try {
			return ok(hashText(await dependencies.fs.readText(path)));
		} catch (error) {
			return isMissing(error) ? ok(null) : err(`Could not read ${path}: ${errorText(error)}`);
		}
	}
	const read = await dependencies.assetFs.readFile(path);
	if (read.ok) return ok(hashContent(read.value));
	return read.error === NOT_FOUND ? ok(null) : err(`Could not read ${path}: ${read.error}`);
};

const readLog = async (dependencies: JournalDependencies): Promise<Result<string>> => {
	try {
		return ok(await dependencies.fs.readText(joinPath(dependencies.home, ".agent-rig", EVENTS_FILE)));
	} catch (error) {
		return isMissing(error) ? ok("") : err(`Could not read the event log: ${errorText(error)}`);
	}
};

const isMissing = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

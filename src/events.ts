import type { FileSystem } from "./file-system.js";
import type { Result } from "./result.js";

import { atomicWrite, joinPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";

const EVENT_FILE = "events.jsonl";
const OFFSET_FILE = "events.offset";
// Keep the log bounded while giving the hub room to catch up after short outages.
const EVENT_FILE_TRIM_THRESHOLD_BYTES = 1024 * 1024;

export type EventLevel = "info" | "warn" | "error";
export type RigEvent = {
	id: string;
	time: string;
	level: EventLevel;
	type: string;
	text: string;
};
export type EventInput = Pick<RigEvent, "level" | "type" | "text">;
export type EventDependencies = {
	fs: FileSystem;
	home: string;
	now(): string;
	createId(): string;
};

export const appendEvent = async (dependencies: EventDependencies, input: EventInput): Promise<Result<RigEvent>> => {
	const event: RigEvent = { id: dependencies.createId(), time: dependencies.now(), ...input };
	const eventPath = joinPath(dependencies.home, ".agent-rig", EVENT_FILE);
	try {
		await dependencies.fs.ensureDirectory(joinPath(dependencies.home, ".agent-rig"));
		await dependencies.fs.appendText(eventPath, `${JSON.stringify(event)}\n`);
		return ok(event);
	} catch (error) {
		return err(`Could not append event: ${errorText(error)}`);
	}
};

export const trimEvents = async (dependencies: EventDependencies): Promise<Result<void>> => {
	const eventPath = joinPath(dependencies.home, ".agent-rig", EVENT_FILE);
	const offsetPath = joinPath(dependencies.home, ".agent-rig", OFFSET_FILE);
	try {
		const eventText = await dependencies.fs.readText(eventPath);
		const encoded = new TextEncoder().encode(eventText);
		if (encoded.length <= EVENT_FILE_TRIM_THRESHOLD_BYTES) return ok(undefined);

		const offsetText = await dependencies.fs.readText(offsetPath).catch(() => "");
		const offsetValue = offsetText.trim();
		if (!/^\d+$/.test(offsetValue)) return ok(undefined);
		const offset = Number(offsetValue);
		if (!Number.isSafeInteger(offset) || offset !== encoded.length) return ok(undefined);

		const fileWrite = await atomicWrite(dependencies.fs, eventPath, "");
		if (!fileWrite.ok) return err(`Could not trim events: ${fileWrite.error}`);
		return ok(undefined);
	} catch (error) {
		return err(`Could not trim events: ${errorText(error)}`);
	}
};

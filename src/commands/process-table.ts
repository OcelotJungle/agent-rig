import type { Messages } from "../messages.js";
import type { ProcessEntry } from "../ports.js";
import type { Result } from "../result.js";

import { err, ok } from "../result.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const entryOf = (row: unknown): ProcessEntry | null => {
	if (!isObject(row)) return null;
	const { pid, parent, name, commandLine, createdAt } = row;
	if (typeof pid !== "number" || !Number.isInteger(pid) || typeof parent !== "number" || !Number.isInteger(parent)) return null;
	if (typeof name !== "string" || typeof commandLine !== "string") return null;
	if (createdAt !== null && typeof createdAt !== "string") return null;
	return { pid, parent, name, commandLine, createdAt };
};

/** The rows of `session_record.py list` (a JSON array of {pid, parent, name, commandLine, createdAt}); one row that does not fit the shape fails the whole table. */
export const parseProcessTable = (text: string, messages: Messages): Result<ProcessEntry[]> => {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return err(messages.failure.processTableInvalid()); }
	if (!Array.isArray(value)) return err(messages.failure.processTableInvalid());
	const entries: ProcessEntry[] = [];
	for (const row of value) {
		const entry = entryOf(row);
		if (entry === null) return err(messages.failure.processTableInvalid());
		entries.push(entry);
	}
	return ok(entries);
};

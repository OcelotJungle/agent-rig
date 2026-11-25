import type { ApiError } from "./output.js";

// The data `rig info --session <id>` returns (see docs/superpowers/specs/rig-sessions-design.md): raw readings only.
// Times are ISO-8601 UTC strings; percents are as the source reported them. Ages, durations, names and rounding belong
// to the client.

export type ClaudeLimit = { kind: string; percentUsed: number; resetsAt: string | null };
// `skipped`: other sessions whose account could not be read, each with its own error; present only when there are any.
export type ClaudeReading = { at: string | null; sessionId: string; limits: ClaudeLimit[]; skipped?: Array<{ sessionId: string } & BlockError> };
export type CodexLimit = { windowMinutes: number; usedPercent: number; resetsAt: string | null };
export type CodexReading = { at: string; limits: CodexLimit[] };
export type VolunteerProvider = { used: number; cap: number | null };
export type VolunteerReading = {
	at: string;
	source: string;
	dayPercent: number;
	used: number | null;
	cap: number | null;
	resetsAt: string | null;
	providers: Record<string, VolunteerProvider>;
};
export type ContextReading = {
	at: string | null;
	tokens: number;
	window: number | null;
	threshold?: number;
	autocompact?: boolean;
	estimated?: true;
};

// A block whose source failed carries the failure instead of a reading.
export type BlockError = { error: ApiError };
export type Block<T> = T | BlockError;

export type InfoData = {
	session: string;
	account: number | null;
	claude: Block<ClaudeReading>;
	// Absent when the feature is off or the session's project is on the denylist.
	codex?: Block<CodexReading>;
	volunteers?: Block<VolunteerReading>;
	context: Block<ContextReading>;
};

// A time in milliseconds as ISO-8601 UTC; null when it is not a representable time.
export const isoOrNull = (milliseconds: number): string | null => {
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

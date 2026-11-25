import type { OwnerIds } from "../../src/session-owner.js";
import type { MemoryRuntimeHarness } from "./memory-runtime.js";

import { ok } from "../../src/result.js";

const HOME = "/home/test";
const PROCESS_SUCCESS = 0;

// Invented ids; the real ones never appear in tests.
export const DEFAULT_LOGIN: OwnerIds = { accountUuid: "default-account-uuid", organizationUuid: "default-organization-uuid" };
export const ACCOUNT_ONE: OwnerIds = { accountUuid: "account-one-uuid", organizationUuid: "organization-one-uuid" };

// The folder key of a launch in the memory runtime: its git answers `/repo` as the top level of every directory.
export const WORKSPACE_KEY = "/repo";

// One owner line as Claude Code writes it (key order included), without the trailing newline.
export const ownerLine = (ids: OwnerIds, session: string): string => JSON.stringify({ type: "session-owner", accountUuid: ids.accountUuid, organizationUuid: ids.organizationUuid, sessionId: session });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (h: MemoryRuntimeHarness, path: string): Record<string, unknown> => {
	const text = h.fs.files.get(path);
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	return isRecord(parsed) ? parsed : {};
};

// `~/.claude.json` of the default login: the target of a launch without cswap. Other fields already there stay.
export const seedDefaultLogin = (h: MemoryRuntimeHarness, ids: OwnerIds = DEFAULT_LOGIN): void => {
	h.fs.seed(`${HOME}/.claude.json`, JSON.stringify({ ...readJson(h, `${HOME}/.claude.json`), oauthAccount: { ...ids, emailAddress: "someone@example.test" } }));
};

// The user trusted the folder in the default config; `entry` is the project entry as Claude Code keeps it.
export const trustFolderInDefault = (h: MemoryRuntimeHarness, folder: string = WORKSPACE_KEY, entry: Record<string, unknown> = { hasTrustDialogAccepted: true }): void => {
	const config = readJson(h, `${HOME}/.claude.json`);
	const projects = isRecord(config.projects) ? config.projects : {};
	h.fs.seed(`${HOME}/.claude.json`, JSON.stringify({ ...config, projects: { ...projects, [folder]: entry } }));
};

// Where cswap keeps the side profile of an account, as the helper's `config-dir` answers it.
export const profileDirectory = (account: number): string => `${HOME}/.claude-swap-backup/sessions/${account}-test`;
export const profileFile = (account: number): string => `${profileDirectory(account)}/.claude.json`;

// The side profile of an account as cswap leaves it after its first login.
export const seedProfile = (h: MemoryRuntimeHarness, account: number, config: Record<string, unknown> = { hasCompletedOnboarding: true }): void => {
	h.fs.seed(profileFile(account), JSON.stringify(config));
};

// The allowlist helper's `owner --account N` and `config-dir --account N` answers; other calls go to the runtime's own handler.
// An account without an entry answers `{error}`, as the helper does for an unknown account (a failed query still exits 0).
export const answerHelperQueries = (h: MemoryRuntimeHarness, accounts: Record<number, OwnerIds>): void => {
	const other = h.runtime.process.run.bind(h.runtime.process);
	h.runtime.process.run = async (command, args, options) => {
		const ownerAt = args.indexOf("owner");
		if (ownerAt !== -1) {
			const ids = accounts[Number(args[ownerAt + 2])];
			return ok({ stdout: JSON.stringify(ids ?? { error: "unknown account" }), stderr: "", exitCode: PROCESS_SUCCESS });
		}
		const directoryAt = args.indexOf("config-dir");
		if (directoryAt === -1) return other(command, args, options);
		const account = Number(args[directoryAt + 2]);
		const answer = account in accounts
			? { dir: profileDirectory(account), file: profileFile(account), isDefault: false, exists: h.fs.files.has(profileFile(account)) }
			: { error: "unknown account" };
		return ok({ stdout: JSON.stringify(answer), stderr: "", exitCode: PROCESS_SUCCESS });
	};
};

// Every call but git and the helper's owner and config-dir queries answers `stdout` (the account lookup of a launch).
// Installed after `answerOwnerQueries`, so those queries reach its answers.
export const answerAccountLookup = (h: MemoryRuntimeHarness, stdout: string): void => {
	const other = h.runtime.process.run.bind(h.runtime.process);
	h.runtime.process.run = async (command, args, options) => command === "git" || args.includes("owner") || args.includes("config-dir")
		? other(command, args, options)
		: ok({ stdout, stderr: "", exitCode: PROCESS_SUCCESS });
};

// The helper's answers plus a launch under each account that may go ahead: the folder trusted in the default config and a set-up profile.
export const answerOwnerQueries = (h: MemoryRuntimeHarness, accounts: Record<number, OwnerIds>): void => {
	answerHelperQueries(h, accounts);
	trustFolderInDefault(h);
	for (const account of Object.keys(accounts).map(Number)) seedProfile(h, account);
};

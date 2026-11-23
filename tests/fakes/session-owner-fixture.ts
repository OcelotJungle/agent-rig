import type { OwnerIds } from "../../src/session-owner.js";
import type { MemoryRuntimeHarness } from "./memory-runtime.js";

import { ok } from "../../src/result.js";

const HOME = "/home/test";
const PROCESS_SUCCESS = 0;

// Invented ids; the real ones never appear in tests.
export const DEFAULT_LOGIN: OwnerIds = { accountUuid: "default-account-uuid", organizationUuid: "default-organization-uuid" };
export const ACCOUNT_ONE: OwnerIds = { accountUuid: "account-one-uuid", organizationUuid: "organization-one-uuid" };

// One owner line as Claude Code writes it (key order included), without the trailing newline.
export const ownerLine = (ids: OwnerIds, session: string): string => JSON.stringify({ type: "session-owner", accountUuid: ids.accountUuid, organizationUuid: ids.organizationUuid, sessionId: session });

// `~/.claude.json` of the default login: the target of a launch without cswap.
export const seedDefaultLogin = (h: MemoryRuntimeHarness, ids: OwnerIds = DEFAULT_LOGIN): void => {
	h.fs.seed(`${HOME}/.claude.json`, JSON.stringify({ oauthAccount: { ...ids, emailAddress: "someone@example.test" } }));
};

// The allowlist helper's `owner --account N` answers, by account number; other calls go to the runtime's own handler.
// An account without an entry answers `{error}`, as the helper does for an unknown account (a failed query still exits 0).
export const answerOwnerQueries = (h: MemoryRuntimeHarness, accounts: Record<number, OwnerIds>): void => {
	const other = h.runtime.process.run.bind(h.runtime.process);
	h.runtime.process.run = async (command, args, options) => {
		const at = args.indexOf("owner");
		if (at === -1) return other(command, args, options);
		const ids = accounts[Number(args[at + 2])];
		return ok({ stdout: JSON.stringify(ids ?? { error: "unknown account" }), stderr: "", exitCode: PROCESS_SUCCESS });
	};
};

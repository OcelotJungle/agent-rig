import type { ApiResult } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { OwnerTarget } from "../session-owner.js";

import { joinPath } from "../file-system.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk, LAUNCH_ACCOUNT_LOOKUP } from "../output.js";
import { INFO_ERROR_STATE_UNREADABLE, ownerIdsOf } from "./info.js";
import { readRigState } from "./shared.js";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

// The default login's ids, from `~/.claude.json` `oauthAccount`; the launch environment drops `CLAUDE*`, so without cswap
// the session always starts under it. The values are never printed.
const defaultLoginTarget = async (runtime: RuntimePorts): Promise<OwnerTarget> => {
	let account: unknown;
	try {
		const file: unknown = JSON.parse(await runtime.fs.readText(joinPath(runtime.home, ".claude.json")));
		account = object(file) ? file.oauthAccount : null;
	} catch { return { kind: "unavailable", reason: "ids-unreadable" }; }
	if (!object(account) || !nonEmptyString(account.accountUuid) || !nonEmptyString(account.organizationUuid)) return { kind: "unavailable", reason: "ids-unreadable" };
	return { kind: "ids", ids: { accountUuid: account.accountUuid, organizationUuid: account.organizationUuid } };
};

// The account the launch will run under, as ids. With cswap and a number the ids come from cswap's registry through the
// allowlist helper, and a failed query fails the launch before anything is stopped; with cswap and no number the account
// is picked by cswap itself, so it is unknown; without cswap it is the default login.
export const resolveOwnerTarget = async (runtime: RuntimePorts, cswapFound: string | null, accountText: string): Promise<ApiResult<OwnerTarget>> => {
	if (cswapFound === null) return apiOk(await defaultLoginTarget(runtime));
	if (accountText === "") return apiOk({ kind: "unavailable", reason: "account-unknown" });
	const state = await readRigState(runtime);
	if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
	const ids = await ownerIdsOf(runtime, state.value, Number(accountText));
	return ids.ok ? apiOk({ kind: "ids", ids: ids.value }) : apiFail(LAUNCH_ACCOUNT_LOOKUP, messagesFor(runtime.language).session.launchAccountLookup(ids.error));
};

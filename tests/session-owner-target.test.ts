import { describe, expect, test } from "bun:test";

import { ownerIdsOf } from "../src/commands/info.js";
import { resolveOwnerTarget } from "../src/commands/session-owner-target.js";
import { messagesFor } from "../src/messages.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";
import { ACCOUNT_ONE, answerOwnerQueries, DEFAULT_LOGIN, seedDefaultLogin } from "./fakes/session-owner-fixture.js";

const ROOT = "/home/test/.agent-rig";
const CSWAP = "/usr/bin/cswap";
const STATE = { mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };
const ACCOUNT = 1;

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify(STATE));
	return h;
};
const stateOf = async (h: ReturnType<typeof setup>) => JSON.parse(await h.fs.readText(`${ROOT}/state.json`));
// The helper answers this text for `owner`.
const helperSays = (h: ReturnType<typeof setup>, stdout: string, exitCode = 0): void => {
	h.runtime.process.run = async () => ok({ stdout, stderr: "", exitCode });
};

describe("the owner target of a launch", () => {
	test("without cswap it is the default login's ids from ~/.claude.json", async () => {
		const h = setup();
		seedDefaultLogin(h);
		expect(await resolveOwnerTarget(h.runtime, null, "")).toEqual({ ok: true, value: { kind: "ids", ids: DEFAULT_LOGIN } });
	});
	test("without cswap an unreadable or incomplete ~/.claude.json makes it unavailable as ids-unreadable", async () => {
		for (const content of [null, "not json", "[]", "{}", '{"oauthAccount":{"accountUuid":"a"}}', '{"oauthAccount":{"accountUuid":"","organizationUuid":"o"}}', '{"oauthAccount":{"accountUuid":1,"organizationUuid":"o"}}']) {
			const h = setup();
			if (content !== null) h.fs.seed("/home/test/.claude.json", content);
			expect(await resolveOwnerTarget(h.runtime, null, "")).toEqual({ ok: true, value: { kind: "unavailable", reason: "ids-unreadable" } });
		}
	});
	test("with cswap and no account number it is unavailable as account-unknown", async () => {
		const h = setup();
		seedDefaultLogin(h);
		expect(await resolveOwnerTarget(h.runtime, CSWAP, "")).toEqual({ ok: true, value: { kind: "unavailable", reason: "account-unknown" } });
	});
	test("with cswap and an account number it is that account's ids from the helper", async () => {
		const h = setup();
		answerOwnerQueries(h, { [ACCOUNT]: ACCOUNT_ONE });
		expect(await resolveOwnerTarget(h.runtime, CSWAP, String(ACCOUNT))).toEqual({ ok: true, value: { kind: "ids", ids: ACCOUNT_ONE } });
	});
	test("an account the helper does not know, a failed helper and a malformed answer fail as launch-account-lookup", async () => {
		const h = setup();
		answerOwnerQueries(h, {});
		const unknown = await resolveOwnerTarget(h.runtime, CSWAP, "9");
		expect(unknown.ok ? "ok" : unknown.error.code).toBe("launch-account-lookup");
		expect(unknown.ok ? "" : unknown.error.message).toContain("unknown account");
		for (const [stdout, exitCode] of [["", 2], ["garbage", 0], ['{"accountUuid":"a"}', 0], ['{"accountUuid":"","organizationUuid":"o"}', 0]] as const) {
			helperSays(h, stdout, exitCode);
			const result = await resolveOwnerTarget(h.runtime, CSWAP, String(ACCOUNT));
			expect(result.ok ? "ok" : result.error.code).toBe("launch-account-lookup");
		}
	});
	test("ownerIdsOf asks the helper for the owner of exactly that account", async () => {
		const h = setup();
		const calls: string[][] = [];
		h.runtime.process.run = async (_command, args) => { calls.push([...args]); return ok({ stdout: JSON.stringify(ACCOUNT_ONE), stderr: "", exitCode: 0 }); };
		const ids = await ownerIdsOf(h.runtime, await stateOf(h), ACCOUNT);
		expect(ids).toEqual({ ok: true, value: ACCOUNT_ONE });
		expect(calls).toHaveLength(1);
		expect(calls[0].slice(-3)).toEqual(["owner", "--account", String(ACCOUNT)]);
	});
	test("the malformed-ids message exists in both languages and is translated", () => {
		const english = messagesFor("en").info.allowlistBadOwner();
		expect(english).not.toBe("");
		expect(messagesFor("ru").info.allowlistBadOwner()).not.toBe(english);
	});
});

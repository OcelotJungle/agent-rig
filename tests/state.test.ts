import type { RigState } from "../src/state.js";

import { describe, expect, test } from "bun:test";
import { parseState } from "../src/state.js";

describe("state", () => {
	test("reports a useful error for malformed JSON", () => {
		const result = parseState("{");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("state.json");
	});

	test("round trips the rig state shape", () => {
		const state: RigState = {
			mode: "dev",
			paths: { repo: "C:/repo", hub: "C:/hub" },
			features: { codex: true },
			records: {},
			badPairs: [],
			pendingHubRestart: null,
		};

		const result = parseState(JSON.stringify(state));
		expect(result).toEqual({ ok: true, value: state });
	});

	test("keeps an optional language and treats a state without one as valid", () => {
		const base: RigState = {
			mode: "server",
			paths: { repo: "/repo", hub: "/hub" },
			features: {},
			records: {},
			badPairs: [],
			pendingHubRestart: null,
		};

		expect(parseState(JSON.stringify(base))).toEqual({ ok: true, value: base });
		expect(parseState(JSON.stringify({ ...base, language: "ru" }))).toEqual({ ok: true, value: { ...base, language: "ru" } });
		expect(parseState(JSON.stringify({ ...base, language: "en" }))).toEqual({ ok: true, value: { ...base, language: "en" } });
	});

	test("rejects a language that is not en or ru", () => {
		const base = { mode: "server", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };

		expect(parseState(JSON.stringify({ ...base, language: "de" })).ok).toBe(false);
		expect(parseState(JSON.stringify({ ...base, language: 5 })).ok).toBe(false);
		expect(parseState(JSON.stringify({ ...base, language: null })).ok).toBe(false);
	});
});

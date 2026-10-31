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
});

import type { RigState } from "../src/state.js";

import { describe, expect, test } from "bun:test";
import { parseState, parseStateReport, readStoredLanguage } from "../src/state.js";
import { MemoryFileSystem } from "./fakes/memory-runtime.js";

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

	test("clone and hub paths written with backslashes by an older build are read with forward slashes", () => {
		const state: RigState = {
			mode: "dev",
			paths: { repo: "C:\\projects\\rig", hub: "C:\\projects\\hub" },
			features: {},
			records: {},
			badPairs: [],
			pendingHubRestart: null,
		};

		const result = parseState(JSON.stringify(state));

		expect(result.ok && result.value.paths).toEqual({ repo: "C:/projects/rig", hub: "C:/projects/hub" });
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

	test("a language that is not en or ru is dropped (read as English) and the rest of the state stays valid", () => {
		const base: RigState = { mode: "server", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };

		for (const language of ["de", 5, null]) {
			expect(parseState(JSON.stringify({ ...base, language }))).toEqual({ ok: true, value: base });
		}
	});

	test("the report tells that a stored language value is invalid, so `rig language` can repair it", () => {
		const base = { mode: "server", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };

		const invalid = parseStateReport(JSON.stringify({ ...base, language: "de" }));
		const valid = parseStateReport(JSON.stringify({ ...base, language: "ru" }));
		const absent = parseStateReport(JSON.stringify(base));

		expect(invalid.ok && invalid.value.languageInvalid).toBe(true);
		expect(valid.ok && valid.value.languageInvalid).toBe(false);
		expect(absent.ok && absent.value.languageInvalid).toBe(false);
	});

	test("other invalid fields still make the whole state invalid", () => {
		const base = { mode: "server", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };

		expect(parseState(JSON.stringify({ ...base, mode: "other", language: "ru" })).ok).toBe(false);
		expect(parseState(JSON.stringify({ ...base, features: { demo: "yes" } })).ok).toBe(false);
	});

	test("readStoredLanguage reads the language, and gives English for a missing, broken or invalid state", async () => {
		const base = { mode: "server", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null };
		const fs = new MemoryFileSystem();
		expect(await readStoredLanguage(fs, "/home")).toBe("en");
		fs.seed("/home/.agent-rig/state.json", "{");
		expect(await readStoredLanguage(fs, "/home")).toBe("en");
		fs.seed("/home/.agent-rig/state.json", JSON.stringify({ ...base, language: "de" }));
		expect(await readStoredLanguage(fs, "/home")).toBe("en");
		fs.seed("/home/.agent-rig/state.json", JSON.stringify({ ...base, language: "ru" }));
		expect(await readStoredLanguage(fs, "/home")).toBe("ru");
	});
});

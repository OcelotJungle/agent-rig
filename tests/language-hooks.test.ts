import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { readStoredLanguage } from "../src/state.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SETTINGS_PATH = `${HOME}/.claude/settings.json`;
const SUCCESS_EXIT_CODE = 0;
const ENGLISH_MESSAGE = "Reflecting on the turn";
const RUSSIAN_MESSAGE = "Рефлексия хода";
const HAND_MESSAGE = "my own message";
const HOOK = {
	event: "Stop",
	matcher: "",
	command: "{{PYTHON}}",
	args: ["{{CLONE}}/features/demo/hooks/reflect.py"],
	statusMessage: ENGLISH_MESSAGE,
	translations: { ru: { statusMessage: RUSSIAN_MESSAGE } },
};

const setup = (language: "en" | "ru" = "en"): MemoryRuntimeHarness => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, baseManifest());
	// The hook carries a `translations` key that the manifest helper does not type; the file is plain JSON.
	seedFeature(harness.fs, REPO, featureManifest("demo", { enabledByDefault: true, hooks: [HOOK] }));
	const state = {
		mode: "dev",
		paths: { repo: REPO, hub: HUB },
		features: { demo: true },
		records: {},
		badPairs: [],
		pendingHubRestart: null,
		language,
	};
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	return harness;
};

const run = async (harness: MemoryRuntimeHarness, args: string[]): Promise<{ code: number; output: string[] }> => {
	const output: string[] = [];
	harness.runtime.language = await readStoredLanguage(harness.fs, HOME);
	const code = await runCli(args, (line) => output.push(line), harness.runtime);
	return { code, output };
};

const statusMessages = (harness: MemoryRuntimeHarness): unknown[] => {
	const settings: unknown = JSON.parse(harness.fs.files.get(SETTINGS_PATH) ?? "{}");
	const messages: unknown[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (typeof value === "object" && value !== null) {
			for (const [key, child] of Object.entries(value)) {
				if (key === "statusMessage") messages.push(child);
				else visit(child);
			}
		}
	};
	visit(settings);
	return messages;
};

describe("hook status messages follow the language", () => {
	test("an apply in Russian writes the translated status message", async () => {
		const harness = setup("ru");

		const result = await run(harness, ["apply"]);

		expect(result.code).toBe(SUCCESS_EXIT_CODE);
		expect(statusMessages(harness)).toEqual([RUSSIAN_MESSAGE]);
	});

	test("an apply in English writes the plain status message", async () => {
		const harness = setup("en");

		await run(harness, ["apply"]);

		expect(statusMessages(harness)).toEqual([ENGLISH_MESSAGE]);
	});

	test("a hook without a translation for the language keeps the English status message", async () => {
		const harness = setup("ru");
		const { translations: _translations, ...plain } = HOOK;
		seedFeature(harness.fs, REPO, featureManifest("demo", { enabledByDefault: true, hooks: [plain] }));

		await run(harness, ["apply"]);

		expect(statusMessages(harness)).toEqual([ENGLISH_MESSAGE]);
	});

	test("rig language ru then en rewrites rig's own hook entry each time", async () => {
		const harness = setup("en");
		await run(harness, ["apply"]);
		expect(statusMessages(harness)).toEqual([ENGLISH_MESSAGE]);

		const toRussian = await run(harness, ["language", "ru"]);
		expect(toRussian.code).toBe(SUCCESS_EXIT_CODE);
		expect(statusMessages(harness)).toEqual([RUSSIAN_MESSAGE]);

		const toEnglish = await run(harness, ["language", "en"]);
		expect(toEnglish.code).toBe(SUCCESS_EXIT_CODE);
		expect(statusMessages(harness)).toEqual([ENGLISH_MESSAGE]);
	});

	test("a status message the user changed by hand is kept when the language changes", async () => {
		const harness = setup("en");
		await run(harness, ["apply"]);
		const edited = (harness.fs.files.get(SETTINGS_PATH) ?? "").replace(ENGLISH_MESSAGE, HAND_MESSAGE);
		harness.fs.seed(SETTINGS_PATH, edited);

		await run(harness, ["language", "ru"]);

		expect(statusMessages(harness)).toEqual([HAND_MESSAGE]);
	});
});

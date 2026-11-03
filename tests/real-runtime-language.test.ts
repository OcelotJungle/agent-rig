import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { messagesFor } from "../src/messages.js";

const TEMP_DIRECTORY_PREFIX = "agent-rig-early-language-";
const UNSUPPORTED_HOST = "freebsd";

type SavedEnvironment = { USERPROFILE: string | undefined; HOME: string | undefined };

let savedEnvironment: SavedEnvironment | undefined;
let temporaryHome: string | undefined;

const restoreEnvironment = (name: "USERPROFILE" | "HOME", value: string | undefined): void => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

const prepareHome = async (stateText: string | null): Promise<void> => {
	const home = await fs.mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
	temporaryHome = home;
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	if (stateText === null) return;
	await fs.mkdir(join(home, ".agent-rig"), { recursive: true });
	await fs.writeFile(join(home, ".agent-rig", "state.json"), stateText, "utf8");
};

const stateWith = (language: string | undefined): string => JSON.stringify({
	mode: "dev",
	paths: { repo: "/repo", hub: "/hub" },
	features: {},
	records: {},
	badPairs: [],
	pendingHubRestart: null,
	...(language === undefined ? {} : { language }),
});

beforeEach(() => {
	savedEnvironment = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
});

afterEach(async () => {
	if (savedEnvironment !== undefined) {
		restoreEnvironment("USERPROFILE", savedEnvironment.USERPROFILE);
		restoreEnvironment("HOME", savedEnvironment.HOME);
		savedEnvironment = undefined;
	}
	if (temporaryHome !== undefined) {
		await fs.rm(temporaryHome, { recursive: true, force: true });
		temporaryHome = undefined;
	}
});

describe("errors raised while the real runtime is built", () => {
	test("use the language from state.json", async () => {
		await prepareHome(stateWith("ru"));
		const runtime = await createRealRuntime({ hostName: UNSUPPORTED_HOST });
		expect(runtime).toEqual({ ok: false, error: messagesFor("ru").runtime.platformUnsupported(UNSUPPORTED_HOST) });
		expect(messagesFor("ru").runtime.platformUnsupported(UNSUPPORTED_HOST)).not.toBe(messagesFor("en").runtime.platformUnsupported(UNSUPPORTED_HOST));
	});

	test("are in English when state.json says en, has no language, is missing or is unreadable", async () => {
		const english = { ok: false as const, error: messagesFor("en").runtime.platformUnsupported(UNSUPPORTED_HOST) };
		for (const stateText of [stateWith("en"), stateWith(undefined), null, "{ not json", stateWith("de")]) {
			await prepareHome(stateText);
			expect(await createRealRuntime({ hostName: UNSUPPORTED_HOST })).toEqual(english);
			await fs.rm(temporaryHome ?? "", { recursive: true, force: true });
		}
	});

	test("the runtime built on a supported host carries the language of state.json", async () => {
		await prepareHome(stateWith("ru"));
		const runtime = await createRealRuntime();
		if (!runtime.ok) throw new Error(runtime.error);
		expect(runtime.value.language).toBe("ru");
	});
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const CYRILLIC = /[\u0400-\u04ff]/;
const GIT_LIST_BUFFER_BYTES = 16 * 1024 * 1024;
const JSON_SUFFIX = ".json";
// The Russian message catalog is the one source file that holds Russian texts of the command output.
const RUSSIAN_CATALOG = "src/messages-ru.ts";
// Test data that proves the Russian switch: the expected Russian command output is written out here on purpose.
const RUSSIAN_SWITCH_TESTS = "tests/language.test.ts";
const ALLOWED_FILES: ReadonlySet<string> = new Set([RUSSIAN_CATALOG, RUSSIAN_SWITCH_TESTS]);

// The Docker scenarios mount the repository read-only under another owner; git refuses such a directory unless told it is safe.
const trackedFiles = (): string[] => {
	const listing = spawnSync("git", ["-c", `safe.directory=${REPOSITORY_ROOT}`, "ls-files", "-z"], { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: GIT_LIST_BUFFER_BYTES });
	if (listing.status !== 0) throw new Error(`git ls-files failed: ${listing.stderr}`);
	return listing.stdout.split("\0").filter((path) => path.length > 0);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Drops every value under `translations` (the translated texts of a manifest), at any depth of the parsed document.
const withoutTranslations = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(withoutTranslations);
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key !== "translations") result[key] = withoutTranslations(child);
	}
	return result;
};

// The text to check, or null for a binary file.
const checkedText = (path: string, bytes: Buffer): string | null => {
	if (bytes.includes(0)) return null;
	const text = bytes.toString("utf8");
	if (!path.endsWith(JSON_SUFFIX)) return text;
	try {
		return JSON.stringify(withoutTranslations(JSON.parse(text)));
	} catch {
		return text;
	}
};

describe("language of tracked files", () => {
	test("no tracked text file has Cyrillic characters except the Russian catalog, the Russian switch test and manifest translations", () => {
		const offenders = trackedFiles()
			.filter((path) => !ALLOWED_FILES.has(path))
			.filter((path) => {
				const text = checkedText(path, readFileSync(join(REPOSITORY_ROOT, path)));
				return text !== null && CYRILLIC.test(text);
			});
		expect(offenders).toEqual([]);
	});

	test("the guard ignores manifest translations but sees Cyrillic anywhere else in a manifest", () => {
		const manifest = (extra: string): Buffer => Buffer.from(JSON.stringify({
			description: "Base",
			translations: { ru: { description: "\u0411\u0430\u0437\u0430" } },
			note: extra,
		}));
		expect(checkedText("x/feature.json", manifest("plain"))).not.toBeNull();
		expect(CYRILLIC.test(checkedText("x/feature.json", manifest("plain")) ?? "")).toBe(false);
		expect(CYRILLIC.test(checkedText("x/feature.json", manifest("\u0422\u0435\u043a\u0441\u0442")) ?? "")).toBe(true);
	});

	test("a binary file is skipped", () => {
		expect(checkedText("x.bin", Buffer.from([0, 0xd0, 0x91]))).toBeNull();
	});
});

import type { Messages } from "../src/messages.js";

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { en, messagesFor } from "../src/messages.js";
import { ru } from "../src/messages-ru.js";

const SOURCE_ROOT = join(import.meta.dir, "..", "src");
const RUSSIAN_CATALOG = "messages-ru.ts";
const CYRILLIC = /[Ѐ-ӿ]/;

// Compile-time proof: the Russian catalog is assignable to the type of the English one, so a key missing from `ru`
// (or a message whose parameters differ) fails `tsc --noEmit`.
export const russianCoversEnglish: Messages = ru;

type Shape = string | { [key: string]: Shape };

const shapeOf = (value: unknown): Shape => {
	if (typeof value === "function") return `function/${value.length}`;
	if (typeof value === "string") return "string";
	if (typeof value !== "object" || value === null) throw new Error("unexpected catalog value");
	const result: { [key: string]: Shape } = {};
	for (const key of Object.keys(value).sort()) result[key] = shapeOf(Reflect.get(value, key));
	return result;
};

const sourceFiles = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
	const path = join(directory, name);
	return statSync(path).isDirectory() ? sourceFiles(path) : [path];
});

describe("message catalog", () => {
	test("the Russian catalog has exactly the keys, nesting and message arities of the English one", () => {
		expect(shapeOf(ru)).toEqual(shapeOf(en));
	});

	test("messagesFor picks the catalog of the language", () => {
		expect(messagesFor("en")).toBe(en);
		expect(messagesFor("ru")).toBe(ru);
	});

	test("no catalog message is empty", () => {
		const empty: string[] = [];
		const walk = (path: string, value: unknown): void => {
			if (typeof value === "string" && value.length === 0) empty.push(path);
			else if (typeof value === "object" && value !== null) for (const key of Object.keys(value)) walk(`${path}.${key}`, Reflect.get(value, key));
		};
		walk("en", en);
		walk("ru", ru);
		expect(empty).toEqual([]);
	});

	test("the English catalog has no Cyrillic characters", () => {
		expect(CYRILLIC.test(readFileSync(join(SOURCE_ROOT, "messages.ts"), "utf8"))).toBe(false);
	});

	test("no file under src/ contains Cyrillic characters except the Russian catalog", () => {
		const offenders = sourceFiles(SOURCE_ROOT)
			.filter((path) => path.endsWith(".ts") && relative(SOURCE_ROOT, path).split(sep).join("/") !== RUSSIAN_CATALOG)
			.filter((path) => CYRILLIC.test(readFileSync(path, "utf8")))
			.map((path) => relative(SOURCE_ROOT, path));
		expect(offenders).toEqual([]);
	});

	test("the Russian catalog really contains Russian texts", () => {
		expect(CYRILLIC.test(readFileSync(join(SOURCE_ROOT, RUSSIAN_CATALOG), "utf8"))).toBe(true);
	});
});

import type { FeatureManifest } from "../src/feature.js";

import { describe, expect, test } from "bun:test";

import { installMissingPrograms } from "../src/commands/programs.js";
import { validateFeature } from "../src/feature.js";
import { messagesFor } from "../src/messages.js";
import { createMemoryRuntime, featureManifest } from "./fakes/memory-runtime.js";

const manifestWith = (program: Record<string, unknown>): FeatureManifest => {
	const result = validateFeature(featureManifest("demo", { programs: [program] }));
	if (!result.ok) throw new Error(result.error);
	return result.value;
};

describe("program installation errors follow the language", () => {
	test("a system package without an install command is reported from the catalog", async () => {
		for (const language of ["en", "ru"] as const) {
			const harness = createMemoryRuntime();
			harness.runtime.language = language;
			harness.unavailableCommands.add("tool");
			const feature = manifestWith({ name: "tool", command: "tool", installCommand: null, systemPackage: true });

			const result = await installMissingPrograms(harness.runtime, [feature], new Set(["demo"]));

			expect(result).toEqual({ ok: false, error: messagesFor(language).programs.noInstallCommand("tool") });
		}
	});

	test("a program that is still missing after installation is reported from the catalog", async () => {
		for (const language of ["en", "ru"] as const) {
			const harness = createMemoryRuntime();
			harness.runtime.language = language;
			harness.unavailableCommands.add("tool");
			const feature = manifestWith({ name: "tool", command: "tool", installCommand: "install tool", systemPackage: false });

			const result = await installMissingPrograms(harness.runtime, [feature], new Set(["demo"]));

			expect(result).toEqual({ ok: false, error: messagesFor(language).programs.stillUnavailable("tool") });
		}
	});

	test("the two texts differ between the languages", () => {
		expect(messagesFor("en").programs.noInstallCommand("tool")).not.toBe(messagesFor("ru").programs.noInstallCommand("tool"));
		expect(messagesFor("en").programs.stillUnavailable("tool")).not.toBe(messagesFor("ru").programs.stillUnavailable("tool"));
	});
});

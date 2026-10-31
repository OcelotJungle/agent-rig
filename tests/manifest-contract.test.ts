import { describe, expect, test } from "bun:test";

import { validateFeature } from "../src/feature.js";

const EXAMPLE_HOOK_TIMEOUT_SECONDS = 30;

describe("feature manifest contract", () => {
	test("accepts complete hook settings and settings entries from the example fixture", async () => {
		const text = await Bun.file(new URL("./fixtures/example-feature.json", import.meta.url)).text();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			expect(false).toBe(true);
			return;
		}

		const result = validateFeature(value);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.hooks[0]).toEqual({
			event: "Stop",
			matcher: "",
			command: "{{PYTHON}}",
			args: ["{{CLONE}}/hooks/example.py"],
			timeout: EXAMPLE_HOOK_TIMEOUT_SECONDS,
			statusMessage: "Checking reflection",
			async: false,
			asyncRewake: false,
			shell: "bash",
		});
	});
});

import type { ProcessOptions, ProcessOutput } from "../src/ports.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";

import { runService, serviceIsRunning, userBusEnvironment } from "../src/commands/real-runtime.js";
import { en } from "../src/messages.js";
import { ru } from "../src/messages-ru.js";
import { ok } from "../src/result.js";

const USER_ID = 1001;
const ACTIVE_EXIT_CODE = 0;
const BUS_FAILURE_EXIT_CODE = 1;
const INACTIVE_EXIT_CODE = 3;
const RUNTIME_DIRECTORY = "/run/user/1001";
const BUS_ADDRESS = "unix:path=/run/user/1001/bus";
const BUS_ERROR = "Failed to connect to user scope bus via local transport";

type Call = { command: string; args: readonly string[]; options: ProcessOptions | undefined };

const fakeRunner = (exitCode: number, stderr = ""): { calls: Call[]; run: (command: string, args: readonly string[], options?: ProcessOptions) => Promise<Result<ProcessOutput>> } => {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command, args, options) => {
			calls.push({ command, args, options });
			return ok({ stdout: "", stderr, exitCode });
		},
	};
};

describe("systemctl --user under cron", () => {
	test("sets the user bus variables that are missing", () => {
		expect(userBusEnvironment({ environment: {}, uid: USER_ID })).toEqual({
			XDG_RUNTIME_DIR: RUNTIME_DIRECTORY,
			DBUS_SESSION_BUS_ADDRESS: BUS_ADDRESS,
		});
	});

	test("keeps variables that are already set", () => {
		expect(userBusEnvironment({ environment: { XDG_RUNTIME_DIR: "/custom", DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" }, uid: USER_ID })).toEqual({});
		expect(userBusEnvironment({ environment: { XDG_RUNTIME_DIR: "/custom" }, uid: USER_ID })).toEqual({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" });
	});

	test("treats empty variables as missing and sets nothing without a user id", () => {
		expect(userBusEnvironment({ environment: { XDG_RUNTIME_DIR: "", DBUS_SESSION_BUS_ADDRESS: "" }, uid: USER_ID })).toEqual({
			XDG_RUNTIME_DIR: RUNTIME_DIRECTORY,
			DBUS_SESSION_BUS_ADDRESS: BUS_ADDRESS,
		});
		expect(userBusEnvironment({ environment: {}, uid: null })).toEqual({});
	});

	test("the service query and restart pass the bus variables to systemctl", async () => {
		const query = fakeRunner(ACTIVE_EXIT_CODE);
		const restart = fakeRunner(ACTIVE_EXIT_CODE);
		const source = { environment: {}, uid: USER_ID };

		await serviceIsRunning(query, "linux", source);
		await runService(restart, "linux", "restart", source);

		expect(query.calls[0]?.options?.environment?.XDG_RUNTIME_DIR).toBe(RUNTIME_DIRECTORY);
		expect(restart.calls[0]?.options?.environment?.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);
	});

	test("is-active exit 0 is running, exit 3 is stopped", async () => {
		const source = { environment: {}, uid: USER_ID };

		expect(await serviceIsRunning(fakeRunner(ACTIVE_EXIT_CODE), "linux", source)).toEqual(ok(true));
		expect(await serviceIsRunning(fakeRunner(INACTIVE_EXIT_CODE), "linux", source)).toEqual(ok(false));
	});

	test("a missing Scheduled Task is reported from the catalog in the current language", async () => {
		const source = { environment: {}, uid: USER_ID };
		const missing = fakeRunner(BUS_FAILURE_EXIT_CODE);

		const english = await serviceIsRunning(missing, "windows", source, en);
		const russian = await serviceIsRunning(missing, "windows", source, ru);

		expect(english).toEqual({ ok: false, error: en.runtime.scheduledTaskNotFound() });
		expect(russian).toEqual({ ok: false, error: ru.runtime.scheduledTaskNotFound() });
		expect(en.runtime.scheduledTaskNotFound()).not.toBe(ru.runtime.scheduledTaskNotFound());
	});

	test("a bus connection failure is an error with systemctl's message, not a stopped service", async () => {
		const result = await serviceIsRunning(fakeRunner(BUS_FAILURE_EXIT_CODE, BUS_ERROR), "linux", { environment: {}, uid: USER_ID });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(BUS_ERROR);
	});
});

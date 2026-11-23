import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { resolveLaunch } from "../src/commands/session-run.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";
import { ACCOUNT_ONE, answerOwnerQueries } from "./fakes/session-owner-fixture.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const CREATED = "2026-01-01";
const session: SessionRecord = { id: ID, cwd: "/work", transcriptPath: "/transcript", copyOf: null, startedAt: CREATED, processes: [] };
const raw = { session_id: ID, cwd: session.cwd, transcript_path: session.transcriptPath, pid: 42, pid_created: CREATED, started_at: CREATED, ended_at: CREATED, config_dir: "/cfg/1-test" };
const ACCOUNT_LOOKUP = '{"accounts":{"/cfg/1-test":{"present":true,"account":12}},"categories":{}}';

const windows = (pathEnvironment: string, files: string[]) => {
	const h = createMemoryRuntime("windows");
	h.fs.directories.add("/work");
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify(raw));
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.runtime.pathEnvironment = pathEnvironment;
	answerOwnerQueries(h, { 12: ACCOUNT_ONE });
	for (const file of files) h.fs.seed(file, "");
	return h;
};
// Every path whose existence the launch asked the file system about.
const statPaths = (h: ReturnType<typeof windows>): string[] => {
	const paths: string[] = [];
	const stat = h.runtime.fs.stat.bind(h.runtime.fs);
	h.runtime.fs.stat = async (path) => { paths.push(path); return await stat(path); };
	return paths;
};

describe("cswap lookup of a launch", () => {
	test("Windows launches the .cmd shim the lookup found, by its quoted full path", async () => {
		const h = windows("C:/Program Files/cswap bin", ["C:/Program Files/cswap bin/cswap.cmd"]);
		const result = await resolveLaunch(h.runtime, session, null, "12");
		expect(result.ok && result.value.command.at(-1)).toBe(`"C:/Program Files/cswap bin/cswap.cmd" run 12 --share-history -- --resume ${ID} & exit /b 0`);
	});
	test("one lookup serves the account decision and the launch", async () => {
		const h = windows("C:/bin", ["C:/bin/cswap.cmd"]);
		h.runtime.process.run = async () => ok({ stdout: ACCOUNT_LOOKUP, stderr: "", exitCode: 0 });
		answerOwnerQueries(h, { 12: ACCOUNT_ONE });
		const paths = statPaths(h);
		const result = await resolveLaunch(h.runtime, session, null, null);
		expect(result.ok && result.value.account).toBe("12");
		expect(paths.filter((path) => path.includes("cswap"))).toEqual(["C:/bin/cswap.exe", "C:/bin/cswap.com", "C:/bin/cswap.cmd"]);
	});
	test("a failed account lookup is ignored when the file lookup finds no cswap, whatever the command lookup says", async () => {
		const h = windows("C:/bin", []);
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		expect(await h.runtime.process.isAvailable("cswap")).toBe(true);
		const result = await resolveLaunch(h.runtime, session, null, null);
		expect(result.ok && result.value.account).toBe("");
		expect(result.ok && result.value.command.at(-1)).toBe(`claude --resume ${ID} & exit /b 0`);
	});
	test("a failed account lookup is reported when the file lookup finds cswap, whatever the command lookup says", async () => {
		const h = windows("C:/bin", ["C:/bin/cswap.cmd"]);
		h.unavailableCommands.add("cswap");
		h.runtime.process.run = async () => ok({ stdout: "", stderr: "broken", exitCode: 2 });
		const result = await resolveLaunch(h.runtime, session, null, null);
		expect(result.ok ? "ok" : result.error.code).toBe("launch-account-lookup");
	});
	test("a cswap path the launch line cannot carry is refused with launch-unavailable", async () => {
		for (const directory of ["C:/100%/bin", "C:/a&b", "C:/a!b", "C:/a^b"]) {
			const h = windows(directory, [`${directory}/cswap.exe`]);
			const result = await resolveLaunch(h.runtime, session, null, "12");
			expect(result.ok ? "ok" : result.error.code).toBe("launch-unavailable");
		}
	});
});

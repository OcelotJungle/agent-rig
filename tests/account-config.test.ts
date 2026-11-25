import type { SpawnLaunch } from "../src/commands/session-run.js";
import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { prepareFolderConsent } from "../src/commands/account-config.js";
import { resolveLaunch, runSession } from "../src/commands/session-run.js";
import { readRigState } from "../src/commands/shared.js";
import { apiFail } from "../src/output.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";
import { ACCOUNT_ONE, answerHelperQueries, DEFAULT_LOGIN, ownerLine, profileDirectory, profileFile, seedDefaultLogin, seedProfile, trustFolderInDefault, WORKSPACE_KEY } from "./fakes/session-owner-fixture.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const HOME = "/home/test";
const CREATED = "2026-01-01";
const ACCOUNT = 3;
const session: SessionRecord = { id: ID, cwd: "/work", transcriptPath: "/transcript", copyOf: null, startedAt: CREATED, processes: [] };
// The memory runtime's fixed clock; a lock directory modified at this time is held now.
const NOW_MS = Date.parse("2026-10-30T00:00:00.000Z");
// Longer than Claude Code's lock staleness (10 s).
const STALE_AGE_MS = 11_000;
const PROCESS_FAILURE = 128;
const LOCK = `${profileFile(ACCOUNT)}.lock`;

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.directories.add("/work");
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ session_id: ID, cwd: session.cwd, transcript_path: session.transcriptPath, pid: 42, pid_created: CREATED, started_at: CREATED, ended_at: CREATED, config_dir: "" }));
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.fs.seed("/transcript", `${ownerLine(DEFAULT_LOGIN, ID)}\n`);
	h.fs.seed("/usr/bin/tmux", "");
	h.fs.seed("/usr/bin/cswap", "");
	seedDefaultLogin(h);
	answerHelperQueries(h, { [ACCOUNT]: ACCOUNT_ONE });
	return h;
};
type Harness = ReturnType<typeof setup>;

const profileConfig = (h: Harness): Record<string, unknown> => JSON.parse(h.fs.files.get(profileFile(ACCOUNT)) ?? "null");
const events = (h: Harness): string => h.fs.files.get(`${ROOT}/events.jsonl`) ?? "";
const refusal = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;

// The top level git answers for every directory, or a failure (outside a repository).
const answerGit = (h: Harness, top: string | null): void => {
	const other = h.runtime.process.run.bind(h.runtime.process);
	h.runtime.process.run = async (command, args, options) => {
		if (command !== "git") return other(command, args, options);
		return ok(top === null ? { stdout: "", stderr: "not a repository", exitCode: PROCESS_FAILURE } : { stdout: `${top}\n`, stderr: "", exitCode: 0 });
	};
};
// The helper answers that the account has no profile of its own: it runs from the default config.
const answerDefaultTarget = (h: Harness): void => {
	const other = h.runtime.process.run.bind(h.runtime.process);
	h.runtime.process.run = async (command, args, options) => args.includes("config-dir")
		? ok({ stdout: JSON.stringify({ dir: HOME, file: `${HOME}/.claude.json`, isDefault: true, exists: true }), stderr: "", exitCode: 0 })
		: other(command, args, options);
};
const spawnCounter = (): { spawn: SpawnLaunch; count: () => number } => {
	let spawned = 0;
	return { spawn: async () => { spawned += 1; return apiFail("spawn-stub", "stop"); }, count: () => spawned };
};
const consent = async (h: Harness, cwd: string) => {
	const state = await readRigState(h.runtime);
	if (!state.ok) throw new Error(state.error);
	return await prepareFolderConsent(h.runtime, state.value, ACCOUNT, cwd);
};

describe("folder consent carried into an account's profile", () => {
	test("a profile without the folder gets the consent of the default config, and nothing else of it changes", async () => {
		const h = setup();
		trustFolderInDefault(h, WORKSPACE_KEY, { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, enabledMcpjsonServers: ["docs"], lastCost: 9, allowedTools: ["Bash"] });
		seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, theme: "dark", projects: { "/other": { hasTrustDialogAccepted: false, history: ["x"] } } });
		const result = await resolveLaunch(h.runtime, session, null, String(ACCOUNT));
		expect(refusal(result)).toBe("ok");
		expect(profileConfig(h)).toEqual({
			hasCompletedOnboarding: true,
			theme: "dark",
			projects: {
				"/other": { hasTrustDialogAccepted: false, history: ["x"] },
				[WORKSPACE_KEY]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, enabledMcpjsonServers: ["docs"] },
			},
		});
		expect(h.fs.directories.has(LOCK)).toBe(false);
	});

	test("fields the profile entry already has stay, the consent fields come from the default", async () => {
		const h = setup();
		trustFolderInDefault(h, WORKSPACE_KEY, { hasTrustDialogAccepted: true });
		seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, projects: { [WORKSPACE_KEY]: { hasTrustDialogAccepted: false, lastCost: 2 } } });
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(profileConfig(h).projects).toEqual({ [WORKSPACE_KEY]: { hasTrustDialogAccepted: true, lastCost: 2 } });
	});

	test("trust of an ancestor in the default config is written under the git root of the folder", async () => {
		const h = setup();
		answerGit(h, "/team/app");
		trustFolderInDefault(h, "/team", { hasTrustDialogAccepted: true });
		seedProfile(h, ACCOUNT);
		expect((await consent(h, "/team/app/pkg")).ok).toBe(true);
		expect(profileConfig(h).projects).toEqual({ "/team/app": { hasTrustDialogAccepted: true } });
	});

	test("a Windows folder with backslashes is keyed with forward slashes, and the default's case does not matter there", async () => {
		const h = createMemoryRuntime("windows");
		h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
		answerHelperQueries(h, { [ACCOUNT]: ACCOUNT_ONE });
		const other = h.runtime.process.run.bind(h.runtime.process);
		h.runtime.process.run = async (command, args, options) => command === "git" ? ok({ stdout: "", stderr: "fatal", exitCode: PROCESS_FAILURE }) : other(command, args, options);
		trustFolderInDefault(h, "c:/work/app", { hasTrustDialogAccepted: true });
		seedProfile(h, ACCOUNT);
		const state = await readRigState(h.runtime);
		if (!state.ok) throw new Error(state.error);
		expect((await prepareFolderConsent(h.runtime, state.value, ACCOUNT, "C:\\work\\app")).ok).toBe(true);
		expect(profileConfig(h).projects).toEqual({ "C:/work/app": { hasTrustDialogAccepted: true } });
	});

	test("a folder trusted only in the slot profile goes ahead without a write, though the default does not trust it", async () => {
		const h = setup();
		seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, projects: { [WORKSPACE_KEY]: { hasTrustDialogAccepted: true } } });
		const before = h.fs.files.get(profileFile(ACCOUNT));
		const defaultBefore = h.fs.files.get(`${HOME}/.claude.json`);
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(h.fs.files.get(profileFile(ACCOUNT))).toBe(before);
		expect(h.fs.files.get(`${HOME}/.claude.json`)).toBe(defaultBefore);
	});

	test("a folder trusted in the slot profile through an ancestor needs no write either", async () => {
		const h = setup();
		seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, projects: { "/": { hasTrustDialogAccepted: true } } });
		const before = h.fs.files.get(profileFile(ACCOUNT));
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(h.fs.files.get(profileFile(ACCOUNT))).toBe(before);
	});

	test("a profile that trusts the folder keeps its own consent and gets only the consent fields it lacks from the default", async () => {
		const h = setup();
		trustFolderInDefault(h, WORKSPACE_KEY, { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["docs"], disabledMcpjsonServers: ["x"] });
		seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, projects: { [WORKSPACE_KEY]: { hasTrustDialogAccepted: true, disabledMcpjsonServers: [] } } });
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(profileConfig(h).projects).toEqual({ [WORKSPACE_KEY]: { hasTrustDialogAccepted: true, disabledMcpjsonServers: [], enabledMcpjsonServers: ["docs"] } });
	});

	test("a slot profile that trusts nothing and a default that trusts nothing refuse as workspace-untrusted", async () => {
		const h = setup();
		seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, projects: { "/work": { hasTrustDialogAccepted: false } } });
		const result = await consent(h, "/work");
		expect(!result.ok && result.reason).toBe("workspace-untrusted");
	});

	test("trust that comes from an ancestor of the default carries only the trust flag, never the ancestor's other consent", async () => {
		const h = setup();
		answerGit(h, "/team/app");
		trustFolderInDefault(h, "/team", { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["docs"], disabledMcpjsonServers: ["x"], hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true });
		seedProfile(h, ACCOUNT);
		expect((await consent(h, "/team/app")).ok).toBe(true);
		expect(profileConfig(h).projects).toEqual({ "/team/app": { hasTrustDialogAccepted: true } });
	});

	test("a folder the default config does not trust refuses the launch before any spawn, and the profile stays as it was", async () => {
		const h = setup();
		trustFolderInDefault(h, "/elsewhere", { hasTrustDialogAccepted: true });
		trustFolderInDefault(h, "/another", { hasTrustDialogAccepted: false });
		seedProfile(h, ACCOUNT);
		const before = h.fs.files.get(profileFile(ACCOUNT));
		const counter = spawnCounter();
		const result = await runSession(h.runtime, session, null, String(ACCOUNT), counter.spawn);
		expect(refusal(result)).toBe("workspace-untrusted");
		expect(!result.ok && result.error.message).toContain(WORKSPACE_KEY);
		expect(counter.count()).toBe(0);
		expect(h.fs.files.get(profileFile(ACCOUNT))).toBe(before);
		expect(events(h)).toContain("account-consent-refused");
		expect(events(h)).toContain('"level":"warn"');
	});

	test("a target that is the default config and does not trust the folder is refused, and nothing is written", async () => {
		const h = setup();
		answerDefaultTarget(h);
		const before = h.fs.files.get(`${HOME}/.claude.json`);
		const counter = spawnCounter();
		const result = await runSession(h.runtime, session, null, String(ACCOUNT), counter.spawn);
		expect(refusal(result)).toBe("workspace-untrusted");
		expect(counter.count()).toBe(0);
		expect(h.fs.files.get(`${HOME}/.claude.json`)).toBe(before);
		expect(h.fs.files.has(profileFile(ACCOUNT))).toBe(false);
	});

	test("a target that is the default config and trusts the folder goes ahead without a write", async () => {
		const h = setup();
		answerDefaultTarget(h);
		trustFolderInDefault(h);
		const before = h.fs.files.get(`${HOME}/.claude.json`);
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(h.fs.files.get(`${HOME}/.claude.json`)).toBe(before);
		expect(h.fs.files.has(profileFile(ACCOUNT))).toBe(false);
		expect(h.fs.directories.has(`${HOME}/.claude.json.lock`)).toBe(false);
	});

	test("a profile that does not exist is refused and never created", async () => {
		const h = setup();
		trustFolderInDefault(h);
		const counter = spawnCounter();
		const result = await runSession(h.runtime, session, null, String(ACCOUNT), counter.spawn);
		expect(refusal(result)).toBe("account-profile-missing");
		expect(counter.count()).toBe(0);
		expect(h.fs.files.has(profileFile(ACCOUNT))).toBe(false);
		expect(h.fs.directories.has(profileDirectory(ACCOUNT))).toBe(false);
	});

	test("a profile whose onboarding is not complete is refused and left as it was", async () => {
		const h = setup();
		trustFolderInDefault(h);
		for (const config of [{ hasCompletedOnboarding: false }, { theme: "dark" }]) {
			seedProfile(h, ACCOUNT, config);
			const before = h.fs.files.get(profileFile(ACCOUNT));
			const counter = spawnCounter();
			const result = await runSession(h.runtime, session, null, String(ACCOUNT), counter.spawn);
			expect(refusal(result)).toBe("account-profile-incomplete");
			expect(counter.count()).toBe(0);
			expect(h.fs.files.get(profileFile(ACCOUNT))).toBe(before);
			expect(h.fs.directories.has(LOCK)).toBe(false);
		}
	});

	test("a lock held now is waited for through the clock, then the launch is refused and the holder's lock stays", async () => {
		const h = setup();
		trustFolderInDefault(h);
		seedProfile(h, ACCOUNT);
		h.fs.directories.add(LOCK);
		h.fs.mtimes.set(LOCK, NOW_MS);
		const before = h.fs.files.get(profileFile(ACCOUNT));
		const counter = spawnCounter();
		const result = await runSession(h.runtime, session, null, String(ACCOUNT), counter.spawn);
		expect(refusal(result)).toBe("account-config-busy");
		expect(counter.count()).toBe(0);
		expect(h.sleeps.length).toBeGreaterThan(0);
		expect(h.fs.files.get(profileFile(ACCOUNT))).toBe(before);
		expect(h.fs.directories.has(LOCK)).toBe(true);
	});

	test("a lock older than Claude Code's stale limit is a dead holder's: it is taken over and released", async () => {
		const h = setup();
		trustFolderInDefault(h);
		seedProfile(h, ACCOUNT);
		h.fs.directories.add(LOCK);
		h.fs.mtimes.set(LOCK, NOW_MS - STALE_AGE_MS);
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(profileConfig(h).projects).toEqual({ [WORKSPACE_KEY]: { hasTrustDialogAccepted: true } });
		expect(h.fs.directories.has(LOCK)).toBe(false);
	});

	test("the profile is read under the lock, so a write by Claude Code before the lock is not lost", async () => {
		const h = setup();
		trustFolderInDefault(h);
		seedProfile(h, ACCOUNT);
		const exclusive = h.fs.makeDirectoryExclusive.bind(h.fs);
		h.fs.makeDirectoryExclusive = async (path) => {
			const made = await exclusive(path);
			if (path === LOCK) seedProfile(h, ACCOUNT, { hasCompletedOnboarding: true, written: "meanwhile" });
			return made;
		};
		expect((await consent(h, "/work")).ok).toBe(true);
		expect(profileConfig(h)).toMatchObject({ written: "meanwhile", projects: { [WORKSPACE_KEY]: { hasTrustDialogAccepted: true } } });
	});

	test("a profile that is not valid JSON or is a symlink is refused and not touched", async () => {
		const broken = setup();
		trustFolderInDefault(broken);
		broken.fs.seed(profileFile(ACCOUNT), "{ not json");
		expect(refusal(await runSession(broken.runtime, session, null, String(ACCOUNT), spawnCounter().spawn))).toBe("account-profile-unreadable");
		expect(broken.fs.files.get(profileFile(ACCOUNT))).toBe("{ not json");
		expect(broken.fs.directories.has(LOCK)).toBe(false);

		const linked = setup();
		trustFolderInDefault(linked);
		seedProfile(linked, ACCOUNT);
		linked.fs.seed("/elsewhere/.claude.json", "{}");
		linked.fs.links.set(profileFile(ACCOUNT), "/elsewhere/.claude.json");
		expect(refusal(await runSession(linked.runtime, session, null, String(ACCOUNT), spawnCounter().spawn))).toBe("account-profile-unreadable");
		expect(linked.fs.files.get("/elsewhere/.claude.json")).toBe("{}");
	});

	test("a launch with no account does not look at any profile", async () => {
		const h = setup();
		const queries: string[][] = [];
		const other = h.runtime.process.run.bind(h.runtime.process);
		h.runtime.process.run = async (command, args, options) => { queries.push([...args]); return other(command, args, options); };
		const result = await resolveLaunch(h.runtime, session, null, "");
		expect(result.ok).toBe(true);
		expect(queries.some((args) => args.includes("config-dir"))).toBe(false);
		expect(h.fs.files.has(profileFile(ACCOUNT))).toBe(false);
	});
});

import type { Messages } from "../messages.js";
import type { RuntimePorts } from "../ports.js";
import type { RigState } from "../state.js";

import { configDirOf } from "./info.js";
import { atomicWrite, joinPath, toSlashPath } from "../file-system.js";
import { messagesFor } from "../messages.js";
import { ACCOUNT_CONFIG_BUSY, ACCOUNT_PROFILE_INCOMPLETE, ACCOUNT_PROFILE_MISSING, ACCOUNT_PROFILE_UNREADABLE, WORKSPACE_UNTRUSTED } from "../output.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { errorText } from "../result.js";

// Per-folder consent of Claude Code lives in `projects[<folder>]` of a profile's `.claude.json`. A launch under a cswap
// account that has its own profile starts without it, and the window stops on the trust question. This module is the
// only code that touches a profile's `.claude.json`: it carries the consent the default config already gives the
// folder into the account's profile before the launch, or reports why it cannot.

// The fields of a project entry that are the user's consent for the folder; nothing else of the entry is copied.
const CONSENT_FIELDS = ["hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown", "enabledMcpjsonServers", "disabledMcpjsonServers"] as const;
const DEFAULT_CONFIG_NAME = ".claude.json";
// Claude Code locks `<file>.lock` with proper-lockfile: a mkdir mutex whose directory is stale after 10 s (its default).
const LOCK_SUFFIX = ".lock";
const LOCK_STALE_MS = 10_000;
// A held lock is waited for this many tries with this pause (ms) between them, 5 s in all; then the launch is refused.
const LOCK_TRIES = 50;
const LOCK_RETRY_MS = 100;
const GIT_TIMEOUT_MS = 5_000;
// Claude Code writes `.claude.json` with this indent.
const JSON_INDENT = 2;

export const UNREADABLE_INVALID_JSON = "invalid-json";
export const UNREADABLE_SYMLINK = "symlink";

export type ConsentReason =
	| "account-lookup"
	| typeof WORKSPACE_UNTRUSTED
	| typeof ACCOUNT_PROFILE_MISSING
	| typeof ACCOUNT_PROFILE_INCOMPLETE
	| typeof ACCOUNT_PROFILE_UNREADABLE
	| typeof ACCOUNT_CONFIG_BUSY;

// `detail` is the folder for `workspace-untrusted`, a short cause for `account-profile-unreadable`, the helper's text for `account-lookup`.
export type ConsentOutcome = { ok: true } | { ok: false; reason: ConsentReason; detail: string };

const refuse = (reason: ConsentReason, detail = ""): ConsentOutcome => ({ ok: false, reason, detail });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
	try { return JSON.parse(text); } catch { return undefined; }
};

const withoutTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

// The folder as Claude Code keys it: the git root of the directory (the directory itself outside git), forward slashes, case kept.
const folderKey = async (runtime: RuntimePorts, cwd: string): Promise<string> => {
	const root = await runtime.process.run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
	const top = root.ok && root.value.exitCode === PROCESS_SUCCESS_EXIT_CODE ? root.value.stdout.trim() : "";
	return withoutTrailingSlash(toSlashPath(top === "" ? cwd : top));
};

// The folder and each of its ancestors, nearest first.
const withAncestors = (key: string): string[] => {
	const chain = [key];
	let current = key;
	for (let cut = current.lastIndexOf("/"); cut >= 0; cut = current.lastIndexOf("/")) {
		current = cut === 0 ? "/" : current.slice(0, cut);
		chain.push(current);
		if (cut === 0) break;
	}
	return chain;
};

// The nearest folder on the chain that carries the user's trust (`exact` when it is the folder itself); null when none does.
const trustedEntry = (runtime: RuntimePorts, config: Record<string, unknown>, key: string): { entry: Record<string, unknown>; exact: boolean } | null => {
	if (!isRecord(config.projects)) return null;
	const same = (left: string, right: string): boolean => (runtime.platform === "windows" ? left.toLowerCase() === right.toLowerCase() : left === right);
	const entries = Object.entries(config.projects);
	for (const candidate of withAncestors(key)) {
		for (const [name, entry] of entries) {
			if (isRecord(entry) && entry.hasTrustDialogAccepted === true && same(withoutTrailingSlash(toSlashPath(name)), candidate)) return { entry, exact: same(candidate, key) };
		}
	}
	return null;
};

// Consent belongs to the folder it was given for: the folder's own entry carries its whole consent set, an ancestor's
// entry gives only the trust itself, never that ancestor's MCP or CLAUDE.md approvals.
const consentOf = (trusted: { entry: Record<string, unknown>; exact: boolean }): Record<string, unknown> =>
	trusted.exact
		? Object.fromEntries(CONSENT_FIELDS.filter((field) => field in trusted.entry).map((field) => [field, trusted.entry[field]]))
		: { hasTrustDialogAccepted: true };

// Whether the file itself is a symlink: its real path differs from its own name inside its real directory (a symlinked directory on the way does not count).
const isSymlinkFile = async (runtime: RuntimePorts, file: string): Promise<boolean> => {
	const slash = file.lastIndexOf("/");
	const real = toSlashPath(await runtime.fs.resolveTarget(file));
	const own = joinPath(toSlashPath(await runtime.fs.resolveTarget(file.slice(0, slash))), file.slice(slash + 1));
	return runtime.platform === "windows" ? real.toLowerCase() !== own.toLowerCase() : real !== own;
};

// Takes Claude Code's own lock of the file (mkdir mutex); a lock older than its stale limit is a dead holder's and is taken over.
const takeLock = async (runtime: RuntimePorts, lock: string): Promise<boolean> => {
	for (let attempt = 1; attempt <= LOCK_TRIES; attempt += 1) {
		const made = await runtime.fs.makeDirectoryExclusive(lock);
		if (made.ok && made.value) return true;
		const modified = await runtime.fs.modifiedAt(lock);
		if (modified !== null && runtime.clock.now().getTime() - modified > LOCK_STALE_MS) {
			await runtime.fs.removeDirectoryTree(lock);
			continue;
		}
		await runtime.clock.sleep(LOCK_RETRY_MS);
	}
	return false;
};

// Merges the consent into `projects[key]` of the file as it is under the lock; every other field and project stays as read.
// A profile that already trusts the folder (itself or an ancestor) is left untouched; otherwise the consent carried
// from the default config is merged, and without one the launch is refused.
const mergeConsent = async (runtime: RuntimePorts, messages: Messages, file: string, key: string, carried: Record<string, unknown> | null): Promise<ConsentOutcome> => {
	let text: string;
	try { text = await runtime.fs.readText(file); } catch (error) { return refuse(ACCOUNT_PROFILE_UNREADABLE, errorText(error)); }
	const config = parseJson(text);
	if (!isRecord(config)) return refuse(ACCOUNT_PROFILE_UNREADABLE, UNREADABLE_INVALID_JSON);
	if (config.hasCompletedOnboarding !== true) return refuse(ACCOUNT_PROFILE_INCOMPLETE);
	const own = trustedEntry(runtime, config, key);
	if (own === null && carried === null) return refuse(WORKSPACE_UNTRUSTED, key);
	const projects = isRecord(config.projects) ? config.projects : {};
	const existing = projects[key];
	const current = isRecord(existing) ? existing : {};
	// A profile that trusts the folder keeps its own consent; only the consent fields it lacks come from the default
	// (an MCP approval missing there would stop the window on its own screen).
	const added = own === null ? carried ?? {} : Object.fromEntries(Object.entries(carried ?? {}).filter(([field]) => !(field in current)));
	if (Object.keys(added).length === 0) return { ok: true };
	const entry = { ...current, ...added };
	if (JSON.stringify(current) === JSON.stringify(entry)) return { ok: true };
	const written = await atomicWrite(runtime.fs, file, JSON.stringify({ ...config, projects: { ...projects, [key]: entry } }, null, JSON_INDENT), messages);
	return written.ok ? { ok: true } : refuse(ACCOUNT_PROFILE_UNREADABLE, written.error);
};

// Makes the folder trusted in the profile a launch under `account` will use. A profile that trusts it already needs no
// write; otherwise the default config's consent is carried in. Neither the profile nor the default config trusting the
// folder (nor an ancestor of it) refuses the launch, as does a profile that is missing, not set up, unreadable or locked
// past a bounded wait: nothing is created and no other part of the profile changes.
export const prepareFolderConsent = async (runtime: RuntimePorts, state: RigState, account: number, cwd: string): Promise<ConsentOutcome> => {
	const messages = messagesFor(runtime.language);
	const target = await configDirOf(runtime, state, account);
	if (!target.ok) return refuse("account-lookup", target.error);
	const key = await folderKey(runtime, cwd);
	const defaultFile = target.value.isDefault ? target.value.file : joinPath(runtime.home, DEFAULT_CONFIG_NAME);
	let defaultConfig: unknown;
	try { defaultConfig = parseJson(await runtime.fs.readText(defaultFile)); } catch { defaultConfig = undefined; }
	const trusted = isRecord(defaultConfig) ? trustedEntry(runtime, defaultConfig, key) : null;
	// The default config is the account's own profile: the consent is there or nowhere.
	if (target.value.isDefault) return trusted === null ? refuse(WORKSPACE_UNTRUSTED, key) : { ok: true };
	if (!target.value.exists) return refuse(ACCOUNT_PROFILE_MISSING);
	const file = toSlashPath(target.value.file);
	if (await isSymlinkFile(runtime, file)) return refuse(ACCOUNT_PROFILE_UNREADABLE, UNREADABLE_SYMLINK);
	const lock = `${file}${LOCK_SUFFIX}`;
	if (!await takeLock(runtime, lock)) return refuse(ACCOUNT_CONFIG_BUSY);
	try {
		return await mergeConsent(runtime, messages, file, key, trusted === null ? null : consentOf(trusted));
	} finally {
		await runtime.fs.removeDirectoryTree(lock).catch(() => undefined);
	}
};

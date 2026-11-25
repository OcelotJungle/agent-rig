import type { ProcessEntry, RuntimePorts } from "./ports.js";

// Finds and closes the terminal window a session launch opened but whose Claude process never registered (the window stopped on a
// screen that wants a person: a trust question, a login). The launcher's own process does not hold the window: `start` and
// `wt.exe` hand the tab to the shared terminal process and exit. So the window's processes are told by what they are:
// their command line carries the launch's `--resume <session>`, they were created after the launch began, and the session
// record did not name them before. The terminal's own processes (WindowsTerminal.exe, wt.exe, OpenConsole.exe) hold every
// window of the user and are never part of the answer, never killed, and never inside a killed tree.

// Names (lower case) of the terminal's own processes, which serve every window of the user.
const TERMINAL_PROCESS_NAMES: readonly string[] = ["windowsterminal.exe", "wt.exe", "openconsole.exe"];
// A screen with a question or a login is a few lines, and the excerpt goes into a chat message: the last lines and characters
// are what the window was waiting on. 12 rows fit a Claude Code trust or login screen; 800 characters keep the message far under
// Telegram's 4096-character limit with the rest of the text around it.
const EXCERPT_MAX_LINES = 12;
const EXCERPT_MAX_CHARACTERS = 800;
const MAX_ANCESTOR_STEPS = 64;

export type LaunchedWindow = {
	sessionId: string;
	// Keys (pid and creation time) of the processes the session record named before the launch.
	earlier: ReadonlySet<string>;
	// When the launch began, before its command was spawned.
	spawnedAt: Date;
};

export type ClosedWindow = {
	// Pids whose trees were killed (the roots of the window's processes).
	killed: number[];
	// The tail of the window's screen, or "" when the screen could not be read or was empty.
	excerpt: string;
};

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isTerminalProcess = (entry: ProcessEntry): boolean => TERMINAL_PROCESS_NAMES.includes(entry.name.toLowerCase());
const entryKey = (entry: ProcessEntry): string => `${entry.pid}:${entry.createdAt ?? ""}`;

// The processes of the launched window: the launch's own command lines, started after the launch began, not known before.
export const windowProcesses = (table: readonly ProcessEntry[], launched: LaunchedWindow): ProcessEntry[] => {
	const resume = new RegExp(`--resume\\s+"?${escapeForPattern(launched.sessionId)}(?![0-9A-Za-z_-])`);
	const since = launched.spawnedAt.getTime();
	return table.filter((entry) => {
		if (isTerminalProcess(entry) || launched.earlier.has(entryKey(entry)) || !resume.test(entry.commandLine)) return false;
		if (entry.createdAt === null) return false;
		const created = Date.parse(entry.createdAt);
		return !Number.isNaN(created) && created >= since;
	});
};

const parentOf = (entry: ProcessEntry, byPid: ReadonlyMap<number, ProcessEntry>): ProcessEntry | undefined => {
	const parent = byPid.get(entry.parent);
	// A parent pid can be reused by an unrelated process created later than its child: that is not the child's parent.
	return parent !== undefined && parent.pid !== entry.pid && (parent.createdAt === null || entry.createdAt === null || parent.createdAt <= entry.createdAt) ? parent : undefined;
};

const depthIn = (entry: ProcessEntry, members: ReadonlyMap<number, ProcessEntry>): number => {
	let depth = 0;
	let at = entry;
	for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
		const parent = parentOf(at, members);
		if (parent === undefined) break;
		depth += 1;
		at = parent;
	}
	return depth;
};

// True when `entry` has a terminal process among its descendants in the whole table: killing its tree would close more than one window.
const holdsTerminalProcess = (entry: ProcessEntry, table: readonly ProcessEntry[], byPid: ReadonlyMap<number, ProcessEntry>): boolean => table.some((candidate) => {
	if (!isTerminalProcess(candidate)) return false;
	let at: ProcessEntry | undefined = candidate;
	for (let step = 0; at !== undefined && step < MAX_ANCESTOR_STEPS; step += 1) {
		at = parentOf(at, byPid);
		if (at?.pid === entry.pid) return true;
	}
	return false;
});

export type WindowTrees = {
	// Members whose parent is not a member: each one's tree is the window.
	roots: ProcessEntry[];
	// The member furthest from its root (the newest on a tie): the process that holds the window's console.
	deepest: ProcessEntry | null;
};

export const windowTrees = (table: readonly ProcessEntry[], members: readonly ProcessEntry[]): WindowTrees => {
	const byPid = new Map(table.map((entry) => [entry.pid, entry]));
	const memberByPid = new Map(members.map((entry) => [entry.pid, entry]));
	const roots = members.filter((entry) => parentOf(entry, memberByPid) === undefined && !holdsTerminalProcess(entry, table, byPid));
	const rootPids = new Set(roots.map((root) => root.pid));
	const inRoots = members.filter((entry) => {
		let at: ProcessEntry | undefined = entry;
		for (let step = 0; at !== undefined && step < MAX_ANCESTOR_STEPS; step += 1) {
			if (rootPids.has(at.pid)) return true;
			at = parentOf(at, memberByPid);
		}
		return false;
	});
	const deepest = inRoots.reduce<{ entry: ProcessEntry; depth: number } | null>((best, entry) => {
		const depth = depthIn(entry, memberByPid);
		const newer = best !== null && depth === best.depth && (entry.createdAt ?? "") > (best.entry.createdAt ?? "");
		return best === null || depth > best.depth || newer ? { entry, depth } : best;
	}, null);
	return { roots, deepest: deepest === null ? null : deepest.entry };
};

// The tail of a screen's text: the last non-empty lines, bounded in lines and in characters.
export const screenExcerpt = (text: string): string => {
	const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
	const tail = lines.slice(-EXCERPT_MAX_LINES).join("\n");
	return tail.length > EXCERPT_MAX_CHARACTERS ? tail.slice(-EXCERPT_MAX_CHARACTERS).trimStart() : tail;
};

/**
 * Closes the window a launch opened: reads its screen (best effort, before anything dies), then kills the tree of each root of
 * the window's processes by pid. Never throws and never fails: a process table that cannot be read, a screen that cannot be read
 * and a kill that could not be done each leave less in the answer, not an error. `killed` lists only the pids whose kill was done.
 */
export const closeLaunchedWindow = async (runtime: RuntimePorts, launched: LaunchedWindow): Promise<ClosedWindow> => {
	const table = await runtime.process.listProcesses();
	if (!table.ok) return { killed: [], excerpt: "" };
	const { roots, deepest } = windowTrees(table.value, windowProcesses(table.value, launched));
	if (roots.length === 0 || deepest === null) return { killed: [], excerpt: "" };
	const screen = await runtime.process.readConsoleText(deepest.pid);
	const excerpt = screen.ok ? screenExcerpt(screen.value) : "";
	const killed: number[] = [];
	for (const root of roots) {
		const done = await runtime.process.killTree(root.pid, true);
		if (done.ok) killed.push(root.pid);
	}
	return { killed, excerpt };
};

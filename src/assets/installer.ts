import type { FileContent } from "../content-hash.js";
import type { Result } from "../result.js";

import { chooseBackupPath } from "../backup-path.js";
import { hashContent } from "../content-hash.js";
import { toSlashPath } from "../file-system.js";
import { resolvePlaceholders } from "../placeholders.js";

const EMPTY_LENGTH = 0;
const PATH_SEPARATOR_LENGTH = 1;
const MARKETPLACE_MARKER_LENGTH = 1;
const ROOT_SEPARATOR_INDEX = 0;
const SUCCESS_EXIT_CODE = 0;
const ISO_DATE_LENGTH = 10;
const NUL_BYTE = 0;
const CRLF = "\r\n";
const LF = "\n";
const CLAUDE_PLUGIN_PREFIX = ["plugin"] as const;
const USER_SCOPE = ["--scope", "user"] as const;
const YES_OPTION = ["--yes"] as const;

export type AssetFile = {
  sourcePath: string;
  targetPath: string;
};

export type AssetPlan = {
  enabled: boolean;
  clonePath: string;
  pythonPath: string;
  homePath: string;
  hubPath: string;
  files: readonly AssetFile[];
};

export type AssetRecord = {
  hash: string;
  owned: boolean;
  notifiedHashes: readonly string[];
};

export type AssetRecords = Readonly<Record<string, AssetRecord>>;

export type AssetEvent = {
  type: "setting-kept";
  path: string;
};

export type FileSystem = {
  readFile(path: string): Promise<Result<FileContent>>;
  listFiles(path: string): Promise<Result<readonly string[]>>;
  writeFileAtomic(path: string, content: FileContent): Promise<Result<void>>;
  removeFile(path: string): Promise<Result<void>>;
  makeDirectory(path: string): Promise<Result<void>>;
  // The real location of an existing path with every symlink resolved; "not-found" when the path does not exist.
  realPath(path: string): Promise<Result<string>>;
};

export type AssetEnvironment = {
  fs: FileSystem;
  now(): string;
  // When set, no file may be written or removed outside this folder, symlinks included.
  boundaryPath?: string;
};

export type AssetOutcome = {
  records: Record<string, AssetRecord>;
  events: AssetEvent[];
};

export type AssetWrite = {
  path: string;
  content: FileContent;
};

export type AssetOperations = {
  backups: AssetWrite[];
  writes: AssetWrite[];
  removals: string[];
};

export type AssetPlanOutcome = AssetOutcome & {
  operations: AssetOperations;
};

export type PluginPlan = {
  enabled: boolean;
  id: string;
  marketplace: string;
  source: string;
};

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ProcessRunner = {
  run(command: string, args: readonly string[]): Promise<Result<ProcessResult>>;
};

export type PluginEnvironment = {
  runner: ProcessRunner;
  claudeCommand: string;
};

export type PluginRecord = {
  enabled: boolean;
  marketplace: string;
  source: string;
};

export type PluginRecords = Readonly<Record<string, PluginRecord>>;

export type PluginOutcome = {
  installed: string[];
  uninstalled: string[];
  records: Record<string, PluginRecord>;
};

export async function applyAssets(
  environment: AssetEnvironment,
  plans: readonly AssetPlan[],
  priorRecords: AssetRecords,
): Promise<Result<AssetOutcome>> {
  const planned = await planAssets(environment, plans, priorRecords);
  if (!planned.ok) return planned;
  const executed = await executeAssetOperations(environment, planned.value.operations);
  if (!executed.ok) return executed;
  return { ok: true, value: { records: planned.value.records, events: planned.value.events } };
}

// Reads the disk and decides everything, writes nothing.
export async function planAssets(
  environment: AssetEnvironment,
  plans: readonly AssetPlan[],
  priorRecords: AssetRecords,
): Promise<Result<AssetPlanOutcome>> {
  const nextRecords = withSlashKeys(priorRecords);
  const events: AssetEvent[] = [];
  const operations: AssetOperations = { backups: [], writes: [], removals: [] };
  const activeTargets = new Set<string>();
  const enabledTargets = new Set<string>();

  for (const plan of plans) {
    for (const file of plan.files) {
      const fileTarget = toSlashPath(file.targetPath);
      if (!plan.enabled) {
        if (activeTargets.has(fileTarget)) {
          return { ok: false, error: `Duplicate asset target: ${fileTarget}` };
        }
        activeTargets.add(fileTarget);
        const removal = await disableAssetTree(environment, fileTarget, nextRecords, events, operations);
        if (!removal.ok) return removal;
        continue;
      }

      const sourceFiles = await loadSourceFiles(environment.fs, file.sourcePath);
      if (!sourceFiles.ok) return sourceFiles;
      for (const sourceFile of sourceFiles.value) {
        const targetPath = appendRelativePath(fileTarget, sourceFile.relativePath);
        if (activeTargets.has(targetPath)) {
          return { ok: false, error: `Duplicate asset target: ${targetPath}` };
        }
        activeTargets.add(targetPath);
        enabledTargets.add(targetPath);
        const content = substitutePlaceholders(sourceFile.content, {
          CLONE: toSlashPath(plan.clonePath),
          HUB: toSlashPath(plan.hubPath),
          HOME: toSlashPath(plan.homePath),
          PYTHON: toSlashPath(plan.pythonPath),
        }, sourceFile.relativePath || file.sourcePath);
        if (!content.ok) return content;
        const sync = await enableAsset(environment, targetPath, content.value, nextRecords, events, operations);
        if (!sync.ok) return sync;
      }
    }
  }

  // A record that no plan mentions any more (the file left the manifest) is handled like a disabled feature.
  for (const path of Object.keys(nextRecords)) {
    if (enabledTargets.has(path)) continue;
    const removal = await disableAsset(environment, path, nextRecords, events, operations);
    if (!removal.ok) return removal;
  }

  const boundary = await checkBoundary(environment, [
    ...operations.backups.map((write) => write.path),
    ...operations.writes.map((write) => write.path),
    ...operations.removals,
  ]);
  if (!boundary.ok) return boundary;
  return { ok: true, value: { records: nextRecords, events, operations } };
}

export async function executeAssetOperations(
  environment: AssetEnvironment,
  operations: AssetOperations,
): Promise<Result<void>> {
  for (const write of [...operations.backups, ...operations.writes]) {
    const written = await writeTarget(environment.fs, write.path, write.content);
    if (!written.ok) return written;
  }
  for (const path of operations.removals) {
    const removed = await environment.fs.removeFile(path);
    if (!removed.ok) return removed;
  }
  return { ok: true, value: undefined };
}

export async function applyPlugins(
  environment: PluginEnvironment,
  plans: readonly PluginPlan[],
  priorRecords: PluginRecords = {},
): Promise<Result<PluginOutcome>> {
  const seenIds = new Set<string>();
  for (const plan of plans) {
    if (seenIds.has(plan.id)) return { ok: false, error: `Duplicate plugin id: ${plan.id}` };
    seenIds.add(plan.id);
  }
  // A plugin with a record but no plan left the manifest: it is removed like a disabled one.
  const orphanPlans: PluginPlan[] = Object.entries(priorRecords)
    .filter(([id]) => !seenIds.has(id))
    .map(([id, record]) => ({ enabled: false, id, marketplace: record.marketplace, source: record.source }));
  const allPlans = [...plans, ...orphanPlans];
  if (allPlans.length === EMPTY_LENGTH) {
    return { ok: true, value: { installed: [], uninstalled: [], records: { ...priorRecords } } };
  }

  // Every apply reads what is installed, so a plugin removed by hand comes back.
  const marketplaces = allPlans.some((plan) => plan.enabled)
    ? await runClaude(environment, [...CLAUDE_PLUGIN_PREFIX, "marketplace", "list"])
    : null;
  if (marketplaces !== null && !marketplaces.ok) return marketplaces;
  const plugins = await runClaude(environment, [...CLAUDE_PLUGIN_PREFIX, "list", "--json"]);
  if (!plugins.ok) return plugins;

  const availableMarketplaces = marketplaces === null ? { ok: true as const, value: new Set<string>() } : parseMarketplaces(marketplaces.value.stdout);
  const installedPlugins = parseInstalledPlugins(plugins.value.stdout);
  if (!availableMarketplaces.ok) return availableMarketplaces;
  if (!installedPlugins.ok) return installedPlugins;

  const addedMarketplaces = new Set(availableMarketplaces.value);
  const installed = new Set(installedPlugins.value);
  const records: Record<string, PluginRecord> = { ...priorRecords };
  const outcome: PluginOutcome = { installed: [], uninstalled: [], records };

  for (const plan of allPlans) {
    if (!plan.enabled) {
      if (installed.has(plan.id)) {
        const uninstall = await runClaude(environment, [
          ...CLAUDE_PLUGIN_PREFIX,
          "uninstall",
          plan.id,
          ...USER_SCOPE,
          ...YES_OPTION,
        ]);
        if (!uninstall.ok) return uninstall;
        installed.delete(plan.id);
        outcome.uninstalled.push(plan.id);
      }
      if (seenIds.has(plan.id)) records[plan.id] = pluginRecord(plan);
      else delete records[plan.id];
      continue;
    }

    if (!addedMarketplaces.has(plan.marketplace)) {
      const add = await runClaude(environment, [
        ...CLAUDE_PLUGIN_PREFIX,
        "marketplace",
        "add",
        plan.source,
      ]);
      if (!add.ok) return add;
      addedMarketplaces.add(plan.marketplace);
    }
    if (installed.has(plan.id)) {
      records[plan.id] = pluginRecord(plan);
      continue;
    }

    const install = await runClaude(environment, [
      ...CLAUDE_PLUGIN_PREFIX,
      "install",
      plan.id,
      ...USER_SCOPE,
      ...YES_OPTION,
    ]);
    if (!install.ok) return install;
    installed.add(plan.id);
    outcome.installed.push(plan.id);
    records[plan.id] = pluginRecord(plan);
  }

  return { ok: true, value: outcome };
}

function pluginRecord(plan: PluginPlan): PluginRecord {
  return { enabled: plan.enabled, marketplace: plan.marketplace, source: plan.source };
}

type SourceFile = { relativePath: string; content: FileContent };

async function loadSourceFiles(fs: FileSystem, sourcePath: string): Promise<Result<SourceFile[]>> {
  const file = await fs.readFile(sourcePath);
  if (file.ok) return { ok: true, value: [{ relativePath: "", content: file.value }] };

  const files = await fs.listFiles(sourcePath);
  if (!files.ok) return { ok: false, error: `Cannot read asset source ${sourcePath}: ${files.error}` };
  if (files.value.length === EMPTY_LENGTH) {
    return { ok: false, error: `Asset source is empty or missing: ${sourcePath} (${file.error})` };
  }

  const prefix = trimTrailingSeparator(toSlashPath(sourcePath));
  const results: SourceFile[] = [];
  for (const path of files.value) {
    const read = await fs.readFile(path);
    if (!read.ok) return { ok: false, error: `Cannot read asset source ${path}: ${read.error}` };
    const slashPath = toSlashPath(path);
    const relativePath = slashPath.startsWith(`${prefix}/`)
      ? slashPath.slice(prefix.length + PATH_SEPARATOR_LENGTH)
      : "";
    if (relativePath.length === EMPTY_LENGTH) return { ok: false, error: `Invalid file listing for asset directory ${sourcePath}` };
    results.push({ relativePath, content: read.value });
  }
  return { ok: true, value: results };
}

// Only text is searched for placeholders. Any other file (a picture, a font) is copied byte for byte.
function substitutePlaceholders(
  content: FileContent,
  values: Readonly<Record<string, string>>,
  context: string,
): Result<FileContent> {
  const text = decodeText(content.bytes);
  if (text === null) return { ok: true, value: content };
  const resolved = resolvePlaceholders(text, values, context);
  if (!resolved.ok) return resolved;
  return { ok: true, value: { bytes: new TextEncoder().encode(resolved.value), executable: content.executable } };
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(NUL_BYTE)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function enableAsset(
  environment: AssetEnvironment,
  targetPath: string,
  content: FileContent,
  records: Record<string, AssetRecord>,
  events: AssetEvent[],
  operations: AssetOperations,
): Promise<Result<void>> {
  const desiredHash = hashContent(content);
  const current = await environment.fs.readFile(targetPath);
  const prior = records[targetPath];

  if (!current.ok) {
    if (!isNotFound(current.error)) return { ok: false, error: `Cannot read installed asset ${targetPath}: ${current.error}` };
    operations.writes.push({ path: targetPath, content });
    records[targetPath] = { hash: desiredHash, owned: true, notifiedHashes: [] };
    return { ok: true, value: undefined };
  }

  const currentHash = hashContent(current.value);
  if (prior === undefined) {
    if (currentHash === desiredHash || sameContent(current.value, content)) {
      records[targetPath] = { hash: currentHash, owned: true, notifiedHashes: [] };
    } else {
      records[targetPath] = { hash: currentHash, owned: false, notifiedHashes: [currentHash] };
      events.push({ type: "setting-kept", path: targetPath });
    }
    return { ok: true, value: undefined };
  }

  if (currentHash !== desiredHash && sameContent(current.value, content)) {
    // Only the line endings differ: the file is rig's own, whatever an earlier build recorded for it.
    records[targetPath] = { hash: currentHash, owned: true, notifiedHashes: [] };
    return { ok: true, value: undefined };
  }

  if (!prior.owned) {
    const nextNotified = noteOnce(targetPath, currentHash, prior.notifiedHashes, events);
    records[targetPath] = { ...prior, hash: currentHash, notifiedHashes: nextNotified };
    return { ok: true, value: undefined };
  }

  if (currentHash !== prior.hash) {
    const notifiedHashes = noteOnce(targetPath, currentHash, prior.notifiedHashes, events);
    records[targetPath] = { ...prior, notifiedHashes };
    return { ok: true, value: undefined };
  }

  if (currentHash === desiredHash || sameContent(current.value, content)) return { ok: true, value: undefined };
  operations.writes.push({ path: targetPath, content });
  records[targetPath] = { hash: desiredHash, owned: true, notifiedHashes: [] };
  return { ok: true, value: undefined };
}

async function disableAssetTree(
  environment: AssetEnvironment,
  targetPath: string,
  records: Record<string, AssetRecord>,
  events: AssetEvent[],
  operations: AssetOperations,
): Promise<Result<void>> {
  const trimmedTarget = trimTrailingSeparator(targetPath);
  const recordPaths = Object.keys(records).filter((path) => path === targetPath || path.startsWith(`${trimmedTarget}/`));
  for (const path of recordPaths) {
    const removal = await disableAsset(environment, path, records, events, operations);
    if (!removal.ok) return removal;
  }
  return { ok: true, value: undefined };
}

async function disableAsset(
  environment: AssetEnvironment,
  targetPath: string,
  records: Record<string, AssetRecord>,
  events: AssetEvent[],
  operations: AssetOperations,
): Promise<Result<void>> {
  const prior = records[targetPath];
  if (prior === undefined) return { ok: true, value: undefined };
  delete records[targetPath];
  if (!prior.owned) return { ok: true, value: undefined };

  const current = await environment.fs.readFile(targetPath);
  if (!current.ok) {
    if (isNotFound(current.error)) return { ok: true, value: undefined };
    return { ok: false, error: `Cannot read installed asset ${targetPath}: ${current.error}` };
  }
  const currentHash = hashContent(current.value);
  if (currentHash === prior.hash) {
    operations.removals.push(targetPath);
    return { ok: true, value: undefined };
  }

  // A changed file is kept in a backup under a free name: an older backup of other content is never touched.
  const backup = await chooseBackupPath(
    `${targetPath}.bak-${environment.now().slice(0, ISO_DATE_LENGTH)}`,
    currentHash,
    async (path) => {
      const existing = await environment.fs.readFile(path);
      if (existing.ok) return { ok: true, value: hashContent(existing.value) };
      if (isNotFound(existing.error)) return { ok: true, value: null };
      return { ok: false, error: `Cannot check backup path ${path}: ${existing.error}` };
    },
  );
  if (!backup.ok) return backup;
  if (!backup.value.exists) operations.backups.push({ path: backup.value.path, content: current.value });
  operations.removals.push(targetPath);
  events.push({ type: "setting-kept", path: backup.value.path });
  return { ok: true, value: undefined };
}

function noteOnce(path: string, contentHash: string, previous: readonly string[], events: AssetEvent[]): readonly string[] {
  if (previous.includes(contentHash)) return previous;
  events.push({ type: "setting-kept", path });
  return [...previous, contentHash];
}

// Every touched file must really live inside the boundary folder: the nearest existing parent is resolved through
// symlinks and compared with the resolved boundary.
async function checkBoundary(environment: AssetEnvironment, paths: readonly string[]): Promise<Result<void>> {
  if (environment.boundaryPath === undefined || paths.length === EMPTY_LENGTH) return { ok: true, value: undefined };
  const boundary = await nearestRealPath(environment.fs, environment.boundaryPath);
  if (!boundary.ok) return boundary;
  const checkedParents = new Set<string>();
  for (const path of paths) {
    const parent = parentPath(path);
    if (checkedParents.has(parent)) continue;
    checkedParents.add(parent);
    const real = await nearestRealPath(environment.fs, parent);
    if (!real.ok) return real;
    if (real.value !== boundary.value && !real.value.startsWith(`${boundary.value}/`)) {
      return { ok: false, error: `Asset path ${path} leaves ${environment.boundaryPath} through a symlink (it resolves to ${real.value}); nothing was written.` };
    }
  }
  return { ok: true, value: undefined };
}

async function nearestRealPath(fs: FileSystem, path: string): Promise<Result<string>> {
  let candidate = path;
  for (;;) {
    const real = await fs.realPath(candidate);
    if (real.ok) return { ok: true, value: normalizeRealPath(real.value) };
    if (!isNotFound(real.error)) return { ok: false, error: `Cannot resolve ${candidate}: ${real.error}` };
    const parent = parentPath(candidate);
    // Nothing on the way exists, so nothing can be a symlink and the written path is its own real path.
    if (parent === "." || parent === candidate) return { ok: true, value: normalizeRealPath(path) };
    candidate = parent;
  }
}

function normalizeRealPath(path: string): string {
  return trimTrailingSeparator(path.replaceAll("\\", "/"));
}

async function writeTarget(fs: FileSystem, path: string, content: FileContent): Promise<Result<void>> {
  const parent = parentPath(path);
  const directory = await fs.makeDirectory(parent);
  if (!directory.ok) return directory;
  return fs.writeFileAtomic(path, content);
}

function appendRelativePath(base: string, relative: string): string {
  if (relative.length === EMPTY_LENGTH) return base;
  return `${trimTrailingSeparator(base)}/${relative}`;
}

// Record keys written by an older build may hold backslashes; they are read under their forward-slash key. When both
// forms of one path exist, the forward-slash record wins.
function withSlashKeys(records: AssetRecords): Record<string, AssetRecord> {
  const result: Record<string, AssetRecord> = {};
  for (const [path, record] of Object.entries(records)) {
    const key = toSlashPath(path);
    if (key === path || result[key] === undefined) result[key] = record;
  }
  return result;
}

// Text that differs only by line endings (CRLF against LF) is the same content; any other file is compared as bytes.
function sameContent(left: FileContent, right: FileContent): boolean {
  if (left.executable !== right.executable) return false;
  const leftText = decodeText(left.bytes);
  const rightText = decodeText(right.bytes);
  if (leftText === null || rightText === null) return false;
  return leftText.replaceAll(CRLF, LF) === rightText.replaceAll(CRLF, LF);
}

function trimTrailingSeparator(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function parentPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  const backslashIndex = path.lastIndexOf("\\");
  const separatorIndex = Math.max(slashIndex, backslashIndex);
  return separatorIndex > ROOT_SEPARATOR_INDEX ? path.slice(0, separatorIndex) : ".";
}

function isNotFound(error: string): boolean {
  return error === "not-found";
}

async function runClaude(environment: PluginEnvironment, args: readonly string[]): Promise<Result<ProcessResult>> {
  const result = await environment.runner.run(environment.claudeCommand, args);
  if (!result.ok) return { ok: false, error: `claude ${args.join(" ")} failed: ${result.error}` };
  if (result.value.exitCode !== SUCCESS_EXIT_CODE) {
    return {
      ok: false,
      error: `claude ${args.join(" ")} exited ${result.value.exitCode}: ${result.value.stderr || result.value.stdout}`,
    };
  }
  return result;
}

function parseMarketplaces(output: string): Result<Set<string>> {
  const names = new Set<string>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const markerIndex = line.indexOf("❯");
    if (markerIndex < 0) continue;
    const name = line.slice(markerIndex + MARKETPLACE_MARKER_LENGTH).trim().split(/\s+/)[0];
    if (name !== undefined && name.length > EMPTY_LENGTH) names.add(name);
  }
  return { ok: true, value: names };
}

function parseInstalledPlugins(output: string): Result<Set<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, error: "claude plugin list --json returned invalid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "claude plugin list --json returned an unexpected value" };

  const ids = new Set<string>();
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.id !== "string") {
      return { ok: false, error: "claude plugin list --json returned a plugin without an id" };
    }
    ids.add(item.id);
  }
  return { ok: true, value: ids };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

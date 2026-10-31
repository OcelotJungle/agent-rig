import type { Result } from "../result.js";

import { chooseBackupPath } from "../backup-path.js";
import { hashText } from "../content-hash.js";

export type RuleTarget = "shared" | "claude";

export type RuleChunk = {
  target: RuleTarget;
  text: string;
};

export type RuleTexts = {
  codex: string;
  claude: string;
  repairs: Array<"codex">;
};

export type RuleFile = {
  path: string;
  content: string;
};

export type RuleFilePorts = {
  read: (path: string) => Promise<Result<string | null>>;
  write: (path: string, content: string) => Promise<Result<void>>;
  rename: (from: string, to: string) => Promise<Result<void>>;
  clock: () => string;
};

const BEGIN_MARKER = "<!-- rig:begin -->";
const END_MARKER = "<!-- rig:end -->";
const CODEX_IMPORT = "@../.codex/AGENTS.md";
const GENERATED_IMPORT = "@../.agent-rig/generated/CLAUDE.md";
const UTF8_BOM = "\uFEFF";
const TEMP_SUFFIX = ".tmp";
const MARKER_KIND_GROUP = 1;
// A marker line: the marker alone on its line, indentation and trailing blanks tolerated for the repair path.
const MARKER_LINE_PATTERN = /^[ \t]*<!-- rig:(begin|end) -->[ \t]*(?=\r\n|\n|\r|$)/gm;
const MARKER_LINE_REMOVAL_PATTERN = /^[ \t]*<!-- rig:(?:begin|end) -->[ \t]*(?:\r\n|\n|\r|$)/gm;

export function assembleRules(
  chunks: readonly RuleChunk[],
  existing: { codex?: string } = {},
): RuleTexts {
  const source = existing.codex ?? "";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const shared = chunks
    .filter((chunk) => chunk.target === "shared")
		.map((chunk) => chunk.text)
    .join(newline);
  const claude = chunks
    .filter((chunk) => chunk.target === "claude")
		.map((chunk) => chunk.text)
    .join(newline);
  const block = `${BEGIN_MARKER}${newline}${shared}${newline}${END_MARKER}`;
  const codexResult = assembleCodexBlock(source, block, newline);

  return {
    codex: codexResult.content,
    claude,
    repairs: codexResult.repaired ? ["codex"] : [],
  };
}

export function ensureClaudeImports(source: string): string {
  const hasBom = source.startsWith(UTF8_BOM);
  const body = hasBom ? source.slice(UTF8_BOM.length) : source;
  const newline = detectNewline(body);
  const lines = body.split(/\r\n|\n|\r/);
  const imports = [CODEX_IMPORT, GENERATED_IMPORT].filter((line) => !lines.includes(line));

  if (imports.length === 0) {
    return source;
  }

  const prefix = imports.join(newline);
  const separator = body.length > 0 ? newline : "";
  return `${hasBom ? UTF8_BOM : ""}${prefix}${separator}${body}`;
}

export type RuleWrite = {
  path: string;
  content: string;
};

export type RuleFilePlan = {
  backups: RuleWrite[];
  writes: RuleWrite[];
};

export async function updateRuleFiles(
  files: readonly RuleFile[],
  ports: RuleFilePorts,
): Promise<Result<string[]>> {
  const plan = await planRuleFiles(files, ports);
  if (!plan.ok) {
    return plan;
  }
  const executed = await executeRuleFilePlan(plan.value, ports);
  if (!executed.ok) {
    return executed;
  }
  return { ok: true, value: plan.value.writes.map((write) => write.path) };
}

// Reads the disk and decides which files change and what is copied first; writes nothing.
// A backup of different content under the same name is never overwritten: the copy takes the next free number.
export async function planRuleFiles(
  files: readonly RuleFile[],
  ports: RuleFilePorts,
): Promise<Result<RuleFilePlan>> {
  const plan: RuleFilePlan = { backups: [], writes: [] };

  for (const file of files) {
    const currentResult = await ports.read(file.path);
    if (!currentResult.ok) {
      return { ok: false, error: currentResult.error };
    }
    if (currentResult.value === file.content) {
      continue;
    }

    if (currentResult.value !== null) {
      const backup = await chooseBackupPath(
        `${file.path}.bak-${ports.clock()}`,
        hashText(currentResult.value),
        async (path) => {
          const existing = await ports.read(path);
          return existing.ok ? { ok: true, value: existing.value === null ? null : hashText(existing.value) } : existing;
        },
      );
      if (!backup.ok) {
        return backup;
      }
      if (!backup.value.exists) {
        plan.backups.push({ path: backup.value.path, content: currentResult.value });
      }
    }
    plan.writes.push({ path: file.path, content: file.content });
  }

  return { ok: true, value: plan };
}

export async function executeRuleFilePlan(plan: RuleFilePlan, ports: RuleFilePorts): Promise<Result<void>> {
  for (const write of [...plan.backups, ...plan.writes]) {
    const written = await writeAtomically(write.path, write.content, ports);
    if (!written.ok) {
      return written;
    }
  }
  return { ok: true, value: undefined };
}

function assembleCodexBlock(
  source: string,
  block: string,
  newline: string,
): { content: string; repaired: boolean } {
  const hasBom = source.startsWith(UTF8_BOM);
  const body = hasBom ? source.slice(UTF8_BOM.length) : source;
  // Only a marker that is alone on its line counts. The same text inside a sentence is the user's own words.
  const markerLines = [...body.matchAll(MARKER_LINE_PATTERN)];
  const beginLines = markerLines.filter((line) => line[MARKER_KIND_GROUP] === "begin");
  const endLines = markerLines.filter((line) => line[MARKER_KIND_GROUP] === "end");
  const beginLine = beginLines[0];
  const endLine = endLines[0];
  const isValidPair =
    beginLines.length === 1 && endLines.length === 1 && beginLine !== undefined && endLine !== undefined &&
    beginLine.index < endLine.index &&
    beginLine[0] === BEGIN_MARKER && endLine[0] === END_MARKER;

  if (isValidPair) {
    return {
      content: `${hasBom ? UTF8_BOM : ""}${body.slice(0, beginLine.index)}${block}${body.slice(endLine.index + END_MARKER.length)}`,
      repaired: false,
    };
  }

  const repaired = markerLines.length > 0;
  const preserved = body.replace(MARKER_LINE_REMOVAL_PATTERN, "");
  const prefix = hasBom ? UTF8_BOM : "";
  const separator = preserved.length > 0 ? newline : "";
  return {
    content: `${prefix}${block}${separator}${preserved}`,
    repaired,
  };
}

function detectNewline(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

async function writeAtomically(
  path: string,
  content: string,
  ports: RuleFilePorts,
): Promise<Result<void>> {
  const tempPath = `${path}${TEMP_SUFFIX}`;
  const writeResult = await ports.write(tempPath, content);
  if (!writeResult.ok) {
    return writeResult;
  }
  return ports.rename(tempPath, path);
}

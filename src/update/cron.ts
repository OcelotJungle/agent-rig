import type { Result } from "../result.js";

const HOURLY_SCHEDULE = "0 * * * *";
const PENDING_SCHEDULE = "*/5 * * * *";
const HOURLY_MARKER = "# agent-rig-update-hourly";
const PENDING_MARKER = "# agent-rig-update-pending";
const PATH_MARKER = "# agent-rig-update-path";
const PATH_PREFIX = "PATH=";
// update.log is moved to update.log.1 once it passes 1 MiB, so it keeps at most about two files of history.
const LOG_ROTATE_BYTES = 1_048_576;

export type CronOptions = { bunPath: string; rigPath: string; path: string; logPath: string };
// Environment lines go to the top of the crontab (cron applies them to the jobs below), jobs go to the bottom.
export type CronEntries = { environment: string[]; jobs: string[] };

export function buildCronEntries(options: CronOptions): Result<CronEntries> {
  if (!options.bunPath.startsWith("/") || !options.rigPath.startsWith("/")) {
    return { ok: false, error: "Пути к bun и rig должны быть абсолютными путями сервера." };
  }
  if (/["\r\n]/.test(options.path)) {
    return { ok: false, error: "PATH для cron не должен содержать кавычки и переводы строк." };
  }
  const bun = quoteShellWord(options.bunPath);
  const rig = quoteShellWord(options.rigPath);
  const log = quoteShellWord(options.logPath);
  const rotated = quoteShellWord(`${options.logPath}.1`);
  const rotate = `if [ -f ${log} ] && [ "$(wc -c < ${log})" -gt ${LOG_ROTATE_BYTES} ]; then mv -f ${log} ${rotated}; fi;`;
  return { ok: true, value: {
    environment: [PATH_MARKER, `${PATH_PREFIX}"${options.path}"`],
    jobs: [
      `${HOURLY_SCHEDULE} ${escapePercent(`${rotate} ${bun} ${rig} update >> ${log} 2>&1`)} ${HOURLY_MARKER}`,
      `${PENDING_SCHEDULE} ${escapePercent(`${rotate} ${bun} ${rig} update --pending >> ${log} 2>&1`)} ${PENDING_MARKER}`,
    ],
  } };
}

export function mergeCronEntries(existing: string, entries: CronEntries): string {
  const lines = existing.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const retained: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === PATH_MARKER) {
      if ((lines[index + 1] ?? "").startsWith(PATH_PREFIX)) index += 1;
      continue;
    }
    if (!isManagedJob(line)) retained.push(line);
  }
  return `${[...entries.environment, ...retained, ...entries.jobs].join("\n")}\n`;
}

function isManagedJob(line: string): boolean {
  return line.endsWith(` ${HOURLY_MARKER}`) || line.endsWith(` ${PENDING_MARKER}`);
}

// A bare percent sign in a crontab command is turned into a newline by cron.
function escapePercent(command: string): string {
  return command.replaceAll("%", "\\%");
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

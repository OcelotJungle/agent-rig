import type { Messages } from "../messages.js";
import type { ProcessPorts } from "../ports.js";
import type { Result } from "../result.js";

import { fileURLToPath } from "node:url";

import { err, ok } from "../result.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";

// The most a console read may take (ms): attaching to a console and reading one screen is instant, so a helper that outlives
// this is stuck (a console that never answers) and is killed with its tree by the process runner.
const CONSOLE_READ_TIMEOUT_MS = 10000;
const READER_SCRIPT = fileURLToPath(new URL("./console-text.ps1", import.meta.url));
const READER_SOURCE = fileURLToPath(new URL("./console-text.cs", import.meta.url));
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The visible text of the console screen of process `pid`, read by a hidden powershell helper (AttachConsole and
 * ReadConsoleOutputCharacterW in console-text.cs). Windows only. Read-only: the console is not changed. Any failure, the
 * helper's timeout included, is an error and never an empty text, so the caller can tell "nothing on screen" from "not read".
 */
export const readConsoleText = async (processes: Pick<ProcessPorts, "run">, messages: Messages, host: string, pid: number): Promise<Result<string>> => {
	if (host !== "win32") return err(messages.failure.consoleReadUnsupported(host));
	const done = await processes.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", READER_SCRIPT, READER_SOURCE, String(pid)], { timeoutMs: CONSOLE_READ_TIMEOUT_MS });
	if (!done.ok) return done;
	if (done.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return err(messages.failure.consoleReadFailed(done.value.stderr.trim()));
	const encoded = done.value.stdout.trim();
	if (!BASE64_TEXT.test(encoded)) return err(messages.failure.consoleTextInvalid());
	return ok(Buffer.from(encoded, "base64").toString("utf8"));
};

// The output contract of the rig CLI: rig is an API. A command prints one JSON object on stdout and nothing else.
// Success: the command's typed result, exit code 0. Failure: `{"error": {"code", "message"}}`, exit code nonzero.
// The `code` is stable and machine-readable; the `message` is a text in rig's language (the only rig-language text a
// client may see besides the agent rules rig generates). Display (ages, durations, wording) belongs to the client.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ApiError = { code: string; message: string };
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const apiOk = <T>(value: T): ApiResult<T> => ({ ok: true, value });
export const apiFail = (code: string, message: string): ApiResult<never> => ({ ok: false, error: { code, message } });

// Codes the CLI layer itself produces; a command adds its own codes next to its handler.
export const ERROR_CODE_USAGE = "usage";
export const ERROR_CODE_RUNTIME = "runtime-unavailable";
export const ERROR_CODE_INTERNAL = "internal-error";
// A command that has not moved to typed results yet reports a plain failure under this code.
export const ERROR_CODE_FAILED = "command-failed";
export const SESSION_BAD_ID = "session-bad-id";
export const SESSION_UNKNOWN = "session-unknown";
export const SESSION_INVALID = "session-invalid";
export const SESSION_IO = "session-io";
export const SESSION_ENDED = "session-ended";
export const SESSION_NO_MODULE = "session-no-module";
export const SESSION_TIMEOUT = "session-timeout";
// The deadline passed while the module had claimed the request and was running it: it may still complete, so a retry could repeat it.
export const SESSION_TIMEOUT_RUNNING = "session-timeout-running";
export const SESSION_CLAIM_LOST = "session-claim-lost";
export const SESSION_MODULE_ERROR = "session-module-error";
export const SESSION_BAD_RESPONSE = "session-bad-response";
export const SESSION_STOP_TIMEOUT = "session-stop-timeout";
export const SESSION_ENDING = "session-ending";
export const SESSION_CLEANUP_NOT_COMPACTED = "session-cleanup-not-compacted";
export const LAUNCH_INVALID = "launch-invalid";
export const LAUNCH_ACCOUNT_LOOKUP = "launch-account-lookup";
export const LAUNCH_FAILED = "launch-failed";
export const LAUNCH_TIMEOUT = "launch-timeout";
// A launch with a prompt whose session registered but the prompt was not delivered: the window stays open, the text did not reach the session.
export const PROMPT_NOT_DELIVERED = "prompt-not-delivered";
// A launch with a prompt that timed out after the module had begun it: the text may still arrive, so it is not sent again.
export const PROMPT_DELIVERY_UNKNOWN = "prompt-delivery-unknown";
export const OWNER_SWITCH_UNAVAILABLE = "owner-switch-unavailable";
// A launch under an account is refused before any window because the folder's consent cannot be carried into the account's profile.
export const WORKSPACE_UNTRUSTED = "workspace-untrusted";
export const ACCOUNT_PROFILE_MISSING = "account-profile-missing";
export const ACCOUNT_PROFILE_INCOMPLETE = "account-profile-incomplete";
export const ACCOUNT_PROFILE_UNREADABLE = "account-profile-unreadable";
export const ACCOUNT_CONFIG_BUSY = "account-config-busy";
export const SESSION_RUNNING = "session-running";
export const EXEC_BAD_ID = "exec-bad-id";
export const EXEC_UNKNOWN = "exec-unknown";
export const EXEC_INVALID = "exec-invalid";
export const EXEC_IO = "exec-io";
export const EXEC_UNAVAILABLE = "exec-unavailable";
export const EXEC_LAUNCH = "exec-launch";
export const PROGRESS_CODE_SESSION_WAITING = "session-waiting";
// An ending operation is starting its compaction step; no data.
export const PROGRESS_CODE_SESSION_COMPACTING = "session-compacting";
// An ending operation is starting to terminate the session's processes; no data.
export const PROGRESS_CODE_SESSION_TERMINATING = "session-terminating";
export const PROGRESS_CODE_SESSION_RUNNING = "session-running";
export const LAUNCH_UNAVAILABLE = "launch-unavailable";

export const SUCCESS_EXIT_CODE = 0;
export const FAILURE_EXIT_CODE = 1;

export const renderSuccess = (value: JsonValue): string => JSON.stringify(value);
export const renderFailure = (error: ApiError): string => JSON.stringify({ error });

// A progress event of a long-running command. It goes to stderr as one JSON object per line, `{"progress": {...}}`,
// never to stdout, so stdout stays the one final JSON object. A client may read stderr or ignore it.
export type ProgressEvent = { code: string; data?: JsonValue };
export const renderProgress = (event: ProgressEvent): string => JSON.stringify({ progress: event });

// The command waits for the rig lock; probe failures carry the owner PID, error, and localized message.
export const PROGRESS_CODE_LOCK_WAITING = "lock-waiting";

// `rig update` relays one text line of its child step (`update-step apply|check`, internal protocol); data: {step, line}.
export const PROGRESS_CODE_UPDATE_STEP_OUTPUT = "update-step-output";

// A system package the enabled feature needs is missing and the user has to install it; data: {name, command}.
export const PROGRESS_CODE_PROGRAM_INSTALL = "program-install";

// `rig feature telegram disable` is stopping the hub service before it exits; it carries no data.
export const PROGRESS_CODE_SERVICE_STOPPING = "service-stopping";

// A long-running plugin or marketplace mutation through the Claude CLI; data: {program, args}.
export const PROGRESS_CODE_PLUGIN_COMMAND = "plugin-command";

// The Telegram hub service is starting; it carries no data.
export const PROGRESS_CODE_SERVICE_STARTING = "service-starting";

// The Telegram hub service is restarting; it carries no data.
export const PROGRESS_CODE_SERVICE_RESTARTING = "service-restarting";

// A git fetch for one repository during rig update; data: {program, args}.
export const PROGRESS_CODE_GIT_FETCH = "git-fetch";

// The isolated update step is starting; data: {program, step}.
export const PROGRESS_CODE_UPDATE_STEP_STARTING = "update-step-starting";

// Rig is installing a managed program dependency; data: {name, command}.
export const PROGRESS_CODE_MANAGED_PROGRAM_INSTALL = "managed-program-install";

// A git merge or reset during rig update; data: {program, args}.
export const PROGRESS_CODE_GIT_COMMAND = "git-command";

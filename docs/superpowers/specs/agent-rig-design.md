# agent-rig: the harness for Claude Code and Codex as one application

The spec is living: it describes how the system works now and changes together with the decisions.

## Why

An agent's harness usually grows out of scattered hooks, rules and scripts in `~/.claude`. Such a set cannot be handed to
another person, has no history and has no single way to turn something on or off. The harness has to be deployable on an
Ubuntu server, updates have to arrive there by themselves, without manual work, and the user's personal rules must not be
lost along the way.

Success: the user's agent deploys everything from `INSTALL.md`, updates then arrive by themselves, features are switched
from Telegram, and the developer of `rig` works from a working copy of the same repository.

## Terms

- **Server:** the user's machine with Ubuntu 24.04. Mode `server`, auto-update on.
- **Development mode:** for those who develop `rig` itself on Windows with Git Bash: a working copy and working
  branches. Mode `dev`, no auto-update.
- **Hub:** the Telegram hub, the `claude-telegram-hub` repository. It is not the `rig` application.
- **Main files:** `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.codex/AGENTS.md`.
- **Shared rules:** text for all agents, it lives in the `AGENTS.md` block.
- **Claude rules:** text for Claude only, it lives in the generated file.
- **`rig` entry:** a settings key, a hook entry, a plugin, an agent or skill file installed by `rig`.

## Goals

- One public repository `agent-rig` and the `rig` command: install, features, update, status.
- A base that works with Claude Code alone, and separate features on top of it.
- Personal rules and settings that do not end up in the repository and do not change on update.
- Auto-update on the server with rollback on failure.
- The hub as an add-on: its commands are passed to `rig`, `rig` events arrive in Telegram.
- English by default, Russian by one shared setting that `rig` owns and the hub follows.

## Non-goals

- Setting development rules. The goal is the harness; JS/TS conventions are only an optional feature.
- A permanent `rig` service. There must be nothing to crash.
- The hub working without `rig`: there is no point in the hub working apart from the rest.
- Per-project feature settings: features apply to the whole machine.
- Moving personal files to another machine and their backups.

## Parts and paths

| Part | What it is | Where |
|---|---|---|
| `rig` | A Bun/TS command with no permanent process | the `agent-rig` repository, called through `~/.local/bin/rig` |
| `agent-rig` clone | Code, base, features | server: `~/.agent-rig/repo`; developer: their own working copy |
| Hub clone | Hub code | server: `~/.agent-rig/hub`; developer: their own working copy |
| Base | The same as a feature, but cannot be turned off | `<clone>/base/` |
| Features | Folders with a manifest, rules, hooks, skills | `<clone>/features/<name>/` |
| State | Mode, clone paths, enabled features, `rig` entries, bad commits, language | `~/.agent-rig/state.json` |
| Generated rules | Claude rules, the file belongs to `rig` | `~/.agent-rig/generated/CLAUDE.md` |
| Events | A file for the hub, format below | `~/.agent-rig/events.jsonl` |
| Log | Output of cron runs | `~/.agent-rig/update.log` |

Every path `rig` stores or compares has one form: forward slashes, also on Windows (`C:/Users/me/.claude/skills/x/SKILL.md`).
The file-system adapters, `joinPath`, the runtime (`home`, `resolvePath`), the clone and hub paths in `state.json` and the
`{{CLONE}}`, `{{HUB}}`, `{{HOME}}` and `{{PYTHON}}` substitutions all produce it. A `state.json` written by an older build
with backslashes is read in this form: its asset keys match the same files, nothing is duplicated or taken for foreign.
Only the `rig.cmd` shim keeps backslashes, because `cmd.exe` needs them.

Clone paths are stored in `state.json`, the code does not hard-code them. The remote address is taken from the clone's
`origin`, the branch is always `main`.

Hook commands in `settings.json` contain the absolute path to the clone and are built at `rig apply`, so a repeated
`apply` fixes them after a clone is moved. For example, on a server:
`python3 "/home/<user>/.agent-rig/repo/base/hooks/compact_history.py"`.

Ready-made Python scripts stay on Python, so the machine needs Python 3. `rig` substitutes the interpreter: `python3` on
Linux, `python` on Windows. `rig check` verifies that the interpreter starts.

Hooks run straight from the clone. Claude Code looks for agents and skills in `~/.claude`, so `rig` copies them there,
substituting paths and the interpreter in place of `C:/Users/...`.

## Base and features

The `feature.json` manifest sets: name, description, whether it is on at install, platforms, dependencies on other
features, rule pieces with a target (`shared` or `claude`), hooks, settings keys, plugins, agents, skills, hub commands,
programs that must be on the machine, and how to install them without root. The description is a plain English string;
the optional field `translations` holds the texts in the other languages,
`{ "ru": { "description": "..." } }`, and `rig` shows the one in the current language, or the English one when the
language has no translation (see "Language").

In the current format `rules` refers by the `path` field to a file relative to the part; the order of pieces is the order
of the array. `platform`, `whenEnabled` and `whenDisabled` restrict rules. `hooks` holds `event`, `matcher` and `command`;
`args`, `platform`, `timeout`, `statusMessage`, `translations`, `async`, `asyncRewake` and `shell` are optional;
`statusMessage` is a plain English string and the hook's `translations`, `{ "ru": { "statusMessage": "..." } }`, holds
its texts in the other languages (see "Language"). The substitutions
`{{CLONE}}`, `{{HUB}}`, `{{HOME}}` and `{{PYTHON}}` are resolved by one mechanism at apply time for rules, hooks, settings
values, agents, skills and copied files. `settings` sets a dotted key and a value; `id`, `kind` and `platform` are
optional. `kind` is `value`, `list-entry` or `install-default`; without `kind`, the permission lists `permissions.allow`,
`permissions.deny` and `autoMode.allow` are extended, other values are replaced. `assets` holds `sourcePath`/`targetPath`
pairs relative to the feature clone and to `~/.claude`; paths cannot leave these directories. `files` lists extra sources
that stay in the clone; `agents` and `skills` list the source files and directories to copy. Programs can be restricted by
`platform`. Plugins are given by the selector `plugin@marketplace`; the hub's local plugin is taken from the hub clone.
`hubCommands` is a list of command names the feature declares for the hub.

If a needed program is missing at `enable` or update, `rig` installs it itself when root is not needed. It does not install
system packages: it prints the command, and at update `rig check` fails, the rollback runs and an event with that command
arrives.

The composition of the base and features. File paths are relative to the part's own directory (`<clone>/base/` or
`<clone>/features/<name>/`). Hook scripts, tools and the other `files` stay in the clone and run from there; only
`agents/`, `skills/` and `assets` are copied into `~/.claude`. Rule text therefore names helper files as
`{{CLONE}}/base/tools/patchlib.py` and uses `{{HOME}}/.claude/...` only for what `rig` installs there or for the Claude
Code locations (`CLAUDE.md`, `settings.json`, `skills/`, the directory itself); a test checks every such path.
Sections are headings in `CLAUDE.md` and `~/.codex/AGENTS.md`.

| Part | On at install | Platforms | Files | Hook | Rules |
|---|---|---|---|---|---|
| base | always | all | `hooks/project-tmp.sh`, `hooks/project-tmp-settings.ps1` (Windows only), `hooks/compact_history.py`, `hooks/no_ampersand.py`, `tools/patchlib.py`, `agents/explore.md`, `agents/general-purpose.md` | all three | see below |
| `reflection` | yes | all | `hooks/reflect.py`, `hooks/reflect_prompt.md` | `Stop` | — |
| `codex` | yes | all | `tools/codex-run.py`, `agents/codex.md`, plugin `codex@openai-codex` | `SessionStart`: `codex-run.py session-hint` | "Delegating to Codex" |
| `telegram` | yes | all | plugin `telegram-hub` from the hub clone, the hub service, including `/bash` | plugin hooks | "Attention chime", the line about Telegram mode |
| `rtk` | yes | all | the `rtk` program, `RTK.md` | `PreToolUse`: `rtk hook claude` | — |
| `superpowers` | yes | all | plugin `superpowers@claude-plugins-official` | — | — |
| `skills` | yes | all | `skills/measurement-runs`, `skills/mutation-check-new-tests`, `skills/spec-drafting` | — | — |
| `volunteers` | no | Windows | the `uvx` program, `tools/volunteer-run.py`, `volunteer-models.py`, `volunteer-launch.ps1`, `volunteer-design.md`, `volunteer-probes.md`, `agents/volunteer.md` | — | "Delegating to volunteers" |
| `pwsh`, `cmd` | no | Windows | hub commands, depend on `telegram` | — | — |
| `js-ts-rules` | no | all | — | — | "JS/TS code conventions" |

`tools/tests/` go into the repository together with the scripts. The `volunteers` tests live in its feature.

The repository has no personal paths or project names. The folders in which a volunteer works are listed in the local file
`~/.agent-rig/volunteer-projects.json` (`{"allowed": ["<folder>"]}`). Without this file the volunteer refuses all folders.

The `codex` supervisor owns each Codex process tree through the shared process-job helper `base/tools/process-job.py`. It
closes the job after every turn or stop, including normal completion; if cancellation times out, the client stops the
supervisor by PID so the job is cleaned up with it.

Base rules:

| Target | Sections |
|---|---|
| `shared` | "Addressing the user", "Temporary files", "Tests and runs", "Specs are living documents" |
| `claude` | "Compact instructions", "Global rules vs project memory", "Ask-driven development", "Every message gets an answer", "Writing to the user", "Fixing a sent answer", "BLOCKERS GO FIRST", "Review and engineering method", "Subagent models", "Delegation: keep the main context small", "Commits", "No heredocs", "Background tasks and monitors" |
| `claude`, Windows only | "Windows commands go through Bash" |
| Stay personal | the person's own sections and lines: they are not part of the base and stay in their main files |

The line saying that routine work is done by `volunteer` and similar lines in the delegation section depend on features: if
`codex` and `volunteers` are absent, the work goes to Claude subagents. The text is built so that it does not refer to
anything turned off. Rules that apply only to Windows, for example about the Codex sandbox and Bun, go into Windows-only
pieces.

`settings.json` keys, other than hooks and plugins:

| Part | Keys |
|---|---|
| base | `attribution` with empty `commit` and `pr` |
| base, Windows only | `env.CLAUDE_CODE_USE_POWERSHELL_TOOL` = `0` |
| `codex` | permission for `codex-run.py` in `permissions.allow`, the `Agent(codex:codex-rescue)` deny in `permissions.deny`, entries about the wrapper in `autoMode.allow` and `autoMode.environment` |
| Stay personal | model, effort, auto-compact, `autoMode` rules not related to features, theme, the other `env` and denies |

Ownership is counted per value: `rig` owns a line in a list and a key in `env`, not the whole of `permissions` or `env`.

Switching rules:
- `disable` only turns off: it removes hooks, rules, commands, the plugin. Programs, logins and data stay.
- A feature on an unsuitable platform does not turn on, `rig` explains why.
- A feature that an enabled one depends on cannot be turned off, and a feature cannot be turned on without its dependencies.
- Rules and settings change at once, windows pick them up at the next start. A changed hook script works from the next
  call, including in open windows.

## Assembly

The main rule: the main files belong to the person and their agent, the agent may change them, and the mechanism survives
any edit of them. Everything in these files not written by `rig` is the personal layer.

`rig apply` is the only write mechanism, and it is idempotent. Before writing a main file a copy `*.bak-<date>` is made if
the file changes. A second copy on the same day with different content gets a number: `settings.json.bak-<date>-2`, then
`-3` and so on (`src/backup-path.ts`); a copy with the same content is not duplicated.

`apply` works as a transaction (`src/apply.ts`, `src/apply-journal.ts`):
1. Everything is computed purely, with no disk writes.
2. A journal is written to `state.json`: the expected hash of each file and of `settings.json`, and the new ownership
   entries.
3. The disk writes happen.
4. The final state is saved without the journal, then the events with stable identifiers are sent.

The next run first processes a leftover journal: a file with the expected hash is considered written by `rig`, the
ownership entry is taken from the journal, otherwise the old entry stays. A killed `apply` does not make `rig` files
foreign and does not repeat events.

1. **`~/.codex/AGENTS.md`.** `rig` updates only the block between the lines `<!-- rig:begin -->` and `<!-- rig:end -->`.
   The shared rules of the base and of the enabled features go there. Text outside the block does not change. No block: it
   is created at the start of the file. Only one marker present: it is removed, the block is created at the start of the
   file, an event is sent.
2. **`~/.agent-rig/generated/CLAUDE.md`.** Rebuilt entirely from the Claude rules.
3. **`~/.claude/CLAUDE.md`.** It must contain both import lines: `@../.codex/AGENTS.md` and
   `@../.agent-rig/generated/CLAUDE.md`. The exact line anywhere in the file is checked. If it is missing, it is added at
   the start of the file. The rest of the text does not change. Claude reads the shared rules through `AGENTS.md`, so they
   do not go into the generated file and are not duplicated. The person's text comes after the imports and outweighs them.
4. **`~/.claude/settings.json`.** Merged by the ownership rules below.
5. **Agents, skills, plugins.** Installed for enabled parts, removed for disabled ones. Plugins are installed through
   `claude plugin`.

Ownership rules: `state.json` stores every `rig` entry with the written value or the file hash.

| Case | What `rig` does |
|---|---|
| No entry, and no matching one either | Adds it, remembers it |
| The same entry already exists, but not from `rig` | Accepts it as its own, creates no duplicate. This is how an existing setup is taken over. A text file that differs from the source only in line endings (CRLF against LF) is the same entry; a binary file is compared byte for byte |
| The value or file was changed | Keeps the changed one, sends an event once |
| The entry was deleted, the feature is on | Restores it. Turning off must be done through `/feature` |
| The feature was turned off, the entry was not changed | Deletes it |
| The feature was turned off, the entry was changed | Deletes it, the changed value stays in the copy `*.bak-<date>`, sends an event with its path |

A hook entry is recognized by the script name in the command or by the command `rtk hook claude`; a user hook with the
same script and different `args` does not count as its own. The identifier of a settings entry is built from the key and
the value of the list entry, not from its number in the manifest, so reordering the manifest deletes and restores nothing.
A user entry in the place of a `rig` entry is preserved in a copy with the event `setting-kept`.

The person's personal skills and hooks are not part of the repository and do not count as `rig` entries. `rig` sets the
Claude Code update channel only at install, if the key is absent, and does not own it afterwards.

## Commands

Commands that change something take one lock. If it is taken, the command waits until it is free. The lock is released
also when the process holding it crashes, otherwise the wait would be eternal (`src/lock.ts`). The lock file is created
exclusively, with the owner's PID and start time. A stale lock is taken over by whoever exclusively created the file
`<lock>.takeover`: under it the lock is read again and deleted. If the owner's start time cannot be found out, the lock is
considered taken. When a command starts waiting for the lock, it immediately, before waiting, prints one line `Another rig command is running, waiting for it to finish.` (the message `lock.waiting` in the catalog `src/messages.ts`). The line goes to standard output at once, not at the end of the command. It is printed by `rig update` (without `--pending`), `rig apply`, `rig feature <name> enable|disable`, `rig language en|ru` and `rig install`. If the lock is free or a stale one is taken at once, there is no line. `rig update --pending` does not wait for the lock: if it is taken it exits at once and prints no waiting line. Exit code 0 is success, 1 is failure. The output is plain text; `--json` on `rig feature`, `rig status` and `rig language` is for the hub.

External commands (`git`, `claude plugin`, `systemctl`) go through the common process runner
(`src/commands/process-runner.ts`): after 15 minutes they are stopped together with the whole process tree and counted as
failed; `git` never asks for a login (`GIT_TERMINAL_PROMPT=0`). The `systemctl --user` calls set `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS` themselves if they are absent (this happens under cron). The `is-active` exit code 0 means
"running", 3 means "stopped", any other is a query error, not a stopped service.

- `rig install [--dev]`: checks programs, writes the state, enables the default features, runs `apply`, on a server adds
  the cron job. `--dev` turns on developer mode and takes the clone paths from the current location.
- `rig apply`: rebuild everything from the current state.
- `rig feature [--json]`: the list of features and their state.
- `rig feature <name> enable|disable`: switch and apply. If at `rig feature telegram enable` the hub service did not start,
  the enabling is cancelled and the command fails with an error.
- `rig language [en|ru] [--json]`: show or set the language, see "Language".
- `rig update`: update both repositories, see below. Refuses in mode `dev`. The versions for the update message are read
  from the `package.json` of the rig commit and the `plugin/package.json` of the hub commit; they are not taken from the
  working copy.
- `rig status [--json]`: versions, features, the last update, the pending hub restart, the language, errors. The human-readable
  output shows the version from the `package.json` of the rig commit and the `plugin/package.json` of the hub commit
  together with the full commit hash; if the version is unknown, it shows only the hash. `errors` and the text contain only
  the errors recorded after the last `update-ok`; older ones stay in `events.jsonl`.
- `rig check`: the generated files and imports are in place, `settings.json` parses, every recorded hook matches the
  expected one by event, command, `args` and `matcher`, hooks are run the way Claude Code runs them (a hook with `args`
  is executed directly; a hook without `args` is a command string run through its shell: `bash -c`, or `powershell`
  when the hook's `shell` says so; any other `shell` fails the check) with a test event (for tool events it carries
  `tool_name` and `tool_input`) with `CLAUDE_PROJECT_DIR` pointing at a temporary directory, the interpreter and the
  programs of the enabled features are present, the hub service is running if `telegram` is on. If the service answered
  "not running", the check asks it twice more, with a pause of one systemd restart (2 s) plus a 1 s margin: a hub that is
  just restarting is not taken for stopped. On Windows `bash` is taken from Git Bash (`C:/Program Files/Git/bin/bash.exe`),
  otherwise the check fails with a clear message.

## Language

One shared setting, owned by `rig`: `language` in `~/.agent-rig/state.json`, the value `"en"` or `"ru"`; a missing field
means `"en"`. `rig` and the hub are English by default and switch to Russian together, only after the human asks.

- `rig language` prints the current language; `rig language en|ru` sets it under the rig lock and emits the event
  `language-changed` whose text is in the new language. Setting the value that is already set is a no-op, with no event.
  `rig language --json` prints `{"language":"en"}`. Without `state.json` rig is not installed: `rig language` and
  `rig language en|ru` fail with a message to run `rig install` first. A `language` value that is not `en` or `ru` does not
  make `state.json` invalid: it is read as English everywhere, and `rig language en|ru` replaces it with a valid value
  (a repair, without an event).
- Every string that `rig` shows the human (command output, the waiting line, event texts, the text the hub shows from `rig`)
  comes from one message catalog with the languages `en` and `ru`; the catalog is typed so that `ru` carries every key of
  `en`, and there is no Russian text in the code outside the `ru` catalog. An event text is written in the language that is
  current when the event is emitted. The exception is rare low-level diagnostics raised deep in the code (an unreadable
  `state.json`, a failed file operation, a failed process read): they are always English, with the system's own text.
- A feature description in `feature.json` is a plain English string; the other languages go into the optional
  `translations` field, keyed by language: `{ "ru": { "description": "..." } }`. `rig feature` and `rig feature --json`
  print the description in the current language, falling back to the English string, and always as a plain string, so the
  contract field stays a string.
- A hook's `statusMessage` follows the same pattern: the plain string stays English (the previous release reads new
  manifests during `rig update` and ignores unknown keys), the hook's `translations` holds `{ "ru": { "statusMessage":
  "..." } }`. `settings.json` carries the message in the language in force at apply time, English when the hook has no
  translation for it. `rig language en|ru` that changes the language reruns the normal apply (the same `applyRig`, under
  the same rig lock) with the new language, so rig's own hook entries are rewritten; a hook entry the user changed by
  hand follows the usual ownership rules and is kept.
- `rig status` in text form shows the language on its own line. `rig status --json` is unchanged: it has no language field,
  because the hub validates this object with a strict schema. The hub learns the language from `rig language --json`.
- Agent replies (Claude, Codex) are not tied to the setting: the rules tell agents to reply in the user's language. The rule
  about addressing the user informally applies to any language with a formal and an informal "you".
- The rule texts, the tool documentation and the repository documents are English.

## Update

Cron calls `rig update` on the server once an hour, the output goes to `update.log`. A second cron job every 5 minutes calls
`rig update --pending`: it performs only the check of the pending hub restart from step 7 and exits at once without one. On
success it prints nothing, so that `update.log` does not grow every 5 minutes.

1. Take the lock. Handle the pending hub restart, see step 7.
2. Fetch `main` of both repositories. Nothing new — exit.
3. If the pair of new commits equals the bad pair, exit. Exactly this pair is considered bad; each new commit on top of it is
   tried once, so a fix arrives by itself and no manual resolution is needed.
4. If at least one clone has local changes or local commits, or a clone is not on `main`, the update is skipped entirely,
   the clones are not touched, and one event with the reason is sent. This way a mix of new and old versions cannot appear.
   The same failure reason gives one message; a new one arrives only when the reason changes or after the problem is gone.
   If the failure disappeared without new commits, one `update-ok` event reports it. Remember the current commits and move
   only by fast-forward.
5. `apply` and `check` of the new code run in a child process
   `bun <clone>/src/cli.ts update-step apply|check <pid> <start time>` under the parent's lock: this way a broken `cli.ts`
   of the new commit does not pass the check by the old code. The service command accepts only the PID and start time of the
   parent that holds the lock.
6. Failure: return both repositories to the remembered commits, `rig apply` again, record the pair as bad, send an event.
   The rollback is done by the parent, that is, the old code; the previous `settings.json` and rules are restored by its
   repeated `apply`. A rollback to a release before 0.3 drops the `language` setting from `state.json` (the old parser does
   not know the field), so the language falls back to English. A child process that crashed or failed to start also ends in a rollback. A `check` that could not poll
   the environment (for example, a service bus failure) also rolls back, but does not record the pair as bad. `badPairs`
   stores only the last bad pair. The update event is delivered exactly once, even through a failure: it is first written to
   the state as `pendingEvent`, sent, then cleared.
7. Success: rules and hooks already work. If the hub changed, a pending restart is remembered and the event
   `hub-restart-pending` is sent. The hub waits until no session has a turn in progress, writes
   `~/.agent-rig/hub-restarting.json` and exits; systemd starts it with the new code, and it writes
   `~/.agent-rig/hub-ready.json` with the commit. There is no separate restart message: one `update-ok` event with the
   versions describes the update. `rig update --pending` looks at these files: 5 minutes after `hub-restarting` there is no
   readiness of the new commit — rollback as in step 6. The limit is 5 minutes and the check runs from cron every 5 minutes,
   so the rollback happens 5-10 minutes after the hub restart. The hub waits for idleness without limit and does not
   interrupt the agents' work; after a day of waiting one event arrives. New commits that arrived during the wait are
   applied as usual. The pending restart stores the last pair on which the hub confirmed startup: the rollback returns it,
   and the last tried pair is recorded as bad. If `telegram` is off, no restart is awaited.
8. A feature appeared that is not in `state.json`: it is recorded as off and an event with the enable command is sent.

The parent process of an update is the previous release, and it reads the manifests of the new commit. So the formats of
`feature.json` and `state.json` must stay readable by the parser of the previous release: a field it requires keeps its
type, and new data goes into new optional fields that the old parser ignores.

Claude Code on the server is on the `stable` channel: it lags by about 8 days. In development mode it is on `latest`, so a
breakage of the internal mechanisms the hub relies on is most likely seen there earlier.

Auto-update applies everything that landed in `main`. The protection: a GitHub account with two-factor authentication and
`rig check` with rollback.

## Hub connection

The hub and `rig` are different applications. The hub requires `rig` and does not duplicate its logic. The contract below
is common to both: `rig` and the hub can be built by different agents.

**The `telegram-hub` plugin.** Claude Code reads the plugin straight from the hub clone (in `plugin list --json` it has
`readFromFolder`; verified on Claude Code 2.1.314, `plugin update` answers "nothing to update. Edits there take effect at
the next session start or /reload-plugins"). A new hub commit reaches new Claude sessions without a command; an already
open window holds the loaded code until it restarts or runs `/reload-plugins`. Rollback works the same way. The hub version
is stored in `plugin/package.json` and read from the commit under check; the rig version is stored in the root
`package.json` and is also read from the commit. `rig` takes the hub marketplace name from
`<hub>/.claude-plugin/marketplace.json` and does not hard-code it: the hub may rename it, and `rig` brings the state to the
new name by removing the old identifier and installing the new one.

**Commands.** The hub itself accepts `/feature`, `/feature <name> enable|disable`, `/rig status|update` and
`/rig language en|ru` from users in `allowFrom`, calls `rig` and shows the output. The messages do not pass through an
agent. If `rig` is not found, the hub answers that it is missing. The hub shows the `rig` output as it arrives. The lock
waiting line (see "Commands") arrives at the moment the wait starts, not at the end of the command. The hub does not parse
this text and does not tell the waiting line from the rest of the output.

**Feature state.** The hub learns it with the command `rig feature --json` at start and on the event `features-changed`.
`rig` does not touch the hub configuration. The commands `/pwsh` and `/cmd`, when the feature is off, answer how to turn it
on.

**Language.** The hub reads the language with `rig language --json` at start and on the event `language-changed`, and shows
its own messages (replies, buttons, prompts) in that language. `/rig language en|ru` from a user in `allowFrom` calls `rig`
and shows its output, like `/rig status|update`. The hub does not store the language itself; the single owner is `rig`
(see "Language").

**JSON contract.** `rig feature --json` prints an array of features; each has exactly the fields `name`, `description`,
`enabled` and `platformAllowed`. `description` is a plain string in the current language. `enabled` is the saved state flag,
`platformAllowed` shows availability on the current OS. `rig status --json` prints an object of version `schemaVersion: 1`
with the fields `mode`, `versions`, `releases`, `features`, `lastUpdate`, `pendingHubRestart` and `errors`. `versions`
contains `rig` and `hub` (a commit string or `null`); `features` uses the same array format as `rig feature --json`;
`releases` contains `rig` and `hub` (a version string from the corresponding commit or `null`). The rig version is taken
from the root `package.json`, the hub version from `plugin/package.json` in the hub clone. `lastUpdate` is the last update
event or `null`; `pendingHubRestart` is the saved state value or `null`; `errors` is an array of objects
`{type, time, text}`. The order of feature elements is set by the manifest name, and the order of object keys is fixed by
the CLI. The hub parses these fields, not the human-readable output. `rig language --json` prints the object
`{"language":"en"}` with `"en"` or `"ru"`.

**Events.** `rig` appends lines to `~/.agent-rig/events.jsonl` in one write operation. One line is one JSON:
`{"id":"...","time":"ISO 8601","level":"info|warn|error","type":"...","text":"text for the human"}`.
Types: `update-ok`, `update-skipped`, `update-failed`, `rollback`, `feature-new`, `features-changed`, `language-changed`,
`setting-kept`, `block-restored`, `hub-restart-pending`, `hub-restart-waiting`. The hub reads the file from the place
recorded in `~/.agent-rig/events.offset`, sends `text` to the common topic, with a sound by `level`, and updates the offset.
It handles the service types `features-changed`, `language-changed` and `hub-restart-pending` itself. While the hub is off,
events wait in the file. Only `rig` may shrink the file: it clears it entirely when the file has grown and been read to the
end. No lock with the hub is needed for this: an offset past the end of the file is treated by the hub as shrinking, and it
reads from the start.

**Service.** On Linux it is the systemd user service `telegram-hub.service`, on Windows the Task Scheduler task
`telegram-hub`. It is installed by the hub script; `rig` only starts, stops and checks it.
`~/.agent-rig/hub-restarting.json`: `{"time":"ISO 8601"}`. `~/.agent-rig/hub-ready.json`:
`{"commit":"<full hash>","time":"ISO 8601"}`.

**Turning Telegram off.** `/feature telegram disable` is allowed, with confirmation by a button. The hub sends the command
to turn it back on (`rig feature telegram enable` on the server) and runs `rig`. The hub service is stopped by the last
step, so `rig` must live to the end even when its parent, the hub, exits. Otherwise the turn-off would break off in the
middle.

## Server install

The human: logs into the server as a non-root user, installs Claude Code on the `stable` channel, signs in to the account
and tells the agent "Deploy this here" with a link to the repository. Then follows the one list from the agent: the bot, the
supergroup with topics, the token, the Codex login, a message in the group. The human enters tokens and logins themselves;
they do not reach the agent's chat.

The agent, following `INSTALL.md`: prepares the system with the script `scripts/prepare-server.sh` (packages, `cron`,
linger, the channel permission; if `sudo` asks for a password, the human runs the script), clones both repositories into
`~/.agent-rig`, runs `rig install`, prepares the hub config and gives the human one list; it stops before that only if
`sudo` asks for a password or the channel permission file is already taken. The hub does not start without a token, so the
agent starts the service after the list. The group ID and the human's ID it takes from the hub log, by a random group name
from the list: a stranger with the bot in their own group does not know it. At the end it checks `rig status` and reports:
done, or what the human still has to do, with exact commands.

The install agent talks to the human in the human's language. `rig` itself stays English after install; the final list
tells how to change the language: `rig language en|ru` in the terminal or `/rig language en|ru` in Telegram.

tmux is a program that keeps the terminal on the server after an SSH disconnect. The hub starts sessions from a topic in it.

## Development mode

Mode `dev` is for the one who develops `rig` itself on Windows with Git Bash: the working copy is also the live install.
Hooks run from it, so switching a branch changes the live setup at once: this is a deliberate decision. The update here is
an ordinary `git pull` and `rig apply`, there is no auto-update, and the hub is restarted by the hub script
`scripts/restart-hub.ps1`.

`rig install --dev` turns on mode `dev` and takes the clone paths from the current directory; if desired, `volunteers`,
`pwsh`, `cmd` are enabled in it.

If rules and hooks are already written by hand, they are moved to `rig` entries like this:
1. A copy of `~/.claude` and `~/.codex`.
2. The text that `rig` now brings is removed from the main files, by the tables above. The personal stays.
3. `rig install --dev`; entries matching `rig` are accepted as its own by the ownership rules.
4. A before-and-after comparison: the set of rule sections and the normalized `settings.json`. All differences are printed
   as a list, and the human confirms them.

## Publication

Both repositories are public, license MIT.

## Checks

Done when everything passed:
1. Docker, clean Ubuntu 24.04: `rig install` from scratch, `rig check` green.
2. Turning each feature on and off: rules, hooks and settings change, a repeated `apply` changes nothing.
3. Foreign `settings.json` keys, the `CLAUDE.md` text and the `AGENTS.md` text outside the block do not change at either
   `apply` or update. A deleted import line returns, a changed value stays, broken markers are repaired without losing text.
4. Update: a new commit is applied; a broken one is rolled back and no longer applied; a fix on top of it is applied.
5. A new feature arrives off, enabled ones stay enabled.
6. The hub did not come up after a restart: both repositories roll back.
7. Two commands at once: the second waits for the end of the first, files are not corrupted. A killed process leaves no lock.
8. Reflection and the Codex wrapper start on Linux with a fake `claude` and `codex`.
9. Real Claude in a container, a test bot: a topic, a reply, `/bash`, `/feature`, a session started from a topic, the update
   event.
10. A scan of the whole history of both repositories is clean.
11. After moving existing manual rules and hooks to `rig` entries, rules and settings match the previous ones, apart from the
    confirmed differences.
12. Default English: on a fresh state (no `language` field) `rig status`, `rig feature`, `rig language` and the event texts are
    English, and `rig language --json` prints `{"language":"en"}`.
13. Language switch: `rig language ru` changes the output, feature descriptions and the text of the new event to Russian and
    emits `language-changed`; `rig language ru` again emits nothing; `rig language en` returns everything to English; the hub
    follows the switch (at start and on the event) and accepts `/rig language en|ru` from `allowFrom` users only.
14. `rig status --json` and `rig feature --json` keep the contract (the same fields and key order in both languages; no new
    field in `rig status --json`; `description` is a string).
15. No Russian text in the code outside the `ru` catalog and the `translations` of the manifests.
16. Every `feature.json` in the repository has a string `description` (the previous release must be able to read it).

Item 9 requires the developer to create a test bot and sign in to Claude once in the container.

## Decisions

Decisions made: one repository, `rig` without a service, the hub depends on `rig`, the composition of the base and features,
volunteers off in the common repository, personal rules local, updates from `main`, once an hour, rollback on failure, new
features off, both repositories public, events in the common topic, features for the whole machine, `disable` only turns
off, in mode `dev` the working copy is the live install, English by default, Russian by one shared setting, MIT, `stable`
on the server, changes in one clone stop the update entirely, the rollback returns both repositories, a hub that did not
come up counts as a failure, the generated rules are attached through `@` and survive an edit of the main files,
`/feature telegram disable` from Telegram is allowed, personal skills, hooks and the status line are not part of `rig`, the
hub waits for idleness without limit, `rig` installs programs without root itself, a deleted entry returns, rule sections
not included in the base stay personal, the hub check every 5 minutes, each new commit is tried once, commands wait for the
end of an update, at `disable` a changed entry is removed with a copy kept, a minimal set of `settings.json` keys,
addressing the user informally in the shared base rules (in any language with a formal and an informal "you"), new commits are applied while the hub
waits for idleness, the hub is called telegram-hub everywhere, there is no short name, agent replies follow the user's
language and not the setting, the install agent talks to the human in the human's language, and `rig` stays English after
install.

Implementation: Bun/TS for `rig`; paths and the file format in `~/.agent-rig`; events through a file; `/bash` is part of
`telegram`; a block with markers in `AGENTS.md`; the shared rules stay in `AGENTS.md` so that Claude does not read them
twice; 5 minutes for the hub to come up; copying agents and skills into `~/.claude`; a changed entry of an enabled feature
stays with the human; accepting matching entries; one message catalog with `en` and `ru` for everything `rig` shows the human.

# agent-rig

`rig` assembles a working environment for Claude Code and Codex: shared rules, hooks, plugins and programs. The environment is built from features: each one can be turned on or off with one command.

The repository is for anyone who works with Claude Code and Codex on several machines and wants their settings to match and to update themselves. Your personal rules stay yours.

`rig` does not keep a background process. It is a command on Bun and TypeScript with no runtime dependencies (`package.json` has only dev packages: type checking and one test guard (`typescript-api`, TypeScript 5 under another name)). All paths and settings live in `~/.agent-rig/`.

`rig session list` lists recorded Claude Code sessions with their liveness and module availability.
`rig session compact <id> [--instructions <text>]` compacts a live session and returns raw token counts or a hook skip.
`rig session rename <id> <name...>` renames a live session and returns the name reported by its window.
`rig session stop <id>` compacts a large context if needed and stops the session.
`rig session cleanup <id>` compacts, stops, and clears remembered skills from the transcript.
`rig session autocompact <id> <N|auto>` sets the session's auto-compact window, as `/autocompact` does in its terminal.
`rig session run <id> [--mode <mode>] [--account <n>]` resumes a stopped session in a new terminal using a command built by rig for the platform: Windows Terminal (`wt.exe`, with `cswap` if found) on Windows, Terminal.app on macOS, `x-terminal-emulator` on Linux when `DISPLAY` or `WAYLAND_DISPLAY` is set, otherwise a detached `tmux` (install it on a server). With none of these the error is `launch-unavailable`. There is no launch template to configure.
`rig session mode <id> <mode>` changes a session's permission mode, restarting it when needed.
`rig exec start <shell> --cwd <dir>` starts the command read from stdin in a detached runner.
`rig exec start rig -- <rig arguments>` runs one of rig's own commands (`update`, `feature`, `language`, ...) the same way, so the run outlives the caller; `exec`, `exec-runner` and `update-step` are refused.
`rig exec status <id> [--from <byte offset> [--wait <ms>]]` reads a bounded log chunk and the run's state; for a rig run that has ended it also returns `result`, the JSON object rig printed. With `--wait` the call returns as soon as the log has new bytes past the offset or the run has ended, and at the latest after `<ms>`.
`rig exec stop <id>` stops a run and its process tree.
`rig exec list` lists runs newest first.
Runs are stored in `~/.agent-rig/exec`. On Windows a detached start leaves the job of the caller (for example the hub's Scheduled Task): first with `CREATE_BREAKAWAY_FROM_JOB`, and when the job forbids it, through a broker that `powershell` starts with WMI `Win32_Process.Create`. Nothing needs to be installed or configured for this.

Installing on a server is described in [INSTALL.md](INSTALL.md). Agent, you were asked to deploy this here: read `INSTALL.md` and follow its section "What the agent does".

## Features

A feature is a set of rules, hooks, plugins and programs under one name. The feature `base` is always on and cannot be turned off. The descriptions come from the manifests `base/feature.json` and `features/*/feature.json`. `base` also installs rig's own Claude Code plugin `agent-rig-window` from `plugins/agent-rig-window` of the clone (the in-window module).

| Feature | Default | Platforms | What it does |
| --- | --- | --- | --- |
| `base` | always on | Linux, Windows, macOS | Base rules and hooks. |
| `reflection` | on | Linux, Windows, macOS | Reflection after Claude Code turns. |
| `analysis-gate` | off | Linux, Windows, macOS | Requires a fresh `.tmp/analysis.md` (sections `## Unknowns` and `## Class`, valid 30 minutes) before agent launches and time estimates: Agent launches without it are blocked, and the reflection (if on) flags an estimate named without it. |
| `subagent-tasks-guard` | on | Linux, Windows, macOS | Blocks a subagent from reporting or ending while a background task it started (Monitor, background Bash, background Agent) is still alive: the refusal names the tasks and asks to stop them with TaskStop. The main session is never guarded. |
| `codex` | on | Linux, Windows, macOS | Delegating tasks through Codex. Works on every account. Projects where it must not be used are listed in `~/.agent-rig/project-denylist.json`: `{"codex": ["<project dir>"], "volunteers": ["<project dir>"]}` (the `volunteers` key is shared with that feature). A missing file or key means no restriction; in a listed project or below it (the session's own directory, not a job's `cwd:`) the launcher refuses `start` and `reply` and the session gets a hint not to use Codex. |
| `telegram` | on | Linux, Windows, macOS | Integration with the Telegram hub. |
| `rtk` | on | Linux, Windows, macOS | Shortening tool output with RTK. |
| `superpowers` | on | Linux, Windows, macOS | The Superpowers plugin. |
| `skills` | on | Linux, Windows, macOS | Reusable Claude Code skills. |
| `js-ts-rules` | off | Linux, Windows, macOS | JavaScript and TypeScript conventions. |
| `volunteers` | off | Windows only | Delegating routine work to volunteer models. Allowed folders are listed in `~/.agent-rig/volunteer-projects.json`: `{"allowed": ["<folder>"]}`. Works on every account; projects where volunteers must not be used are listed under the `volunteers` key of `~/.agent-rig/project-denylist.json` (`{"codex": ["<project dir>"], "volunteers": ["<project dir>"]}`); a missing file or key means no restriction. |
| `pwsh` | off | Windows only | PowerShell command in the Telegram hub (needs `telegram`). |
| `cmd` | off | Windows only | Command Prompt command in the Telegram hub (needs `telegram`). |

Default values apply only at the first install. New features that appear in updates stay off until you turn them on.

## Commands

- `rig install [--dev]` installs rig: features, programs, plugins, the `rig` command. On a server also two crontab entries. With `--dev` it installs developer mode.
- `rig apply` rebuilds the rules, hooks and settings from the enabled features.
- `rig feature` prints the list of features and their state as JSON.
- `rig feature <name> enable` and `rig feature <name> disable` turn a feature on and off. Turning off removes hooks, rules, settings, plugins, and also the agent and skill files copied into `~/.claude`; if you changed an entry, the changed value stays in a `*.bak-<date>` copy. Programs, logins and data stay.
- `rig update` fetches the fresh `main` of both repositories and applies it. `rig update --pending` checks whether the hub restarted after an update.
- `rig status` prints, as JSON, the mode, versions, the state of features, the last update and errors.
- `rig check` verifies that the install is intact and the hooks run.
- `rig language` shows the current language; `rig language en|ru` switches rig and the Telegram bot between English and Russian. English is the default.
- `rig info --session <id>` prints one JSON object with the raw readings for that session: Claude limits (the freshest reading among sessions of the same account), Codex and volunteer limits when those features are on and the account is allowed, and the context. The client formats it; errors are `{"error":{"code","message"}}` with exit code 1.
- `rig help` prints the list of commands as JSON.

## Updates and rollback

On a server cron runs `rig update` every hour. It fetches `main` of the `agent-rig` and hub repositories and applies them as one pair. If `rig check` fails after applying, `rig` returns both clones to the previous pair, remembers the failed one and writes an event to `~/.agent-rig/events.jsonl`. It does not try that pair again.

If one of the clones has local changes or local commits, or a clone is not on `main`, the update is skipped, the clone is not touched, and one message with the reason arrives. If the hub did not confirm the restart within 5 minutes, `rig` rolls back: the check runs by cron every 5 minutes, so the rollback happens 5-10 minutes after the hub restart. `rig apply` and `rig check` of the new code run in a separate process: if it crashed or failed to start, `rig` rolls back too. External commands (`git`, `claude plugin`) are stopped after 15 minutes. In developer mode the update is unavailable.

Cron log: `~/.agent-rig/update.log`.

## Personal rules

Write your own rules in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` as usual. Rig manages only its own pieces:

- in `~/.codex/AGENTS.md` it is the block between `<!-- rig:begin -->` and `<!-- rig:end -->`;
- in `~/.claude/CLAUDE.md` it is two import lines: `@../.codex/AGENTS.md` and `@../.agent-rig/generated/CLAUDE.md`;
- in `~/.claude/settings.json` rig changes only the keys it wrote itself.

Everything else in these files rig does not touch and keeps on every apply and update.

## Development

1. Clone `agent-rig` and next to it `claude-telegram-hub` (the hub must be at `../claude-telegram-hub` relative to the project root).
2. In the `agent-rig` clone run `bun install`, then `bun run src/cli.ts install --dev`.
3. Check the install: `rig check`.

Raise the version in `package.json` in the same commit that changes what the user sees.

If the clone is in `.worktrees/`, the project root is the directory above `.worktrees/`. Tests run with `bun test`, types are checked by `bun run typecheck`. Tests in Docker are run by `scripts/test-docker.sh`. The live check of `rig session rename`, `compact` and `cleanup` against a real headless Claude Code session (it calls a model and costs a few cents) is skipped by `bun test` and runs only as `RIG_LIVE=1 bun test tests/live`.

## Scripts

- `scripts/prepare-server.sh` does the only install step that needs root: packages, `cron`, linger, the channel permission.
- `scripts/test-docker.sh` builds the Ubuntu 24.04 image `agent-rig-ubuntu-24.04-tests` and runs the scenarios from `tests/docker/` in it. One scenario runs by a prefix of its file name: `scripts/test-docker.sh 04`.
- `scripts/plugin-fingerprint.ts` records the content fingerprint of each plugin under `plugins/` (`.claude-plugin/content-hash`). Claude Code caches a plugin by its version, so `tests/plugin-version-guard.test.ts` fails when shipped content changed without a version bump; bump `version` in `plugin.json` by hand, then run `bun scripts/plugin-fingerprint.ts`.

## License

MIT. The text is in the file [LICENSE](LICENSE).

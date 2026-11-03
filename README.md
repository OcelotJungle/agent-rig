# agent-rig

`rig` assembles a working environment for Claude Code and Codex: shared rules, hooks, plugins and programs. The environment is built from features: each one can be turned on or off with one command.

The repository is for anyone who works with Claude Code and Codex on several machines and wants their settings to match and to update themselves. Your personal rules stay yours.

`rig` does not keep a background process. It is a command on Bun and TypeScript with no runtime dependencies (`package.json` has only dev packages for type checking). All paths and settings live in `~/.agent-rig/`.

Installing on a server is described in [INSTALL.md](INSTALL.md). Agent, you were asked to deploy this here: read `INSTALL.md` and follow its section "What the agent does".

## Features

A feature is a set of rules, hooks, plugins and programs under one name. The feature `base` is always on and cannot be turned off. The descriptions come from the manifests `base/feature.json` and `features/*/feature.json`.

| Feature | Default | Platforms | What it does |
| --- | --- | --- | --- |
| `base` | always on | Linux, Windows, macOS | Base rules and hooks. |
| `reflection` | on | Linux, Windows, macOS | Reflection after Claude Code turns. |
| `codex` | on | Linux, Windows, macOS | Delegating tasks through Codex. |
| `telegram` | on | Linux, Windows, macOS | Integration with the Telegram hub. |
| `rtk` | on | Linux, Windows, macOS | Shortening tool output with RTK. |
| `superpowers` | on | Linux, Windows, macOS | The Superpowers plugin. |
| `skills` | on | Linux, Windows, macOS | Reusable Claude Code skills. |
| `js-ts-rules` | off | Linux, Windows, macOS | JavaScript and TypeScript conventions. |
| `volunteers` | off | Windows only | Delegating routine work to volunteer models. Allowed folders are listed in `~/.agent-rig/volunteer-projects.json`: `{"allowed": ["<folder>"]}`. |
| `pwsh` | off | Windows only | PowerShell command in the Telegram hub (needs `telegram`). |
| `cmd` | off | Windows only | Command Prompt command in the Telegram hub (needs `telegram`). |

Default values apply only at the first install. New features that appear in updates stay off until you turn them on.

## Commands

- `rig install [--dev]` installs rig: features, programs, plugins, the `rig` command. On a server also two crontab entries. With `--dev` it installs developer mode.
- `rig apply` rebuilds the rules, hooks and settings from the enabled features.
- `rig feature` shows the list of features and their state; `rig feature --json` does the same in JSON.
- `rig feature <name> enable` and `rig feature <name> disable` turn a feature on and off. Turning off removes hooks, rules, settings, plugins, and also the agent and skill files copied into `~/.claude`; if you changed an entry, the changed value stays in a `*.bak-<date>` copy. Programs, logins and data stay.
- `rig update` fetches the fresh `main` of both repositories and applies it. `rig update --pending` checks whether the hub restarted after an update.
- `rig status` shows the mode, versions, the state of features, the last update and errors; `rig status --json` does the same in JSON.
- `rig check` verifies that the install is intact and the hooks run.
- `rig language` shows the current language; `rig language en|ru` switches rig and the Telegram bot between English and Russian. English is the default.
- `rig help` prints the list of commands.

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

If the clone is in `.worktrees/`, the project root is the directory above `.worktrees/`. Tests run with `bun test`, types are checked by `bun run typecheck`. Tests in Docker are run by `scripts/test-docker.sh`.

## Scripts

- `scripts/prepare-server.sh` does the only install step that needs root: packages, `cron`, linger, the channel permission.
- `scripts/test-docker.sh` builds the Ubuntu 24.04 image `agent-rig-ubuntu-24.04-tests` and runs the scenarios from `tests/docker/` in it. One scenario runs by a prefix of its file name: `scripts/test-docker.sh 04`.
- `scripts/verify-rules-verbatim.py` (run: `python -I -X utf8 scripts/verify-rules-verbatim.py`) compares the rule pieces of the enabled features with the live `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` when moving manual rules to rig entries. It compares against the English rule texts, so live rules written in another language are reported as differences.

## License

MIT. The text is in the file [LICENSE](LICENSE).

# Installing rig on a server

This file is read by an AI agent on the server. The human installs Claude Code and starts the agent. After that the agent works alone and, once, gives the human a short list of actions that only the human can do.
The human enters tokens, passwords and login codes only in a terminal or in a browser. They are never pasted into the chat with the agent.

Target system: Ubuntu 24.04 (other Linux systems with `apt` work too, the package names are the same).

What rig is: the `rig` program assembles the rules, hooks and plugins of Claude Code and Codex from a set of features and updates them by cron every hour. Details are in `README.md`.

## What the human does

1. Log in to the server as a regular user, not root. If you only have root, create a user and switch to it:
   `adduser rig && usermod -aG sudo rig && su - rig`
2. Install Claude Code on the `stable` channel:
   `sudo apt-get update && sudo apt-get install -y curl ca-certificates && curl -fsSL https://claude.ai/install.sh | bash -s stable`
   The default channel (`latest`) may bring an unstable version. If the installer did not write `autoUpdatesChannel`, `rig install` writes `stable` itself.
3. Run `~/.local/bin/claude`, sign in through the link in the browser, and write to the agent (any language works):
   `Deploy this here: https://github.com/OcelotJungle/agent-rig`

After that the agent works alone and at the end gives a short list of what has to be done by hand.

## What the agent does

Do the steps in order, one action at a time. After each step, check its success criterion. If the check fails, see the section "If a step fails" and do not go on.

Work alone. Do not ask questions and do not stop for the human. Collect everything you need from the human into one list in step 8. Before that you may ask only for what step 1 names directly: without it you cannot go on.

Language. Talk to the human in the language the human wrote in, including the list in step 8 and the report in step 13. The texts for the human in this file (the step 8 list, the step 13 report) are English templates: render them in the human's language, keeping commands, paths, tokens and the group title unchanged. Rig itself stays English after the install. Never switch the language of rig or of the Telegram bot yourself: only tell the human how to do it (the last line of the step 8 list and of the step 13 report).

### Step 1. System preparation

Check that you are not root: `test "$(id -u)" -ne 0`. If you are root, stop the install and ask the human to do the first step of the human's list.

This command needs root rights:

`curl -fsSL https://raw.githubusercontent.com/OcelotJungle/agent-rig/main/scripts/prepare-server.sh | sudo bash -s -- "$USER"`

Check `sudo -n true`. Exit code 0: run the command yourself. Otherwise you cannot go on without the human, because the following steps fail without the packages: ask the human to run this command in a second terminal window and to write that it is done.

What the script does: installs packages, starts `cron`, enables linger (user services work without an open SSH session) and writes `/etc/claude-code/managed-settings.json`. The script can be run again.

The `managed-settings.json` file allows only the `telegram-hub` plugin from channels and applies to all users of the server. Without it Claude Code asks to confirm the channel on every session start. The hub starts the session in a detached tmux, where nobody can answer, so a session from a topic would not connect. If the file already exists and does not contain this permission, the script changes nothing and prints the keys that are needed: ask the human to add them and run the script again.

Why each package is needed:

- `git`: rig clones and updates two repositories, reads versions, installs plugin marketplaces. `rig check` verifies it is present.
- `python3`: the hooks of the features `base`, `reflection`, `codex` run through python; `rig check` requires the `python3` interpreter.
- `bash`: the feature `base` checks it; `rig check` runs `base/hooks/project-tmp.sh`.
- `cron`: on a server `rig install` puts entries into `crontab` and stops without it. On Linux `rig check` verifies it is present.
- `tmux`: needed by the hub (Claude Code sessions); on Linux `rig check` verifies it is present.
- `unzip`, `curl`, `ca-certificates`: the Bun installer and HTTPS downloads.
- `nodejs`: Codex installed through Bun starts as `#!/usr/bin/env node`; without `node` the `codex` command does not work (`/usr/bin/env: 'node': No such file or directory`). Version 18 from the Ubuntu 24.04 repository is enough.

Success criterion: the command finished with exit code 0, and `git --version`, `python3 --version`, `tmux -V` and `node --version` print versions. `command -v crontab` finds the program (`crontab` has no `-V` flag), `systemctl is-active cron` prints `active`, `loginctl show-user "$USER" -p Linger` prints `Linger=yes`, the file `/etc/claude-code/managed-settings.json` exists.

### Step 2. Program directory and PATH

Commands:

`mkdir -p "$HOME/.local/bin"`

`echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"`

`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`

The last command works only in the current shell. Rig writes PATH into cron at install time, so run `rig install` (step 6) from a shell where `claude`, `bun` and `~/.local/bin` are already in PATH.

Success criterion: `command -v claude` prints the path to `claude`. If it does not, Claude Code is not installed or is outside PATH: ask the human to repeat the second step of the human's list.

### Step 3. Bun

Bun is needed before `rig`: `rig` runs as `bun run …/src/cli.ts`. Install:

`curl -fsSL https://bun.com/install | bash`

The installer puts Bun into `~/.bun/bin`. You do not need to install the dependencies of rig: it has no npm packages.

Success criterion: `bun --version` prints a version.

### Step 4. Clone rig

`git clone https://github.com/OcelotJungle/agent-rig.git "$HOME/.agent-rig/repo"`

Success criterion: the file `~/.agent-rig/repo/src/cli.ts` exists.

### Step 5. Clone the hub

Clone the hub before `rig install`: rig connects the `telegram-hub` plugin from this directory.

`git clone https://github.com/OcelotJungle/claude-telegram-hub.git "$HOME/.agent-rig/hub"`

Success criterion: the directory `~/.agent-rig/hub/.git` exists.

### Step 6. Install rig

The `rig` command does not exist yet, so the first time run it through Bun:

`bun run "$HOME/.agent-rig/repo/src/cli.ts" install`

What the command does: applies the features that are enabled by default, installs missing programs (Codex through `bun add --global @openai/codex`, rtk from a GitHub release into `~/.local/bin`), installs Claude Code plugins, creates the command `~/.local/bin/rig` and two crontab entries. If `~/.claude/settings.json` has no `autoUpdatesChannel` key, it writes `stable` into it. `rig install` does not run `rig check` itself.

If some system packages are missing, the command prints lines of the form `Install the system package <name>: <command>`. Run these commands and run `rig install` again: the install is repeatable.

If there is no `crontab`, the command prints "The crontab program was not found. Install the package with: sudo apt-get install cron". Install the package and run the install again. By this moment the `rig` command has already been created.

Success criterion: the last line of the output is "rig installation on the server is complete.", exit code 0. Also check `command -v rig` (it must find `~/.local/bin/rig`) and `crontab -l`: it has two lines with the marks `# agent-rig-update-hourly` and `# agent-rig-update-pending`.

### Step 7. Hub preparation

All hub files are in `~/.claude/channels/telegram-hub/`.

**7.1. Directory.** `mkdir -p "$HOME/.claude/channels/telegram-hub"`. You do not need to install the hub dependencies by hand: before every start the service runs `bun install --frozen-lockfile` itself.

**7.2. Starting sessions from a topic.** Create `config.json` with a `launch` section. This is plain Claude; the hub fills in `{session}`, `{cwd}` and `{mode}` itself:

`python3 -c 'import json,os;p=os.path.expanduser("~/.claude/channels/telegram-hub/config.json");json.dump({"launch":{"command":["tmux","new-session","-d","-s","claude-{session}","-c","{cwd}","--","claude","--channels","plugin:telegram-hub@telegram-hub","--resume","{session}","{mode}"],"timeoutSec":90}},open(p,"w"),indent=2)'`

The part of the plugin name after `@` (`telegram-hub`) must match `name` in `~/.agent-rig/hub/.claude-plugin/marketplace.json`. Check: `grep -m1 '"name"' ~/.agent-rig/hub/.claude-plugin/marketplace.json` prints `"name": "telegram-hub"`.

Success criterion: `test -s "$HOME/.claude/channels/telegram-hub/config.json"`.

### Step 8. List for the human

You cannot go on without the human: the hub does not start without a bot token, and only the human can create the bot and log in to Codex. Invent a group title: `python3 -c 'import secrets;print("rig-"+secrets.token_hex(3))'`. In step 9 it proves that a message came from the human's group: a stranger can add the bot to their own group but does not know the title, and getting into `allowFrom` means getting a shell on the server.

Send one message, substituting the title for `GROUP_TITLE`, and wait for the reply (render the message in the human's language; commands stay as they are):

```
I have done everything I could. 6 actions are left, about 5 minutes:

1. Write the command /newbot to @BotFather and create a bot. Save the token, do not send it to me.
2. Create a Telegram supergroup titled GROUP_TITLE. Turn on Topics in it, add the bot and make it an administrator.
3. Open a second terminal window on this server and run the command. It asks for the token, which is not visible as you type:
`( umask 077; read -rs -p "Bot token: " T; printf 'TELEGRAM_BOT_TOKEN=%s\n' "$T" > "$HOME/.claude/channels/telegram-hub/.env" )`
4. In the same place run the command, open the address from its output and enter the code:
codex login --device-auth
5. Write any message in the group.
6. Write me "done".

The group title can be changed later. Do not send me tokens or codes.
To change the language of rig and the Telegram bot (English or Russian): `rig language en|ru` in the terminal or `/rig language en|ru` in the bot's topic.
```

### Step 9. Service and access

You do not read or print the token. Only check that it exists: `test -s "$HOME/.claude/channels/telegram-hub/.env"`.

**9.1. Service.** From the hub directory:

`cd "$HOME/.agent-rig/hub" && bash scripts/install-hub-service.sh`

The script writes the file `telegram-hub.service`, enables and starts the service and creates `~/.claude/channels/telegram-hub/service-managed`. The unit already has a PATH with `~/.local/bin` and `~/.bun/bin`, so `bun`, `claude` and `rig` are available to the hub; `tmux` is taken from `/usr/bin`. If the script prints `the user systemd bus did not appear in 30s`, ask the human to run `sudo apt-get install -y dbus-user-session`, log in again, and run the script again.

Success criteria: `systemctl --user is-active telegram-hub.service` prints `active`, and `grep -q "polling Telegram as" ~/.claude/channels/telegram-hub/hub.log` finds the line. If instead there is `no TELEGRAM_BOT_TOKEN` or `bot token rejected`, the token was entered wrongly: ask the human to repeat the command with the token and run `systemctl --user restart telegram-hub.service`. If `getMe failed (Unable to connect...)`, `api.telegram.org` is not reachable from the server. If `getUpdates 409 Conflict`, someone else uses the same bot, usually the official telegram plugin. Diagnostics: `journalctl --user -u telegram-hub.service -n 50`.

**9.2. Access.** The hub receives the human's message from the group at start. Find its line in the log, substituting the group title:

`grep 'ignored update from chat .*(supergroup "GROUP_TITLE")' ~/.claude/channels/telegram-hub/hub.log | tail -1`

The line looks like this: `ignored update from chat -100… (supergroup "GROUP_TITLE"), sender 123…: …`. The number after `chat` is the group ID, the number after `sender` is the human's ID. They are not secret. Write them down, substituting the numbers for `GROUP_ID` and `USER_ID`:

`python3 -c 'import json,os,sys;p=os.path.expanduser("~/.claude/channels/telegram-hub/config.json");c=json.load(open(p));c["groupId"]=sys.argv[1];c["allowFrom"]=[sys.argv[2]];json.dump(c,open(p,"w"),indent=2)' GROUP_ID USER_ID`

The hub rereads `config.json` on every message, so the service does not need a restart.

If there is no suitable line, look at all of them: `grep "ignored update from chat" ~/.claude/channels/telegram-hub/hub.log | tail -5`. The value in parentheses is not `supergroup`: Topics are not enabled in the group, ask the human to enable them and write again. A different title: do not use other people's lines, ask the human to check the group title and write again. No lines at all: Telegram does not deliver the group's messages to the bot; the bot must be an administrator of the group (or in @BotFather `/setprivacy` → the bot → `Disable`, then remove the bot from the group and add it again).

If the log has `delivery to session … is blocked`, the bot has no right to write to the group or `config.json` has the wrong `groupId`. If the session does not connect within `timeoutSec` afterwards (90 seconds in step 7.2), the topic reports it and names the attach command. See what is written in tmux: `tmux attach -t claude-<session id>`.

### Step 10. Check

`rig check`

Run it only after step 9: while the `telegram-hub` service does not exist, `rig check` prints "The telegram-hub service is not running." and exits with code 1. This is not an install error of rig, it is the missing step 9.

What it checks: the rig block in `~/.codex/AGENTS.md`, the file `~/.agent-rig/generated/CLAUDE.md`, both import lines in `~/.claude/CLAUDE.md`, parsing of `~/.claude/settings.json`, the presence of python and of the programs of enabled features (including `git`, and on Linux `cron` and `tmux`), running every hook with a test event (the exit code must be 0) and the work of the `telegram-hub` service, if the feature `telegram` is enabled.

Success criterion: the last line is "rig checks passed." and the exit code is 0.

### Step 11. Status

`rig status`

Success criterion: there is a line `Mode: server`, `agent-rig:` and `hub:` show versions and full commit hashes in parentheses (or only the hash if the version is unknown), and features are listed as `Feature <name>: enabled` or `Feature <name>: disabled`. Lines `Error <type>: <text>` at the end mean errors from `~/.agent-rig/events.jsonl` recorded after the last successful update; older ones remain only in the file.

### Step 12. Codex login

`codex login status`

Success criterion: the command says the login is done, exit code 0. Without a login it prints "Not logged in" and exits with code 1. If the flag `--device-auth` from the list is not accepted, run `codex login --help`, choose a login variant without a local browser and give the human the exact command.

### Step 13. Report to the human

Finish the install with one message, in the human's language. If all conditions from the section "The install is done when" are met:

`Done: rig <version>, hub <version>, rig check passed. Write /rig status in the General topic of your group: the bot will answer.`

If something is not done, write instead a block `What is left for you to do:` and a numbered list. In each item say what happened, the exact command and where to run it. Do not list what you can finish yourself: finish it.

Add this last line to either variant of the message:

```
To change the language of rig and the Telegram bot (English or Russian): `rig language en|ru` in the terminal or `/rig language en|ru` in the bot's topic.
```

## If a step fails

A system package is missing. It shows as the line `Install the system package <name>: <command>` during `rig install` or `rig feature <name> enable`, and in `rig check` as the line "The system package <name> was not found. Run: <command>". Run the given command and repeat the step.

A program is not found. `rig check` writes "The program <name> was not found; run rig install.". Run `rig install` again.

`rig check` prints all problems as a list, one per line, not only the first. Fix all of them, run `rig check` again.

A hook failed. The line "The hook <feature>/<event> exited with code …". Check that `python3` and `bash` are available in PATH.

"The telegram-hub service is not running." This is expected until step 9 is done (`rig install` does not run the check, and only step 9 installs the service). If the step is done, see `systemctl --user status telegram-hub.service`, `journalctl --user -u telegram-hub.service -n 50` and `~/.claude/channels/telegram-hub/hub.log`; the reading of log lines (`no TELEGRAM_BOT_TOKEN`, `bot token rejected` and others) is given in step 9.1.

A rig error. Any error is printed as "rig error: …", exit code 1.

Where the logs and events are:

- cron update log: `~/.agent-rig/update.log`;
- rig events (updates, rollbacks, feature changes, errors): `~/.agent-rig/events.jsonl`;
- state: `~/.agent-rig/state.json`.

An update is skipped if one of the clones has local changes or local commits, or a clone is not on `main` (`git -C ~/.agent-rig/repo status`, the same for `~/.agent-rig/hub`); the clone is not touched. If the hub did not report readiness after an update, rig rolls both clones back 5-10 minutes after its restart (the limit is 5 minutes, the check runs by cron every 5 minutes). After a failed check rig rolls both clones back to the previous pair of commits and remembers the failed pair so as not to repeat it.

## The install is done when

1. `rig check` prints "rig checks passed." with exit code 0.
2. `rig status` shows `Mode: server` and known commits for `agent-rig` and `hub`.
3. `crontab -l` contains the entries `# agent-rig-update-hourly` and `# agent-rig-update-pending`.
4. `systemctl --user is-active telegram-hub.service` prints `active`.
5. `codex login status` says the login is done.
6. The hub `config.json` contains `groupId` and `allowFrom`.

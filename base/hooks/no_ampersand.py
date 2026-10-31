"""PreToolUse hook for Bash: refuses a command that starts something in the background with `&` (or `& disown`).
A run started so survives unseen and goes beside its restart (memory no-ampersand-background); background runs go
through the tool's run_in_background only. `&&`, `&>`, `>&`, `2>&1` and `&` inside quotes are not background starts."""
import json
import re
import sys

QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
BACKGROUND = re.compile(r"(?<![&|><])&(?![&>])")

# A bare interpreter reading its script from stdin (`python -`, `python` alone, `node -`): with no script piped in it
# waits forever and the call hangs, also with a `2>/dev/null` after it; scripts are written to a file and run by path
STDIN_SCRIPT = re.compile(r"(?:^|[;&|(]\s*)(?:python3?|py|node|bun)(?:\s+-[IuBE]+)*(?:\s+-)?(?:\s*[0-9]?[<>]+\s*\S+)*\s*(?:$|[;&|)])")

# A monitor that picks the file it watches by `ls -t` takes whatever was written last, not the run's own output; it
# watches the explicit tasks/<task id>.output instead
NEWEST_FILE = re.compile(r"\bls\s+(?:-\w*\s+)*-\w*t")

# A heredoc (`<<EOF`, `<<'EOF'`, `<<-EOF`) is banned outright (CLAUDE.md "No heredocs"): a `python - <<'X'` slips past
# STDIN_SCRIPT (text after the heredoc's line) and hangs the call. Read on the raw command: the quotes are part of the
# form
HEREDOC = re.compile(r"(?<!<)<<(?!<)-?\s*['\"]?[A-Za-z_]\w*")

# Killing processes by image name hits every session's processes of that name: a
# `taskkill //F //IM bun.exe` also kills the telegram-hub hub and the plugin of every open window, which then stay cut off
# from Telegram. Kill by PID or by a command-line match instead. Read on the raw command (a name may be quoted) and on the
# scripts it runs by path, where agents put the same commands
KILL_BY_NAME = re.compile(
    r"\btaskkill\b[^\n;&|]*?(?:/{1,2}|-)im\b"
    r"|\b(?:stop-process|spps|kill)\b[^\n;|]*?\s-(?:process)?name\b"
    r"|\bget-process\s+(?!-id\b)[^\n;|]*\|\s*(?:stop-process|spps|kill)\b"
    r"|\bkillall\b"
    r"|\bpkill\b(?![^\n;&|]*\s-\w*f)"
    r"|\bwmic\b[^\n]*\bname\s*=[^\n]*\b(?:delete|terminate)\b",
    re.I,
)
SCRIPT_PATH = re.compile(r"(?:^|[\s'\"=])([^\s'\"]+\.(?:ps1|sh|bat|cmd))\b", re.I)


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def kills_by_name(command):
    """Whether the command, or a script it names by path, kills processes by image name."""
    if KILL_BY_NAME.search(command):
        return True
    for path in SCRIPT_PATH.findall(command):
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if KILL_BY_NAME.search(text):
            return True
    return False


data = json.load(sys.stdin)
tool_input = data.get("tool_input") or {}
command = tool_input.get("command") or ""
bare = QUOTED.sub("''", command)
if data.get("tool_name") == "Monitor" and NEWEST_FILE.search(command):
    deny("A monitor must not pick its file by `ls -t` (the newest file is often another task's): watch the run's own "
         "explicit path, tasks/<task id>.output from the run_in_background reply.")
elif data.get("tool_name") == "Bash" and HEREDOC.search(command):
    deny("Heredocs are banned (CLAUDE.md \"No heredocs\"): Write the text or script to a file and pass its path.")
elif data.get("tool_name") == "Bash" and kills_by_name(command):
    deny("Killing processes by image name (taskkill /IM, Stop-Process -Name, Get-Process <name> | Stop-Process, pkill "
         "without -f, killall, wmic ... name=... delete) also kills other sessions' processes of that name, such as the "
         "telegram-hub hub and every window's plugin. Kill by PID (`taskkill //F //PID <n>`, `Stop-Process -Id <n>`) or by a "
         "command-line match (Get-CimInstance Win32_Process | Where-Object CommandLine -like '*<your run>*' | "
         "ForEach-Object { Stop-Process -Id $_.ProcessId }).")
elif BACKGROUND.search(bare):
    deny("A background start with `&` is refused: use run_in_background (memory no-ampersand-background).")
elif STDIN_SCRIPT.search(bare):
    deny("An interpreter with no script (`python -` or bare `python`) waits on stdin and hangs: write the script to a file and run it by path.")

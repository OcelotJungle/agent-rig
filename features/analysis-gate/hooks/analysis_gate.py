"""PreToolUse gate: deny an Agent launch of the main session while the project's analysis file is not valid.

Validity is decided by analysis_file.check(); this script only reads the hook payload and answers.
A call made inside a subagent is allowed. The hook input carries `agent_id` only for a subagent's call
("agent_id and agent_type ... identify the subagent", https://code.claude.com/docs/en/hooks, common input fields).
A read-only launch is allowed without the file: the agent types in READ_ONLY_AGENT_TYPES, and a `codex` launch
whose header has the line `mode: read-only` (the header is the lines before the first `task:` line, as the codex
relay reads it). Every other launch is gated, a `mode: read-only` line after `task:` included.
A payload that is not a JSON object, or whose `cwd` is not a string, allows the call and prints nothing,
so a malformed payload never blocks the session. Stdlib only.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import analysis_file  # resolved next to this script by the path insert above

AGENT_TOOL = "Agent"
HOOK_EVENT = "PreToolUse"
# Agent types with no file-editing tools: they only look things up, so a launch needs no analysis file.
READ_ONLY_AGENT_TYPES = ("Explore", "Plan", "claude-code-guide", "web-fetch")
CODEX_AGENT_TYPE = "codex"
CODEX_TASK_PREFIX = "task:"
CODEX_MODE_PREFIX = "mode:"
CODEX_READ_ONLY_LINE = "mode: read-only"


def codex_header_is_read_only(prompt):
    # Matches the header lines the codex relay reads: stripped of surrounding whitespace, exact text, case as written.
    # Read-only only when the header has a mode line and every mode line says read-only: a header that also says
    # `mode: write` could run a writing job, so it is gated.
    if not isinstance(prompt, str):
        return False
    modes = []
    for raw_line in prompt.splitlines():
        line = raw_line.strip()
        if line.startswith(CODEX_TASK_PREFIX):
            break
        if line.startswith(CODEX_MODE_PREFIX):
            modes.append(line)
    return len(modes) > 0 and all(mode == CODEX_READ_ONLY_LINE for mode in modes)


def is_read_only_launch(tool_input):
    if not isinstance(tool_input, dict):
        return False
    subagent_type = tool_input.get("subagent_type")
    if not isinstance(subagent_type, str):
        return False
    if subagent_type in READ_ONLY_AGENT_TYPES:
        return True
    return subagent_type == CODEX_AGENT_TYPE and codex_header_is_read_only(tool_input.get("prompt"))


def decision(payload, now):
    # Returns the deny output, or None to allow the call.
    if not isinstance(payload, dict) or payload.get("tool_name") != AGENT_TOOL:
        return None
    if payload.get("agent_id"):
        return None
    cwd = payload.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        return None
    if is_read_only_launch(payload.get("tool_input")):
        return None
    ok, reason = analysis_file.check(analysis_file.project_root(payload), now)
    if ok:
        return None
    return {
        "hookSpecificOutput": {
            "hookEventName": HOOK_EVENT,
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except ValueError:
        return 0
    output = decision(payload, time.time())
    if output is not None:
        print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())

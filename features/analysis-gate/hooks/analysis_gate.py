"""PreToolUse gate: deny an Agent launch of the main session while the project's analysis file is not valid.

Validity is decided by analysis_file.check(); this script only reads the hook payload and answers.
A call made inside a subagent is allowed. The hook input carries `agent_id` only for a subagent's call
("agent_id and agent_type ... identify the subagent", https://code.claude.com/docs/en/hooks, common input fields).
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


def decision(payload, now):
    # Returns the deny output, or None to allow the call.
    if not isinstance(payload, dict) or payload.get("tool_name") != AGENT_TOOL:
        return None
    if payload.get("agent_id"):
        return None
    cwd = payload.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
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

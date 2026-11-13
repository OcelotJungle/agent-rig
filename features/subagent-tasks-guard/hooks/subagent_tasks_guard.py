"""Guard: a subagent may not report or stop while a background task it started is still alive.

Two registrations of this one script:
- PreToolUse on `SubagentHandback`: the report is delivered before the subagent stops, so the refusal has to come
  first. The hook input has no task list, so liveness comes from the subagent transcript (started minus stopped minus
  terminally notified). Output: a `deny` decision.
- SubagentStop: the harness's own `background_tasks` list says what still runs. Output: exit code 2 and the refusal
  on stderr, which the subagent receives as its next instruction.
The main session (no `agent_id` in the input) is never guarded: its monitors legitimately live between turns.
A missing or unreadable transcript, a malformed payload or any failure of the guard itself allows and prints nothing.
Decision logic is in subagent_tasks.py. Stdlib only.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import subagent_tasks  # resolved next to this script by the path insert above

HANDBACK_TOOL = "SubagentHandback"
EVENT_STOP = "SubagentStop"
EVENT_PRE_TOOL = "PreToolUse"
BLOCK_EXIT_CODE = 2


def transcript_path(payload, agent_id):
    # SubagentStop names the subagent's transcript; otherwise it sits at <main dir>/<session_id>/subagents/agent-<id>.jsonl
    # next to the main transcript, which every hook input carries.
    own = payload.get("agent_transcript_path")
    if isinstance(own, str) and own:
        return Path(own)
    main = payload.get("transcript_path")
    session = payload.get("session_id")
    if isinstance(main, str) and main and isinstance(session, str) and session:
        return Path(main).parent / session / "subagents" / f"agent-{agent_id}.jsonl"
    return None


def read_tasks(path):
    # None when the transcript cannot be read.
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return subagent_tasks.scan(handle)
    except OSError:
        return None


def live_tasks(payload, read=read_tasks):
    # The live (id, info) pairs of the calling subagent, or [] to allow.
    if not isinstance(payload, dict):
        return []
    agent_id = payload.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        return []
    event = payload.get("hook_event_name")
    if event == EVENT_PRE_TOOL and payload.get("tool_name") != HANDBACK_TOOL:
        return []
    if event not in (EVENT_STOP, EVENT_PRE_TOOL):
        return []
    path = transcript_path(payload, agent_id)
    tasks = read(path) if path is not None else None
    if tasks is None:
        return []
    if event == EVENT_STOP:
        return subagent_tasks.live_by_background_list(tasks, payload.get("background_tasks"), agent_id)
    return subagent_tasks.live_by_transcript(tasks)


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        live = live_tasks(payload)
    except Exception:  # the guard's own failure never blocks a subagent
        return 0
    if not live:
        return 0
    text = subagent_tasks.refusal(live)
    if payload.get("hook_event_name") == EVENT_STOP:
        # Bytes, not print: a hook inherits the console encoding, which on Windows is not UTF-8.
        sys.stderr.buffer.write((text + "\n").encode("utf-8"))
        sys.stderr.flush()
        return BLOCK_EXIT_CODE
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": EVENT_PRE_TOOL,
            "permissionDecision": "deny",
            "permissionDecisionReason": text,
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())

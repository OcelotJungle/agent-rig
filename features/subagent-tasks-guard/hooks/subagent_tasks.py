"""Pure core of the subagent background-task guard: read a subagent transcript, decide which of its tasks are alive.

No I/O here: the transcript arrives as an iterable of JSONL lines. Shapes (Claude Code subagent transcripts, every
record has `isSidechain` and `agentId`):
- a background Bash/PowerShell result record carries `toolUseResult.backgroundTaskId` (a foreground call that outlived
  its timeout is moved to the background and carries it too);
- a Monitor result record carries `toolUseResult.taskId`;
- a background Agent result record carries `toolUseResult.isAsync: true` and `toolUseResult.agentId`;
- a TaskStop call is a `tool_use` named `TaskStop` with `input.task_id`;
- a finished task arrives as `type: "attachment"` with `attachment.commandMode == "task-notification"` and XML in
  `attachment.prompt`; only a notification with `<status>` is terminal (a Monitor event notification has none).
Stdlib only.
"""
import json
import re

BASH_TOOLS = ("Bash", "PowerShell")
MONITOR_TOOL = "Monitor"
AGENT_TOOL = "Agent"
TASK_STOP_TOOL = "TaskStop"
KIND_SHELL = "shell"
KIND_MONITOR = "monitor"
KIND_AGENT = "agent"
RUNNING = "running"
NOTIFICATION_MODE = "task-notification"
LABEL_LIMIT = 200
BACKGROUND_TEXT = re.compile(r"Command running in background with ID:\s*([A-Za-z0-9_-]+)")
NOTIFICATION = re.compile(r"<task-notification>(.*?)</task-notification>", re.DOTALL)
TASK_ID = re.compile(r"<task-id>\s*([^<\s]+)\s*</task-id>")
TASK_STATUS = re.compile(r"<status>\s*[^<\s]")


def _label(use):
    # What the refusal shows next to a task id: the call's description, or its command.
    tool_input = use.get("input")
    if not isinstance(tool_input, dict):
        return ""
    for key in ("description", "command"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value[:LABEL_LIMIT]
    return ""


def _blocks(record):
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def _result_text(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def _task_id_of(tool, result, text):
    # The id of the background task a tool result started, or None.
    if tool in BASH_TOOLS:
        value = result.get("backgroundTaskId")
        if isinstance(value, str) and value:
            return value, KIND_SHELL
        found = BACKGROUND_TEXT.search(text)
        return (found.group(1), KIND_SHELL) if found else (None, None)
    if tool == MONITOR_TOOL:
        value = result.get("taskId")
        return (value, KIND_MONITOR) if isinstance(value, str) and value else (None, None)
    if tool == AGENT_TOOL:
        value = result.get("agentId")
        return (value, KIND_AGENT) if result.get("isAsync") is True and isinstance(value, str) and value else (None, None)
    return None, None


class Tasks:
    """What a subagent transcript says about the background tasks it started."""

    def __init__(self):
        self.owned = {}  # task id -> {"kind": ..., "label": ...}
        self.stopped = set()  # ids given to a TaskStop call
        self.finished = set()  # ids with a terminal task notification
        self._uses = {}  # tool_use id -> {"name": ..., "label": ...}

    def feed(self, record):
        if not isinstance(record, dict):
            return
        kind = record.get("type")
        if kind == "assistant":
            self._feed_uses(record)
        elif kind == "user":
            self._feed_results(record)
            self._feed_user_text(record)
        elif kind == "attachment":
            self._feed_notification(record.get("attachment"))

    def _feed_uses(self, record):
        for block in _blocks(record):
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if name == TASK_STOP_TOOL:
                tool_input = block.get("input")
                target = tool_input.get("task_id") if isinstance(tool_input, dict) else None
                if isinstance(target, str) and target:
                    self.stopped.add(target)
            elif name in BASH_TOOLS or name in (MONITOR_TOOL, AGENT_TOOL):
                identifier = block.get("id")
                if isinstance(identifier, str):
                    self._uses[identifier] = {"name": name, "label": _label(block)}

    def _feed_results(self, record):
        result = record.get("toolUseResult")
        result = result if isinstance(result, dict) else {}
        for block in _blocks(record):
            if block.get("type") != "tool_result":
                continue
            use = self._uses.get(block.get("tool_use_id"))
            if use is None:
                continue
            task_id, task_kind = _task_id_of(use["name"], result, _result_text(block))
            if task_id is not None:
                self.owned[task_id] = {"kind": task_kind, "label": use["label"]}

    def _feed_notification(self, attachment):
        if not isinstance(attachment, dict) or attachment.get("commandMode") != NOTIFICATION_MODE:
            return
        self._finish_from_text(attachment.get("prompt"))

    def _feed_user_text(self, record):
        # A notification may also arrive wrapped in a user message (seen in main transcripts); tool results are skipped,
        # since their text is output that may merely quote a notification.
        message = record.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            self._finish_from_text(content)
        for block in _blocks(record):
            if block.get("type") == "text":
                self._finish_from_text(block.get("text"))

    def _finish_from_text(self, text):
        if not isinstance(text, str):
            return
        for body in NOTIFICATION.findall(text):
            found = TASK_ID.search(body)
            if found and TASK_STATUS.search(body):
                self.finished.add(found.group(1))


def scan(lines):
    # Streams the lines: a large transcript is never held in memory. A line that is not JSON is skipped.
    tasks = Tasks()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        tasks.feed(record)
    return tasks


def live_by_background_list(tasks, background_tasks, own_agent_id):
    # SubagentStop: the harness's own list is the truth; owned ids whose entry is still `running`.
    if not isinstance(background_tasks, list):
        return []
    live = []
    for entry in background_tasks:
        if not isinstance(entry, dict):
            continue
        identifier = entry.get("id")
        if identifier == own_agent_id or identifier not in tasks.owned or entry.get("status") != RUNNING:
            continue
        live.append((identifier, tasks.owned[identifier]))
    return live


def live_by_transcript(tasks):
    # SubagentHandback: no task list is given, so owned minus stopped minus terminally notified.
    return [(identifier, info) for identifier, info in tasks.owned.items()
            if identifier not in tasks.stopped and identifier not in tasks.finished]


def refusal(live):
    lines = ["You started background tasks that may still be running (a Monitor, a background Bash, a background Agent):"]
    for identifier, info in live:
        label = f": {info['label']}" if info["label"] else ""
        lines.append(f"- {identifier} ({info['kind']}){label}")
    lines.append("Stop each one with the TaskStop tool (task_id = the id above), then report again. "
                 "A task that already finished may still be listed; TaskStop on it is harmless.")
    return "\n".join(lines)

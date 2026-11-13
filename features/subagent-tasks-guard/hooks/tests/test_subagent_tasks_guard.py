"""Tests for the subagent background-task guard, run as a subprocess the way Claude Code runs a hook.

Transcripts are synthetic JSONL built from the shapes of real subagent transcripts (invented ids).
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "subagent_tasks_guard.py"
SESSION = "11111111-2222-3333-4444-555555555555"
AGENT = "aaaaaaaaaaaaaaaaa"
OTHER_AGENT = "bbbbbbbbbbbbbbbbb"
BLOCK_EXIT_CODE = 2
TIMEOUT_SECONDS = 60


def assistant(*uses):
    return {"type": "assistant", "isSidechain": True, "agentId": AGENT,
            "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": use_id, "name": name, "input": tool_input}
                for use_id, name, tool_input in uses]}}


def result(use_id, tool_result):
    return {"type": "user", "isSidechain": True, "agentId": AGENT, "toolUseResult": tool_result,
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": use_id, "content": "ok"}]}}


def notification(task_id, status=None):
    status_xml = f"<status>{status}</status>\n" if status else ""
    prompt = f"<task-notification>\n<task-id>{task_id}</task-id>\n{status_xml}<summary>x</summary>\n</task-notification>"
    return {"type": "attachment", "isSidechain": True, "agentId": AGENT,
            "attachment": {"type": "queued_command", "prompt": prompt, "commandMode": "task-notification"}}


def start_bash(use_id, task_id, command="sleep 200"):
    return [assistant((use_id, "Bash", {"command": command, "run_in_background": True})),
            result(use_id, {"stdout": "", "stderr": "", "backgroundTaskId": task_id})]


def start_monitor(use_id, task_id, description="watch the log"):
    return [assistant((use_id, "Monitor", {"command": "tail -F x", "description": description, "timeout_ms": 1000})),
            result(use_id, {"taskId": task_id, "timeoutMs": 1000, "persistent": False})]


def start_agent(use_id, task_id, description="child agent"):
    return [assistant((use_id, "Agent", {"description": description, "run_in_background": "true", "prompt": "x"})),
            result(use_id, {"isAsync": True, "status": "async_launched", "agentId": task_id, "description": description})]


def stop_task(use_id, task_id):
    return [assistant((use_id, "TaskStop", {"task_id": task_id})),
            result(use_id, {"message": "Successfully stopped task", "task_id": task_id})]


class SubagentTasksGuardTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.main_transcript = self.root / f"{SESSION}.jsonl"
        self.own_transcript = self.root / SESSION / "subagents" / f"agent-{AGENT}.jsonl"
        self.own_transcript.parent.mkdir(parents=True)

    def write(self, records, raw_lines=()):
        lines = [json.dumps(record) for record in records] + list(raw_lines)
        self.own_transcript.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def run_hook(self, payload, env=None):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload).encode("utf-8"),
                                capture_output=True, timeout=TIMEOUT_SECONDS, env=env)
        return result.returncode, result.stdout.decode("utf-8"), result.stderr.decode("utf-8")

    def base(self, event, **fields):
        payload = {"session_id": SESSION, "transcript_path": str(self.main_transcript), "cwd": str(self.root),
                   "agent_id": AGENT, "agent_type": "general-purpose", "hook_event_name": event}
        payload.update(fields)
        return payload

    def stop(self, background_tasks, **fields):
        own = {"id": AGENT, "type": "subagent", "status": "running", "description": "me"}
        fields = {"stop_hook_active": False, **fields}
        return self.run_hook(self.base("SubagentStop", agent_transcript_path=str(self.own_transcript),
                                       background_tasks=[own] + background_tasks, **fields))

    def handback(self, **fields):
        return self.run_hook(self.base("PreToolUse", tool_name="SubagentHandback",
                                       tool_input={"message": "done"}, **fields))

    def assert_blocked(self, outcome, *fragments):
        code, stdout, stderr = outcome
        self.assertEqual(code, BLOCK_EXIT_CODE, stderr)
        self.assertEqual(stdout, "")
        self.assertIn("TaskStop", stderr)
        for fragment in fragments:
            self.assertIn(fragment, stderr)

    def assert_denied(self, outcome, *fragments):
        code, stdout, stderr = outcome
        self.assertEqual(code, 0, stderr)
        output = json.loads(stdout)
        specific = output["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "PreToolUse")
        self.assertEqual(specific["permissionDecision"], "deny")
        self.assertIn("TaskStop", specific["permissionDecisionReason"])
        for fragment in fragments:
            self.assertIn(fragment, specific["permissionDecisionReason"])

    def assert_allowed(self, outcome):
        code, stdout, stderr = outcome
        self.assertEqual((code, stdout, stderr), (0, "", ""))

    def running(self, task_id, kind="shell"):
        return {"id": task_id, "type": kind, "status": "running", "description": "d"}

    # SubagentStop

    def test_stop_with_a_live_owned_monitor_is_blocked_and_names_it(self):
        self.write(start_monitor("toolu_1", "mon00001", "watch the log"))
        self.assert_blocked(self.stop([self.running("mon00001")]), "mon00001", "watch the log")

    def test_a_non_ascii_label_is_written_as_utf8_whatever_the_console_encoding(self):
        # Windows hooks inherit a non-UTF-8 console encoding; a Cyrillic description must not crash the refusal.
        label = "слежу за логом"
        self.write(start_monitor("toolu_1", "mon00001", label))
        env = {**os.environ, "PYTHONIOENCODING": "ascii"}
        payload = self.base("SubagentStop", agent_transcript_path=str(self.own_transcript), stop_hook_active=False,
                            background_tasks=[self.running("mon00001")])
        self.assert_blocked(self.run_hook(payload, env), "mon00001", label)

    def test_stop_with_a_live_owned_background_agent_is_blocked(self):
        self.write(start_agent("toolu_1", "child0001", "child agent"))
        self.assert_blocked(self.stop([self.running("child0001", "subagent")]), "child0001", "child agent")

    def test_stop_stays_blocked_on_the_repeat_stop(self):
        self.write(start_bash("toolu_1", "bash0001"))
        self.assert_blocked(self.stop([self.running("bash0001")], stop_hook_active=True), "bash0001")

    def test_stop_is_allowed_once_the_task_is_no_longer_running(self):
        self.write(start_monitor("toolu_1", "mon00001") + stop_task("toolu_2", "mon00001"))
        self.assert_allowed(self.stop([]))
        self.write(start_monitor("toolu_1", "mon00001"))
        self.assert_allowed(self.stop([{"id": "mon00001", "type": "shell", "status": "completed"}]))

    def test_stop_follows_the_harness_list_even_when_the_transcript_shows_no_taskstop(self):
        self.write(start_bash("toolu_1", "bash0001") + [notification("bash0001", "completed")])
        self.assert_blocked(self.stop([self.running("bash0001")]), "bash0001")

    def test_stop_of_a_subagent_without_background_tasks_is_allowed(self):
        self.write([assistant(("toolu_1", "Read", {"file_path": "x"})), result("toolu_1", {"type": "text"})])
        self.assert_allowed(self.stop([]))

    def test_stop_ignores_running_tasks_of_the_main_session_and_other_agents(self):
        self.write(start_bash("toolu_1", "bash0001") + stop_task("toolu_2", "bash0001"))
        self.assert_allowed(self.stop([self.running("mainmon01"), self.running(OTHER_AGENT, "subagent")]))

    # SubagentHandback

    def test_handback_with_a_live_owned_bash_is_denied(self):
        self.write(start_bash("toolu_1", "bash0001", "sleep 200"))
        self.assert_denied(self.handback(), "bash0001", "sleep 200")

    def test_handback_with_a_live_owned_monitor_and_agent_names_both(self):
        self.write(start_monitor("toolu_1", "mon00001") + start_agent("toolu_2", "child0001"))
        self.assert_denied(self.handback(), "mon00001", "child0001")

    def test_handback_is_allowed_after_taskstop(self):
        self.write(start_bash("toolu_1", "bash0001") + stop_task("toolu_2", "bash0001"))
        self.assert_allowed(self.handback())

    def test_handback_is_allowed_after_a_terminal_notification(self):
        self.write(start_bash("toolu_1", "bash0001") + [notification("bash0001", "completed")])
        self.assert_allowed(self.handback())

    def test_a_terminal_notification_wrapped_in_a_user_message_is_a_finish(self):
        text = "<task-notification>\n<task-id>bash0001</task-id>\n<status>completed</status>\n</task-notification>"
        wrapped = {"type": "user", "isSidechain": True, "agentId": AGENT,
                   "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
        self.write(start_bash("toolu_1", "bash0001") + [wrapped])
        self.assert_allowed(self.handback())

    def test_a_monitor_event_notification_without_status_is_not_a_finish(self):
        self.write(start_monitor("toolu_1", "mon00001") + [notification("mon00001")])
        self.assert_denied(self.handback(), "mon00001")

    def test_one_stopped_one_live_names_only_the_live_one(self):
        self.write(start_bash("toolu_1", "bash0001") + start_bash("toolu_2", "bash0002") + stop_task("toolu_3", "bash0001"))
        code, stdout, _ = self.handback()
        reason = json.loads(stdout)["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("bash0002", reason)
        self.assertNotIn("bash0001", reason)

    def test_handback_without_background_tasks_is_allowed(self):
        self.write([assistant(("toolu_1", "Read", {"file_path": "x"})), result("toolu_1", {"type": "text"})])
        self.assert_allowed(self.handback())

    def test_a_foreground_bash_moved_to_the_background_is_owned(self):
        self.write([assistant(("toolu_1", "Bash", {"command": "sleep 900"})),
                    result("toolu_1", {"stdout": "", "backgroundTaskId": "bash0009", "timedOutAfterMs": 180000})])
        self.assert_denied(self.handback(), "bash0009")

    def test_a_result_of_another_tool_with_a_task_like_key_is_not_a_background_task(self):
        self.write([assistant(("toolu_1", "TaskCreate", {"subject": "x"})), result("toolu_1", {"taskId": "todo0001"})])
        self.assert_allowed(self.handback())

    # No guard

    def test_the_main_session_is_never_guarded(self):
        self.write(start_bash("toolu_1", "bash0001"))
        stop = {"session_id": SESSION, "transcript_path": str(self.main_transcript), "hook_event_name": "SubagentStop",
                "background_tasks": [self.running("bash0001")]}
        self.assert_allowed(self.run_hook(stop))
        handback = {"session_id": SESSION, "transcript_path": str(self.main_transcript), "hook_event_name": "PreToolUse",
                    "tool_name": "SubagentHandback"}
        self.assert_allowed(self.run_hook(handback))

    def test_other_tools_and_events_are_not_guarded(self):
        self.write(start_bash("toolu_1", "bash0001"))
        self.assert_allowed(self.run_hook(self.base("PreToolUse", tool_name="Bash", tool_input={"command": "ls"})))
        self.assert_allowed(self.run_hook(self.base("Stop")))

    def test_a_missing_transcript_allows(self):
        self.assert_allowed(self.stop([self.running("bash0001")]))
        self.assert_allowed(self.handback())

    def test_an_unreadable_or_malformed_transcript_allows_and_garbage_lines_are_skipped(self):
        self.write([], raw_lines=["not json", "[1, 2]", '{"type": "assistant", "message": 5}'])
        self.assert_allowed(self.handback())
        self.write(start_bash("toolu_1", "bash0001"), raw_lines=["not json"])
        self.assert_denied(self.handback(), "bash0001")

    def test_malformed_payloads_allow(self):
        for raw in (b"", b"not json", b"[]", b'{"agent_id": 5, "hook_event_name": "SubagentStop"}'):
            result = subprocess.run([sys.executable, str(SCRIPT)], input=raw, capture_output=True, timeout=TIMEOUT_SECONDS)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))

    def test_the_subagent_transcript_is_found_next_to_the_main_one_when_the_stop_input_has_no_path(self):
        self.write(start_bash("toolu_1", "bash0001"))
        payload = self.base("SubagentStop", stop_hook_active=False, background_tasks=[self.running("bash0001")])
        self.assert_blocked(self.run_hook(payload), "bash0001")


if __name__ == "__main__":
    unittest.main()

"""Tests for the Agent launch gate, run as a subprocess the way Claude Code runs a hook."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "analysis_gate.py"
FULL = "## Unknowns  \n- the cache policy\n\n## Class \nno defect: analysis gate\n"
MINUTE = 60
ANALYSIS_PATH_PARTS = (".tmp", "analysis.md")


class AnalysisGateTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.analysis = self.root.joinpath(*ANALYSIS_PATH_PARTS)

    def write(self, content, age=0):
        self.analysis.parent.mkdir(parents=True, exist_ok=True)
        self.analysis.write_bytes(content)
        stamp = time.time() - age
        os.utime(self.analysis, (stamp, stamp))

    def run_hook(self, stdin_bytes):
        env = dict(os.environ)
        env.pop("CLAUDE_PROJECT_DIR", None)
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=stdin_bytes,
            capture_output=True,
            env=env,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        return result.stdout.decode("utf-8")

    def launch(self, **fields):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "cwd": str(self.root),
                   "tool_input": {"subagent_type": "general-purpose", "prompt": "x"}}
        payload.update(fields)
        return self.run_hook(json.dumps(payload).encode("utf-8"))

    def assert_denied(self, stdout, *fragments):
        output = json.loads(stdout)
        self.assertEqual(list(output), ["hookSpecificOutput"])
        specific = output["hookSpecificOutput"]
        self.assertEqual(set(specific), {"hookEventName", "permissionDecision", "permissionDecisionReason"})
        self.assertEqual(specific["hookEventName"], "PreToolUse")
        self.assertEqual(specific["permissionDecision"], "deny")
        reason = specific["permissionDecisionReason"]
        self.assertIn(str(self.analysis), reason)
        for fragment in fragments:
            self.assertIn(fragment, reason)

    def test_launch_denied_without_file(self):
        self.assert_denied(self.launch(), "missing")

    def test_launch_denied_with_stale_file(self):
        self.write(FULL.encode(), age=31 * MINUTE)
        self.assert_denied(self.launch(), "stale, last written 31 min ago")

    def test_launch_denied_when_section_missing(self):
        self.write(b"## Unknowns\n- x\n")
        self.assert_denied(self.launch(), "section `## Class` missing")

    def test_launch_allowed_with_fresh_full_file(self):
        self.write(FULL.encode(), age=MINUTE)
        self.assertEqual(self.launch(), "")

    def test_every_subagent_type_is_gated(self):
        for subagent_type in ("Explore", "general-purpose", "security-reviewer"):
            with self.subTest(subagent_type=subagent_type):
                stdout = self.launch(tool_input={"subagent_type": subagent_type, "prompt": "x"})
                self.assert_denied(stdout, "missing")

    def test_non_agent_tool_allowed_without_file(self):
        self.assertEqual(self.launch(tool_name="Bash", tool_input={"command": "ls"}), "")

    def test_subagent_call_allowed_without_file(self):
        self.assertEqual(self.launch(agent_id="a1b2c3", agent_type="Explore"), "")

    def test_malformed_stdin_allowed_silently(self):
        for stdin_bytes in (b"not json", b"", b"[1, 2]", b"\xff\xfe\x00"):
            with self.subTest(stdin=stdin_bytes):
                self.assertEqual(self.run_hook(stdin_bytes), "")

    def test_non_string_cwd_allowed_silently(self):
        self.assertEqual(self.launch(cwd=5), "")


if __name__ == "__main__":
    unittest.main()

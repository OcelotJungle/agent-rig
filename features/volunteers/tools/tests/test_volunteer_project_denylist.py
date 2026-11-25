"""volunteer-run.py honours the project denylist (base/tools/project-denylist.py).

The launcher runs as a real subprocess with an injected home directory, so nothing touches the real ~ or its
denylist. The project directory of a run is the launcher's working directory. RIG_LAUNCHER_UNDER_TEST points the
tests at another copy of the launcher (used to prove that the refusal tests fail on the old code).
Run from the clone root: python -I -m unittest discover -s features/volunteers/tools/tests -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DEFAULT_SCRIPT = Path(__file__).resolve().parents[1] / "volunteer-run.py"
SCRIPT = Path(os.environ.get("RIG_LAUNCHER_UNDER_TEST") or DEFAULT_SCRIPT)
RUN_TIMEOUT_SECONDS = 60
CATEGORY = "volunteers"
REFUSAL_MARK = f"REFUSED: {CATEGORY} is not allowed in project"
HINT_MARK = "Volunteers are disabled"


class VolunteerProjectDenylistTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        self.denied = self.home / "projects" / "bloxels"
        self.denied_sub = self.denied / "src" / "deep"
        self.sibling = self.home / "projects" / "bloxels-backup-2026-11-06"
        self.other = self.home / "projects" / "other"
        for directory in (self.denied_sub, self.sibling, self.other):
            directory.mkdir(parents=True)
        config = self.home / ".agent-rig" / "project-denylist.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"codex": [str(self.denied)], "volunteers": [str(self.denied)]}), encoding="utf-8")
        self.prompt = self.home / "prompt.md"
        self.prompt.write_text("do nothing", encoding="utf-8")

    def run_launcher(self, cwd, *args, stdin=""):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
        env["USERPROFILE"] = env["HOME"] = str(self.home)
        env["VOLUNTEER_JOBS_DIR"] = str(self.home / "jobs")
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], env=env, capture_output=True, text=True,
                              timeout=RUN_TIMEOUT_SECONDS, cwd=str(cwd), input=stdin, encoding="utf-8", errors="replace")

    def test_start_is_refused_in_the_denied_project_and_below_it(self):
        for cwd in (self.denied, self.denied_sub):
            result = self.run_launcher(cwd, "start", "--prompt-file", str(self.prompt))
            self.assertNotEqual(result.returncode, 0, cwd)
            self.assertIn(REFUSAL_MARK, result.stderr)
            self.assertIn(str(self.denied), result.stderr)
            self.assertIn("project-denylist.json", result.stderr)

    def test_reply_is_refused_in_the_denied_project(self):
        result = self.run_launcher(self.denied_sub, "reply", "no-such-job", "--prompt-file", str(self.prompt))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(REFUSAL_MARK, result.stderr)

    def test_list_cancel_wait_attach_are_not_refused(self):
        for args in (("list",), ("cancel", "no-such-job"), ("wait", "no-such-job"), ("attach", "no-such-job")):
            result = self.run_launcher(self.denied, *args)
            self.assertNotIn("REFUSED", result.stderr + result.stdout, args)

    def test_other_projects_are_not_refused_by_the_denylist(self):
        # a sibling that only shares a name prefix and an unrelated project: the launcher goes on past the gate
        for cwd in (self.sibling, self.other):
            result = self.run_launcher(cwd, "reply", "no-such-job", "--prompt-file", str(self.prompt))
            self.assertNotIn("is not allowed in project", result.stderr, cwd)

    def test_a_job_cwd_into_the_denied_project_from_another_project_is_not_refused(self):
        # only the session's own project directory is gated, never the `cwd:` a job is asked to work in; with no
        # volunteer-projects.json in the test home `start` stops after the gate, so nothing is spawned
        result = self.run_launcher(self.other, "start", "--prompt-file", str(self.prompt), "--cwd", str(self.denied))
        self.assertIn("volunteer-projects", result.stderr)
        self.assertNotIn("is not allowed in project", result.stderr)

    def test_a_malformed_denylist_refuses_start_naming_the_file(self):
        (self.home / ".agent-rig" / "project-denylist.json").write_text("{oops", encoding="utf-8")
        result = self.run_launcher(self.other, "start", "--prompt-file", str(self.prompt))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("project-denylist.json", result.stderr)
        self.assertIn("malformed", result.stderr)

    def test_session_hint_is_emitted_only_in_a_denied_project(self):
        blocked = self.run_launcher(self.denied_sub, "session-hint")
        self.assertEqual(blocked.returncode, 0)
        payload = json.loads(blocked.stdout)["hookSpecificOutput"]
        self.assertEqual(payload["hookEventName"], "SessionStart")
        self.assertIn(HINT_MARK, payload["additionalContext"])
        for cwd in (self.sibling, self.other):
            self.assertEqual(self.run_launcher(cwd, "session-hint").stdout, "", cwd)

    def test_session_hint_takes_the_project_from_the_hook_input_cwd(self):
        denied_input = json.dumps({"cwd": str(self.denied), "hook_event_name": "SessionStart"})
        blocked = self.run_launcher(self.other, "session-hint", stdin=denied_input)
        self.assertIn(HINT_MARK, json.loads(blocked.stdout)["hookSpecificOutput"]["additionalContext"])
        allowed_input = json.dumps({"cwd": str(self.other), "hook_event_name": "SessionStart"})
        self.assertEqual(self.run_launcher(self.denied, "session-hint", stdin=allowed_input).stdout, "")


if __name__ == "__main__":
    unittest.main()

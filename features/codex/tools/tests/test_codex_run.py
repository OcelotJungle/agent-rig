"""Tests for codex-run.py: the run rules per platform, and a cancelled job stopping its children (POSIX only)."""
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "codex-run.py"
spec = importlib.util.spec_from_file_location("codex_run", SCRIPT)
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)

GIT_BASH_MARK = "Git Bash"
SANDBOX_MARK = "Sandbox limits"
# The job starts a child that outlives it unless the cancel kills the whole job's process group.
JOB_SCRIPT = """
import os, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open(sys.argv[1], "w") as f:
    f.write(f"{os.getpid()} {child.pid}")
time.sleep(600)
"""
# Readiness wait only: the fake clock below returns at once once the job has written its pids.
STARTUP_POLL_SECONDS = 0.01
# Bounds the wait for a job that does not stop; a job that stops returns at once.
JOB_STOP_TIMEOUT_SECONDS = 10
KILL_SIGNAL = 9
PROC_STAT = "/proc/{pid}/stat"
ZOMBIE_STATE = "Z"


def process_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    stat = Path(PROC_STAT.format(pid=pid))
    if stat.exists() and stat.read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0] == ZOMBIE_STATE:
        return False
    return True


class RunRulesTest(unittest.TestCase):
    def test_report_contract_in_prompt(self):
        self.assertIn("More work than expected is never a reason to stop", cr.run_rules(False))
        self.assertIn("Blocked by: for blocked", cr.run_rules(False))

    def test_report_validation(self):
        for report, expected in [("STATUS: done", ("done", None)),
                                 ("STATUS: question\nQuestions: choose A or B", ("question", None)),
                                 ("STATUS: blocked\nBlocked by: access", ("blocked", None))]:
            self.assertEqual(cr.validate_report(report), expected)
        for report, missing in [("text", "STATUS"), ("STATUS: partial", "status"),
                                ("STATUS: done extra", "status"),
                                ("STATUS: question\nQuestions: none", "Questions"),
                                ("STATUS: question\nQuestions:\nRisks: none", "Questions"),
                                ("STATUS: blocked\nBlocked by: none", "Blocked by"),
                                ("STATUS: blocked", "Blocked by")]:
            with self.subTest(report=report):
                self.assertIn(missing.lower(), cr.validate_report(report)[1].lower())

    def test_malformed_recovery_and_restart(self):
        for reports, prior, expected, calls in [(["bad", "STATUS: blocked\nBlocked by: access"], 0, "blocked", 2),
                                                 (["bad", "bad again"], 0, "malformed", 2),
                                                 (["bad again"], 1, "malformed", 1)]:
            with self.subTest(expected=expected, prior=prior), tempfile.TemporaryDirectory() as tmp:
                job = Path(tmp)
                cr.write_json(job / "state.json", {"cwd": tmp, "created": cr.now(), "notes": [],
                              "session_id": "session", "malformed_follow_ups": prior})
                sup = cr.Supervisor(job)
                prompts = []
                def run_once(text):
                    prompts.append(text)
                    (job / "last.md").write_text(reports[len(prompts) - 1], encoding="utf-8")
                    sup.saw_turn_completed = True
                    return None, 0
                with mock.patch.object(sup, "run_once", side_effect=run_once):
                    sup.run()
                state = cr.read_json(job / "state.json")
                self.assertEqual(state["status"], expected)
                self.assertEqual(len(prompts), calls)
                if calls == 2:
                    self.assertIn("STATUS", prompts[1])
                if expected == "malformed":
                    self.assertIn("STATUS", state["report_error"])

    def test_windows_rules_name_git_bash(self):
        self.assertIn(GIT_BASH_MARK, cr.run_rules(windows=True))

    def test_posix_rules_do_not_name_git_bash(self):
        rules = cr.run_rules(windows=False)
        self.assertNotIn(GIT_BASH_MARK, rules)
        self.assertNotIn("bash.exe", rules)

    def test_common_rules_stay_on_both_platforms(self):
        for windows in (True, False):
            self.assertIn(SANDBOX_MARK, cr.run_rules(windows=windows))


class TerraLineTest(unittest.TestCase):
    def test_terra_resolves_to_newest_model_at_its_floor(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-model-test-") as tmp:
            cache = Path(tmp) / "models_cache.json"
            cache.write_text(json.dumps({"models": [
                {"slug": "gpt-5.6-terra", "visibility": "list",
                 "supported_reasoning_levels": [{"effort": "high"}]},
                {"slug": "gpt-6.1-terra", "visibility": "list",
                 "supported_reasoning_levels": [{"effort": "high"}]},
            ]}), encoding="utf-8")
            with mock.patch.object(cr, "MODELS_CACHE", cache):
                self.assertEqual(cr.resolve_model("terra"), ("gpt-6.1-terra", ["high"]))
                cache.write_text(json.dumps({"models": [{
                    "slug": "gpt-5.6-terra", "visibility": "list",
                    "supported_reasoning_levels": [{"effort": "high"}],
                }]}), encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, "6.1"):
                    cr.resolve_model("terra")

    def test_usage_limit_ends_without_changing_the_model_line(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-limit-test-") as tmp:
            d = Path(tmp)
            cr.write_json(d / "state.json", {"job": "job1", "line": "sol", "slug": "gpt-6.1-sol",
                          "effort": "high", "cwd": tmp, "created": cr.now(), "notes": [],
                          "session_id": "session"})
            sup = cr.Supervisor(d)
            calls = []

            def usage_limit(text):
                calls.append(text)
                sup.error_text = "usage limit reached; try again at 11:39 PM."
                return None, 1

            with mock.patch.object(sup, "run_once", side_effect=usage_limit):
                sup.run()
            state = cr.read_json(d / "state.json")
            self.assertEqual(state["status"], "limit")
            self.assertEqual(state["limit_reset"], "11:39 PM")
            self.assertEqual((state["line"], state["slug"], state["effort"]), ("sol", "gpt-6.1-sol", "high"))
            self.assertEqual(len(calls), 1)

    def test_usage_limit_without_reset_time_has_null_reset(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-limit-test-") as tmp:
            d = Path(tmp)
            cr.write_json(d / "state.json", {"job": "job1", "line": "sol", "slug": "gpt-6.1-sol",
                          "effort": "high", "cwd": tmp, "created": cr.now(), "notes": [],
                          "session_id": "session"})
            sup = cr.Supervisor(d)
            def usage_limit(text):
                sup.error_text = "usage limit reached."
                return None, 1
            with mock.patch.object(sup, "run_once", side_effect=usage_limit):
                sup.run()
            state = cr.read_json(d / "state.json")
            self.assertEqual(state["status"], "limit")
            self.assertIsNone(state["limit_reset"])

    def test_usage_limit_parses_calendar_reset_time(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-limit-test-") as tmp:
            d = Path(tmp)
            cr.write_json(d / "state.json", {"job": "job1", "line": "sol", "slug": "gpt-6.1-sol",
                          "effort": "high", "cwd": tmp, "created": cr.now(), "notes": [],
                          "session_id": "session"})
            sup = cr.Supervisor(d)

            def usage_limit(text):
                sup.error_text = "usage limit reached; try again at Nov 6th, 2026 8:00 AM."
                return None, 1

            with mock.patch.object(sup, "run_once", side_effect=usage_limit):
                sup.run()
            self.assertEqual(cr.read_json(d / "state.json")["limit_reset"], "Nov 6th, 2026 8:00 AM")

    def start_terra(self, effort, approved):
        with tempfile.TemporaryDirectory(prefix="codex-run-start-test-") as tmp:
            root = Path(tmp)
            args = mock.Mock(model="terra", effort=effort, approved=approved,
                             prompt_file="unused", cwd=str(root), read_only=False)
            with mock.patch.multiple(
                    cr, JOBS_DIR=root / "jobs", resolve_model=mock.Mock(
                        return_value=("gpt-6.1-terra", list(cr.ALL_EFFORTS))),
                    take_prompt=mock.Mock(return_value="task"), cleanup_old_jobs=mock.Mock()), \
                    mock.patch.object(cr, "spawn_supervisor"), \
                    redirect_stdout(io.StringIO()):
                cr.cmd_start(args)

    def test_terra_effort_above_high_needs_approval(self):
        self.assertEqual(cr.FLOORS["terra"], (6, 1))
        args = mock.Mock(model="terra", effort="xhigh", approved=False)
        with self.assertRaisesRegex(SystemExit, "REFUSED"):
            cr.cmd_start(args)

    def test_terra_effort_above_high_is_allowed_with_approval(self):
        self.start_terra("xhigh", approved=True)

    def test_terra_effort_at_or_below_high_needs_no_approval(self):
        for effort in ("low", "medium", "high"):
            with self.subTest(effort=effort):
                self.start_terra(effort, approved=False)

    def test_default_model_is_terra(self):
        args_seen = []
        with mock.patch.object(sys, "argv", ["codex-run.py", "start", "--prompt-file", "prompt.md"]), \
                mock.patch.object(cr, "cmd_start", side_effect=lambda args: args_seen.append(args)):
            cr.main()
        self.assertEqual(args_seen[0].model, "terra")


FAKE_CODEX = Path(__file__).resolve().parent / "fake_codex.py"


class StartPathTest(unittest.TestCase):
    """Drives cmd_start and the supervisor with the module's real constants against a fake codex."""

    def test_started_job_runs_to_done_with_a_fake_codex(self):
        tmp = Path(tempfile.mkdtemp(prefix="codex-run-test-")).resolve()
        self.addCleanup(shutil.rmtree, tmp, True)
        cache = tmp / "models_cache.json"
        cache.write_text(json.dumps({"models": [{
            "slug": "gpt-6-luna", "visibility": "list",
            "supported_reasoning_levels": [{"effort": "high"}]}]}), encoding="utf-8")
        prompt = tmp / "prompt.md"
        prompt.write_text("do the task", encoding="utf-8")
        work = tmp / "work"
        work.mkdir()
        jobs = tmp / "jobs"
        real_command = cr.Supervisor.command

        def fake_command(sup, resume_text=None):
            cmd, stdin_text = real_command(sup, resume_text)
            return [sys.executable, "-I", str(FAKE_CODEX)] + cmd[1:], stdin_text

        args = mock.Mock(model="luna", effort="high", approved=False, prompt_file=str(prompt), cwd=str(work),
                         read_only=False)
        with mock.patch.multiple(cr, JOBS_DIR=jobs, MODELS_CACHE=cache, POLL_SECONDS=0.01), \
                mock.patch.object(cr, "spawn_supervisor") as spawn, \
                mock.patch.object(cr.Supervisor, "command", fake_command), \
                redirect_stdout(io.StringIO()):
            cr.cmd_start(args)
            job_dir = spawn.call_args.args[0]
            cr.Supervisor(job_dir).run()
        state = cr.read_json(job_dir / "state.json")
        self.assertEqual(state["status"], "done", state)
        self.assertIn("STATUS: done", (job_dir / "last.md").read_text(encoding="utf-8"))


STARTING_STALE_SECONDS = 100  # above the 60 s the wait gives a supervisor to start
REPLY_STATUSES = ("done", "question", "blocked", "malformed", "limit")
NOT_REPLYABLE_STATUSES = ("running", "starting", "cancelled", "orphaned")
BLOCKED_REPORT = "Stopped.\nSTATUS: blocked\nBlocked by: the access key is missing"
REPORT_TEXT = "Result in short.\nSTATUS: done\nDone: - the secret report body\nChanged files: a.py"


class JobLifecycleTest(unittest.TestCase):
    """cmd_wait, cmd_reply and the malformed counter across turns."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="codex-run-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.multiple(cr, JOBS_DIR=self.tmp, POLL_SECONDS=0.01)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_job(self, **fields):
        d = self.tmp / "job1"
        d.mkdir()
        state = {"job": "job1", "line": "luna", "slug": "gpt-6-luna", "effort": "high",
                 "read_only": False, "cwd": str(self.tmp),
                 "created": cr.now(), "notes": [], "session_id": "session"}
        state.update(fields)
        cr.write_json(d / "state.json", state)
        return d

    def wait(self, d, interval=0):
        out = io.StringIO()
        with redirect_stdout(out):
            cr.cmd_wait(mock.Mock(job="job1", interval=interval))
        return cr.read_json(d / "state.json"), out.getvalue()

    def test_wait_ends_a_job_whose_supervisor_died_as_blocked(self):
        d = self.make_job(status="running", supervisor_pid=None)
        state, out = self.wait(d)
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(state["error"], "supervisor process died")
        self.assertNotIn("still running", out)

    def test_wait_ends_a_job_whose_supervisor_never_started_as_blocked(self):
        d = self.make_job(status="starting", created=cr.now() - STARTING_STALE_SECONDS)
        state, out = self.wait(d, interval=STARTING_STALE_SECONDS)
        self.assertEqual(state["status"], "blocked")
        self.assertIn("supervisor did not start", state["error"])

    def test_reply_accepts_every_status_a_job_can_end_with_a_session(self):
        for status in REPLY_STATUSES:
            with self.subTest(status=status):
                d = self.make_job(status=status, error="old")
                with mock.patch.object(cr, "spawn_supervisor") as spawn, \
                        mock.patch.object(cr, "cmd_wait"), mock.patch.object(cr, "take_prompt", return_value="go"), \
                        redirect_stdout(io.StringIO()):
                    cr.cmd_reply(mock.Mock(job="job1", prompt_file="unused"))
                spawn.assert_called_once()
                self.assertEqual(cr.read_json(d / "state.json")["status"], "starting")
                self.assertIn("go", (d / "reply.md").read_text(encoding="utf-8"))
                shutil.rmtree(d)

    def test_reply_refuses_a_job_that_has_not_finished(self):
        for status in NOT_REPLYABLE_STATUSES:
            with self.subTest(status=status):
                d = self.make_job(status=status)
                with mock.patch.object(cr, "spawn_supervisor") as spawn, self.assertRaises(SystemExit):
                    cr.cmd_reply(mock.Mock(job="job1", prompt_file="unused"))
                spawn.assert_not_called()
                shutil.rmtree(d)

    def test_progress_digest_never_shows_a_message_with_the_report(self):
        d = self.make_job(status="running", started=cr.now())
        st = cr.read_json(d / "state.json")
        events = [{"type": "item.completed", "item": {"type": "agent_message", "text": text}}
                  for text in ("reading the tests", REPORT_TEXT)]
        progress = cr.digest(d, st, events, False)
        self.assertIn("reading the tests", progress)
        self.assertNotIn("secret report body", progress)
        self.assertNotIn("STATUS", progress)

    def final_digest(self, d):
        return cr.digest(d, cr.read_json(d / "state.json"), [], True)

    def test_final_digest_shows_the_report_of_every_report_outcome(self):
        for status in ("done", "question", "blocked", "malformed"):
            with self.subTest(status=status):
                d = self.make_job(status=status, started=cr.now(), ended=cr.now(), report_error="no STATUS line")
                (d / "last.md").write_text(BLOCKED_REPORT, encoding="utf-8")
                out = self.final_digest(d)
                self.assertIn("Blocked by: the access key", out)
                self.assertNotIn("error:", out)
                self.assertEqual("report problem: no STATUS line" in out, status == "malformed")
                shutil.rmtree(d)

    def test_final_digest_keeps_the_error_when_the_launcher_failed(self):
        d = self.make_job(status="blocked", started=cr.now(), ended=cr.now(), error="supervisor process died")
        (d / "last.md").write_text(BLOCKED_REPORT, encoding="utf-8")
        out = self.final_digest(d)
        self.assertIn("error: supervisor process died", out)
        self.assertNotIn("the access key", out)

    def test_final_digest_shows_shared_limit_reset_and_reply(self):
        d = self.make_job(status="limit", started=cr.now(), ended=cr.now(), error="usage limit reached",
                          limit_reset="11:39 PM")
        event = {"type": "item.completed", "item": {"type": "agent_message", "text": "Try again later."}}
        out = cr.digest(d, cr.read_json(d / "state.json"), [event], True)
        self.assertIn("usage limit (shared by all Codex models): resets at 11:39 PM; after the reset continue this job with reply: job1", out)
        self.assertIn("last codex message: Try again later.", out)
        self.assertNotIn("error:", out)

    def test_reply_after_limit_resumes_on_the_original_line_and_slug(self):
        d = self.make_job(status="limit", line="sol", slug="gpt-6.1-sol", effort="high",
                          limit_reset="Nov 6th, 2026 8:00 AM")
        commands = []
        with mock.patch.object(cr, "spawn_supervisor"), mock.patch.object(cr, "cmd_wait"), \
                mock.patch.object(cr, "take_prompt", return_value="continue"), redirect_stdout(io.StringIO()):
            cr.cmd_reply(mock.Mock(job="job1", prompt_file="unused"))
        sup = cr.Supervisor(d)

        def resumed(text):
            command, _ = sup.command(text)
            commands.append((sup.state["line"], sup.state["slug"], command))
            (d / "last.md").write_text("STATUS: done", encoding="utf-8")
            sup.saw_turn_completed = True
            return None, 0

        with mock.patch.object(sup, "run_once", side_effect=resumed):
            sup.run()
        state = cr.read_json(d / "state.json")
        self.assertEqual(state["status"], "done")
        self.assertEqual((commands[0][0], commands[0][1]), ("sol", "gpt-6.1-sol"))
        self.assertIn("gpt-6.1-sol", commands[0][2])

    def test_a_report_outcome_clears_a_stale_error(self):
        for report, status in [("STATUS: blocked\nBlocked by: the access key", "blocked"), ("bad", "malformed")]:
            with self.subTest(status=status):
                d = self.make_job(status="starting", error="supervisor process died", malformed_follow_ups=1)
                state, _ = self.run_supervisor(d, [report])
                self.assertEqual(state["status"], status)
                self.assertIsNone(state["error"])
                shutil.rmtree(d)

    def run_supervisor(self, d, reports):
        sup = cr.Supervisor(d)
        prompts = []

        def run_once(text):
            prompts.append(text)
            (d / "last.md").write_text(reports[len(prompts) - 1], encoding="utf-8")
            sup.saw_turn_completed = True
            return None, 0

        with mock.patch.object(sup, "run_once", side_effect=run_once):
            sup.run()
        return cr.read_json(d / "state.json"), prompts

    def test_a_reply_turn_gets_its_own_malformed_follow_up(self):
        d = self.make_job(status="starting", malformed_follow_ups=1)
        (d / "reply.md").write_text("the answer", encoding="utf-8")
        state, prompts = self.run_supervisor(d, ["bad", "STATUS: done"])
        self.assertEqual(len(prompts), 2)
        self.assertEqual(state["status"], "done")

    def test_a_second_malformed_report_in_a_reply_turn_ends_the_job(self):
        d = self.make_job(status="starting", malformed_follow_ups=1)
        (d / "reply.md").write_text("the answer", encoding="utf-8")
        state, prompts = self.run_supervisor(d, ["bad", "bad again"])
        self.assertEqual(len(prompts), 2)
        self.assertEqual(state["status"], "malformed")

    def test_a_restart_without_a_reply_keeps_the_malformed_counter(self):
        d = self.make_job(status="starting", malformed_follow_ups=1)
        state, prompts = self.run_supervisor(d, ["bad"])
        self.assertEqual(len(prompts), 1)
        self.assertEqual(state["status"], "malformed")


@unittest.skipIf(os.name == "nt", "the job's process group is a POSIX mechanism; Windows uses taskkill /T")
class CancelStopsJobChildrenTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="codex-run-test-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_cancel_stops_the_children_of_the_job(self):
        job = self.dir / "job"
        job.mkdir()
        pids_file = job / "pids.txt"
        self.addCleanup(self.kill_leftovers, pids_file)
        cr.write_json(job / "state.json", {
            "cwd": str(job), "created": cr.now(), "status": "starting", "restarts": 0, "notes": [],
        })
        sup = cr.Supervisor(job)
        cmd = [sys.executable, "-I", "-c", JOB_SCRIPT, str(pids_file)]
        sup.command = lambda resume_text=None: (cmd, None)
        real_sleep = time.sleep

        def cancel_once_job_is_up(seconds):
            # Stands in for the supervisor's poll wait: it cancels as soon as the job has its pids.
            if pids_file.exists():
                (job / "cancel").touch()
            else:
                real_sleep(STARTUP_POLL_SECONDS)

        outcome = {}
        worker = threading.Thread(target=lambda: outcome.update(reason=sup.run_once()[0]), daemon=True)
        with mock.patch.object(cr.time, "sleep", cancel_once_job_is_up):
            worker.start()
            worker.join(JOB_STOP_TIMEOUT_SECONDS)
        self.assertFalse(worker.is_alive(), "the cancelled job did not stop")
        self.assertEqual(outcome.get("reason"), "cancelled")
        job_pid, child_pid = (int(text) for text in pids_file.read_text(encoding="utf-8").split())
        self.assertFalse(process_alive(job_pid), "the job's own process survived the cancel")
        self.assertFalse(process_alive(child_pid), "a child of the job survived the cancel")

    def kill_leftovers(self, pids_file):
        if not pids_file.exists():
            return
        for text in pids_file.read_text(encoding="utf-8").split():
            if process_alive(int(text)):
                os.kill(int(text), KILL_SIGNAL)


if __name__ == "__main__":
    unittest.main()

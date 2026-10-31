"""Tests for codex-run.py: the run rules per platform, and a cancelled job stopping its children (POSIX only)."""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
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
    def test_windows_rules_name_git_bash(self):
        self.assertIn(GIT_BASH_MARK, cr.run_rules(windows=True))

    def test_posix_rules_do_not_name_git_bash(self):
        rules = cr.run_rules(windows=False)
        self.assertNotIn(GIT_BASH_MARK, rules)
        self.assertNotIn("bash.exe", rules)

    def test_common_rules_stay_on_both_platforms(self):
        for windows in (True, False):
            self.assertIn(SANDBOX_MARK, cr.run_rules(windows=windows))


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

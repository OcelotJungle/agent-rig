"""Guard process-tree ownership for launchers loading process-job.py by path."""
import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "process-job.py"
SPEC = importlib.util.spec_from_file_location("process_job", HELPER)
process_job = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(process_job)

# Bounds process startup and termination; polling only waits for observable state changes.
TIMEOUT_SECONDS = 10
POLL_SECONDS = 0.01
CHILD = r'''
import os, subprocess, sys
# Win32 CREATE_BREAKAWAY_FROM_JOB.
breakaway = 0x01000000
flags = 0
if os.name == "nt":
    flags = int(sys.argv[2])
try:
    child = subprocess.Popen([sys.executable, "-c", "import threading; threading.Event().wait()"],
                             creationflags=flags, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except OSError:
    if not flags & breakaway:
        raise
    child = subprocess.Popen([sys.executable, "-c", "import threading; threading.Event().wait()"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open(sys.argv[1] + ".tmp", "w") as output:
    output.write(str(child.pid))
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
'''
OWNER = r'''
import importlib.util, subprocess, sys, threading
spec = importlib.util.spec_from_file_location("process_job", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
proc, job = module.start([sys.executable, "-c", sys.argv[2], sys.argv[3], sys.argv[4]],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
proc.wait()
threading.Event().wait()
'''
POSIX_CHILD = r'''
import subprocess, sys, threading
grandchild = """import os,sys,threading
os.setsid()
with open(sys.argv[1] + '.tmp', 'w') as output:
    output.write(str(os.getpid()))
os.replace(sys.argv[1] + '.tmp', sys.argv[1])
threading.Event().wait()
"""
child = subprocess.Popen([sys.executable, "-c", grandchild, sys.argv[1]],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while not __import__("os").path.exists(sys.argv[1]):
    child.poll()
    if child.returncode is not None:
        sys.exit(child.returncode or 1)
if sys.argv[2] == "wait":
    threading.Event().wait()
'''
POSIX_OWNER = r'''
import importlib.util, subprocess, sys, threading
spec = importlib.util.spec_from_file_location("process_job", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.start([sys.executable, "-c", sys.argv[2], sys.argv[3], "wait"],
             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
threading.Event().wait()
'''

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    # Win32 process access rights, wait results, and creation flags.
    PROCESS_TERMINATE = 0x0001
    SYNCHRONIZE = 0x00100000
    WAIT_OBJECT_0 = 0
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    CREATE_BREAKAWAY_FROM_JOB = 0x01000000
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL


class ProcessJobTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pid_file = Path(self.temp.name) / "pid"
        self.handles = []
        self.processes = []
        self.jobs = []
        self.addCleanup(self.cleanup_processes)

    def cleanup_processes(self):
        for job in self.jobs:
            process_job.close(job)
        for proc in self.processes:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        for pid, handle in self.handles:
            if os.name == "nt":
                kernel32.TerminateProcess(handle, 1)
                kernel32.WaitForSingleObject(handle, TIMEOUT_SECONDS * 1000)
                kernel32.CloseHandle(handle)
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def read_child(self):
        deadline = time.monotonic() + TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self.pid_file.exists():
                text = self.pid_file.read_text().strip()
                if text:
                    pid = int(text)
                    handle = None
                    if os.name == "nt":
                        handle = kernel32.OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, False, pid)
                        if not handle:
                            raise ctypes.WinError(ctypes.get_last_error())
                    self.handles.append((pid, handle))
                    return pid, handle
            threading.Event().wait(POLL_SECONDS)
        self.fail("child did not report its PID")

    def assert_dead(self, child):
        pid, handle = child
        if os.name == "nt":
            self.assertEqual(kernel32.WaitForSingleObject(handle, TIMEOUT_SECONDS * 1000), WAIT_OBJECT_0)
            return
        deadline = time.monotonic() + TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                stat = Path("/proc") / str(pid) / "stat"
                if stat.exists() and stat.read_text().rsplit(")", 1)[1].split()[0] == "Z":
                    return
            except ProcessLookupError:
                return
            threading.Event().wait(POLL_SECONDS)
        self.fail("grandchild survived job closure")

    def launch(self, flags=0):
        proc, job = process_job.start([sys.executable, "-c", CHILD, str(self.pid_file), str(flags)],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        self.processes.append(proc)
        self.jobs.append(job)
        child = self.read_child()
        proc.wait(timeout=TIMEOUT_SECONDS)
        return job, child

    def test_close_kills_grandchild_after_parent_exits(self):
        flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        job, child = self.launch(flags)
        self.assertIsNotNone(child)
        process_job.close(job)
        process_job.close(job)
        self.assert_dead(child)

    @unittest.skipUnless(os.name == "nt", "Windows job handles provide hard-owner-death cleanup")
    def test_owner_hard_death_kills_grandchild(self):
        flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        owner = subprocess.Popen([sys.executable, "-c", OWNER, str(HELPER), CHILD,
                                  str(self.pid_file), str(flags)])
        self.processes.append(owner)
        child = self.read_child()
        self.assertIsNotNone(child)
        owner.kill()  # Popen.kill uses TerminateProcess on Windows.
        owner.wait(timeout=TIMEOUT_SECONDS)
        self.assert_dead(child)

    @unittest.skipUnless(os.name == "nt", "Windows breakaway flag")
    def test_breakaway_cannot_escape(self):
        job, child = self.launch(CREATE_BREAKAWAY_FROM_JOB)
        process_job.close(job)
        self.assert_dead(child)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux subreaper required")
    def test_reaper_cleans_session_escape_before_wait_returns(self):
        proc, job = process_job.start([sys.executable, "-c", POSIX_CHILD, str(self.pid_file), "exit"])
        self.processes.append(proc)
        self.jobs.append(job)
        child = self.read_child()
        self.assertEqual(proc.wait(timeout=TIMEOUT_SECONDS), 0)
        self.assert_dead(child)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux subreaper required")
    def test_close_cleans_session_escape_while_command_runs(self):
        proc, job = process_job.start([sys.executable, "-c", POSIX_CHILD, str(self.pid_file), "wait"])
        self.processes.append(proc)
        self.jobs.append(job)
        child = self.read_child()
        process_job.close(job)
        self.assertIsNotNone(proc.poll())
        self.assert_dead(child)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux subreaper required")
    def test_owner_sigkill_cleans_session_escape(self):
        owner = subprocess.Popen([sys.executable, "-c", POSIX_OWNER, str(HELPER), POSIX_CHILD,
                                  str(self.pid_file)])
        self.processes.append(owner)
        child = self.read_child()
        owner.kill()
        owner.wait(timeout=TIMEOUT_SECONDS)
        self.assert_dead(child)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux subreaper required")
    def test_command_exit_status_passes_through(self):
        proc, job = process_job.start([sys.executable, "-c", "import sys; sys.exit(7)"])
        self.processes.append(proc)
        self.jobs.append(job)
        self.assertEqual(proc.wait(timeout=TIMEOUT_SECONDS), 7)


if __name__ == "__main__":
    unittest.main()

"""Own a child process tree; loaded by path by the agent run launchers."""

import os
import signal
import subprocess
import sys
import time

# Microsoft Win32 Job Objects and process creation flags documentation.
CREATE_SUSPENDED = 0x00000004
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
# Linux include/uapi/linux/prctl.h.
PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
# Bound graceful cleanup before the caller resorts to a process-group kill.
CLOSE_TIMEOUT_SECONDS = 10
# Allow newly orphaned processes to be adopted between cleanup passes.
CLEANUP_POLL_SECONDS = 0.01
SHELL_SIGNAL_OFFSET = 128

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimitInformation),
                    ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long


class Job:
    def __init__(self, handle):
        self.handle = handle


def start(cmd, **popen_kwargs):
    """Start cmd contained in a job; return (Popen, job).

    On Linux, call from a thread that lives as long as the run: the kernel's
    parent-death signal follows the thread that created the reaper.
    """
    if os.name != "nt":
        if "start_new_session" in popen_kwargs:
            raise ValueError("start_new_session is managed by process-job")
        args = [sys.executable, "-I", os.path.abspath(__file__), "reap", str(os.getpid()), "--", *cmd]
        proc = subprocess.Popen(args, start_new_session=True, **popen_kwargs)
        return proc, Job(proc)

    handle = kernel32.CreateJobObjectW(None, None)  # Default security attributes are non-inheritable.
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    proc = None
    try:
        limits = ExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                                ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        flags = popen_kwargs.pop("creationflags", 0)
        proc = subprocess.Popen(cmd, creationflags=flags | CREATE_SUSPENDED, **popen_kwargs)
        if not kernel32.AssignProcessToJobObject(handle, int(proc._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        status = ntdll.NtResumeProcess(int(proc._handle))
        if status != 0:
            raise OSError("NtResumeProcess failed with NTSTATUS 0x%08X" % (status & 0xffffffff))
        return proc, Job(handle)
    except BaseException:
        try:
            if proc is not None:
                proc.kill()
                proc.wait()
        finally:
            kernel32.CloseHandle(handle)
        raise


def close(job):
    """Kill the contained tree and release its job; safe to call repeatedly."""
    handle = job.handle
    if handle is None:
        return
    job.handle = None
    if os.name == "nt":
        try:
            if not kernel32.TerminateJobObject(handle, 1):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            kernel32.CloseHandle(handle)
    else:
        if handle.poll() is not None:
            return
        try:
            handle.terminate()
        except ProcessLookupError:
            pass
        try:
            handle.wait(timeout=CLOSE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(handle.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            handle.wait()


class Terminated(Exception):
    pass


def _terminate(_signum, _frame):
    raise Terminated()


def _processes():
    """Return (pid, ppid, process group) snapshots for cleanup."""
    if os.path.isdir("/proc/self"):
        result = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(os.path.join("/proc", entry, "stat"), encoding="utf-8", errors="replace") as stat:
                    fields = stat.read().rsplit(")", 1)[1].split()
                result.append((int(entry), int(fields[1]), int(fields[2])))
            except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
                continue
        return result
    # macOS has no subreaper: only direct children and the process group are visible.
    proc = subprocess.Popen(["ps", "-axo", "pid=,ppid=,pgid="], stdout=subprocess.PIPE, text=True)
    output, _ = proc.communicate()
    if proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, proc.args)
    return [tuple(map(int, line.split())) for line in output.splitlines()
            if line.strip() and int(line.split()[0]) != proc.pid]


def _cleanup():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    own_pid = os.getpid()
    own_group = os.getpgrp()
    while True:
        processes = _processes()
        targets = [pid for pid, ppid, group in processes
                   if pid != own_pid and (ppid == own_pid or group == own_group)]
        for pid in targets:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                pid = -1
            if pid <= 0:
                break
        if pid == -1 and not targets:
            return
        time.sleep(CLEANUP_POLL_SECONDS)


def _reap(parent_pid, cmd):
    signal.signal(signal.SIGTERM, _terminate)
    status = SHELL_SIGNAL_OFFSET + signal.SIGTERM
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        prctl = getattr(libc, "prctl", None)
        if prctl is not None:
            for option, value in ((PR_SET_CHILD_SUBREAPER, 1), (PR_SET_PDEATHSIG, signal.SIGTERM)):
                if prctl(option, value, 0, 0, 0) != 0:
                    raise OSError(ctypes.get_errno(), "prctl failed")
            if os.getppid() != parent_pid:
                return status
        proc = subprocess.Popen(cmd)
        code = proc.wait()
        status = code if code >= 0 else SHELL_SIGNAL_OFFSET - code
    except Terminated:
        pass
    finally:
        _cleanup()
    return status


if __name__ == "__main__":
    if len(sys.argv) < 5 or sys.argv[1] != "reap" or sys.argv[3] != "--":
        sys.exit("usage: process-job.py reap PARENT_PID -- command [args ...]")
    sys.exit(_reap(int(sys.argv[2]), sys.argv[4:]))

"""Helper for the Job-object test: run inside a Job that forbids breakaway, start a detached child, report its pid.

Usage: job_launcher.py <go-file> <pid-file>. Waits for <go-file> (the test assigns this process to the Job first).
"""
import importlib.util
import sys
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "volunteer-run.py"
CHILD_SLEEP_SECONDS = 120
GO_WAIT_SECONDS = 60


def main():
    go, pid_file = Path(sys.argv[1]), Path(sys.argv[2])
    deadline = time.time() + GO_WAIT_SECONDS
    while not go.exists() and time.time() < deadline:
        time.sleep(0.05)
    spec = importlib.util.spec_from_file_location("volunteer_run", SCRIPT)
    vr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vr)
    proc = vr.spawn_detached([sys.executable, "-I", "-c", f"import time; time.sleep({CHILD_SLEEP_SECONDS})"],
                             go.with_name("child.log"))
    pid_file.write_text(str(proc.pid), encoding="utf-8")
    time.sleep(CHILD_SLEEP_SECONDS)


if __name__ == "__main__":
    main()

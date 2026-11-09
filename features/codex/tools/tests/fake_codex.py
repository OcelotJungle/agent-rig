"""Fake `codex exec --json ... -o <last.md> -` for codex-run tests: reads the prompt, emits a finished turn."""
import json
import os
import subprocess
import sys


def emit(**event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def main():
    args = sys.argv[1:]
    last = args[args.index("-o") + 1]
    prompt = sys.stdin.read()
    emit(type="thread.started", thread_id="thread-fake")
    pid_file = os.environ.get("FAKE_CODEX_CHILD_PID")
    if pid_file:
        flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, creationflags=flags,
                                 start_new_session=os.name != "nt")
        with open(pid_file, "w", encoding="utf-8") as f:
            f.write(str(child.pid))
        if os.environ.get("FAKE_CODEX_WAIT"):
            child.wait()
    with open(last, "w", encoding="utf-8") as f:
        f.write(f"fake report ({len(prompt)} prompt chars)\nSTATUS: done\n")
    emit(type="turn.completed")


main()

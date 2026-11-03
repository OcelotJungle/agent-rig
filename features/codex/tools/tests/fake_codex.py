"""Fake `codex exec --json ... -o <last.md> -` for codex-run tests: reads the prompt, emits a finished turn."""
import json
import sys


def emit(**event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def main():
    args = sys.argv[1:]
    last = args[args.index("-o") + 1]
    prompt = sys.stdin.read()
    emit(type="thread.started", thread_id="thread-fake")
    with open(last, "w", encoding="utf-8") as f:
        f.write(f"fake report ({len(prompt)} prompt chars)\nSTATUS: done\n")
    emit(type="turn.completed")


main()

"""Fake `opencode run --format json` for volunteer-run tests.

FAKE_SCENARIO points at a JSON file {"<model id>": [action, ...]}; FAKE_LOG is appended with one JSON line per call.
Actions: {"text": s} {"tool": cmd} {"write": name, "content": s} {"error": msg, "status": n} {"sleep": seconds}
{"exit": code} {"child": pid_file}. A run that reaches the end prints a stop step_finish and exits 0.
"""
import json
import os
import subprocess
import sys
import time

CHILD_SLEEP_SECONDS = 120
WAIT_FOR_FILE_SECONDS = 30
POLL_INTERVAL_SECONDS = 0.01


def emit(session, kind, **fields):
    sys.stdout.buffer.write((json.dumps(dict(type=kind, sessionID=session, **fields)) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def main():
    args = sys.argv[1:]
    model = session = agent = None
    i = 0
    while i < len(args):
        if args[i] == "-m":
            model = args[i + 1].split("/", 1)[1]
            i += 2
        elif args[i] == "-s":
            session = args[i + 1]
            i += 2
        elif args[i] == "--agent":
            agent = args[i + 1]
            i += 2
        elif args[i] == "--format":
            i += 2
        else:
            i += 1
    message = args[-1] if args else ""
    session = session or "ses_fake"
    scenario = json.load(open(os.environ["FAKE_SCENARIO"], encoding="utf-8"))
    actions = scenario.get(model, [])
    with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({
            "model": model, "session": session, "continued": "-s" in args, "agent": agent, "message": message,
            "pwd": os.environ.get("PWD"), "cwd": os.getcwd(),
            "disable_prompt": os.environ.get("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
            "disable_all": os.environ.get("OPENCODE_DISABLE_CLAUDE_CODE"),
            "flp_token": os.environ.get("FLP_TOKEN"), "config": os.environ.get("OPENCODE_CONFIG_CONTENT"),
            "argv": args}) + "\n")
    emit(session, "step_start", part={"type": "step-start"})
    n = 0
    for act in actions:
        n += 1
        if "text" in act:
            emit(session, "text", part={"id": f"t{n}", "type": "text", "text": act["text"]})
        elif "tool" in act:
            emit(session, "tool_use", part={"id": f"p{n}", "callID": f"c{n}", "tool": "bash", "state": {
                "status": "completed", "input": {"command": act["tool"]}, "output": "ok", "title": act["tool"]}})
        elif "write" in act:
            with open(act["write"], "w", encoding="utf-8") as f:
                f.write(act.get("content", ""))
        elif "error" in act:
            emit(session, "error", error={"name": act.get("name", "APIError"), "data": {
                "message": act["error"], "statusCode": act.get("status"), "isRetryable": True}})
        elif "sleep" in act:
            time.sleep(act["sleep"])
        elif "child" in act:
            child = subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({CHILD_SLEEP_SECONDS})"])
            with open(act["child"], "w") as f:
                f.write(str(child.pid))
        elif "detached_child" in act:
            child_code = f"import time; time.sleep({CHILD_SLEEP_SECONDS})"
            if os.name == "nt":
                flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                child = subprocess.Popen([sys.executable, "-c", child_code], creationflags=flags)
            else:
                child = subprocess.Popen([sys.executable, "-c", f"import os; os.setsid(); {child_code}"])
            with open(act["detached_child"], "w", encoding="utf-8") as f:
                f.write(str(child.pid))
        elif "wait_for_file" in act:
            deadline = time.monotonic() + WAIT_FOR_FILE_SECONDS
            while not os.path.exists(act["wait_for_file"]) and time.monotonic() < deadline:
                time.sleep(POLL_INTERVAL_SECONDS)
        elif "exit" in act:
            sys.exit(act["exit"])
    emit(session, "step_finish", part={"type": "step-finish", "reason": "stop", "tokens": {"input": 0}})


if __name__ == "__main__":
    main()

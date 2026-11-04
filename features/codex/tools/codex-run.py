"""Run a Codex task for Claude: detached, supervised, resumable.

Commands:
  start  --model luna|terra|sol|astra --effort E --prompt-file F [--cwd DIR] [--read-only] [--approved]
         creates a job, starts the supervisor, then waits like `wait`
  wait   <job> [--interval SECONDS]   block until the job ends, asks, is blocked, or the interval passes;
                                      print a digest of what Codex did since the previous wait
  attach <job>                         same as wait (for a new worker after the old one died)
  reply  <job> --prompt-file F         continue a finished job's Codex session with answers or a follow-up
  cancel <job>                         stop Codex and everything it started
  list                                 recent jobs and their states
  session-hint                         SessionStart hook compatibility command


Model names resolve to the newest visible model of the line in ~/.codex/models_cache.json, never
below the floor: luna 6, terra 6.1, sol 6.1, and astra 6. Efforts above high on costly lines need
--approved (the user's consent); astra always needs it. The free luna line runs at any effort. When
a line's usage limit is exhausted, jobs downgrade astra -> sol -> terra -> luna.
Every wait is a heartbeat: with no heartbeat for ORPHAN_SECONDS the supervisor stops Codex.
"""
import argparse
import ctypes
import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

report_spec = importlib.util.spec_from_file_location("run_report", Path(__file__).resolve().parents[3] / "base/tools/run-report.py")
report_module = importlib.util.module_from_spec(report_spec)
report_spec.loader.exec_module(report_module)
validate_report = report_module.validate_report

HOME = Path.home()
JOBS_DIR = HOME / ".claude" / "codex-jobs"
MODELS_CACHE = HOME / ".codex" / "models_cache.json"
FLOORS = {"luna": (6,), "terra": (6, 1), "sol": (6, 1), "astra": (6,)}
DOWNGRADE = {"astra": "sol", "sol": "terra", "terra": "luna"}
FREE_EFFORTS = ("low", "medium", "high")
FREE_LINES = ("luna",)
ALL_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
DEFAULT_INTERVAL = 180
POLL_SECONDS = 2
ORPHAN_SECONDS = int(os.environ.get("CODEX_RUN_ORPHAN_SECONDS", 30 * 60))
IDLE_SECONDS = int(os.environ.get("CODEX_RUN_IDLE_SECONDS", 20 * 60))
# a shell command prints no events until it ends: long builds and test runs get a longer leash
COMMAND_IDLE_SECONDS = int(os.environ.get("CODEX_RUN_COMMAND_IDLE_SECONDS", 60 * 60))
MAX_RESTARTS = 3
HEALTHY_RUN_SECONDS = int(os.environ.get("CODEX_RUN_HEALTHY_SECONDS", 10 * 60))
KEEP_JOBS_DAYS = 14
DIGEST_MESSAGES = 6
DIGEST_TEXT_CHARS = 400
TERMINAL = ("done", "question", "blocked", "malformed", "cancelled", "orphaned", "limit")
# Statuses that come from the agent's own report; the final digest prints last.md for them.
REPORT_STATUSES = ("done", "question", "blocked", "malformed")
# A reply continues a job that ended on its own; a cancelled or orphaned one was stopped from outside.
REPLY_STATUSES = ("done", "question", "blocked", "malformed", "limit")
LIMIT_RE = re.compile(r"usage limit|rate limit|limit reached|quota|too many requests|429", re.I)

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000

# Shell rule for Windows runs only: on POSIX the agent's shell is the plain system shell.
SHELL_RULE_MARKER = "__SHELL_RULE__"
SHELL_RULE_WINDOWS = """- Run shell commands through Git Bash: & "C:\\Program Files\\Git\\bin\\bash.exe" -lc '<command>'; anything
  complex goes into a script file run by path.
"""

RUN_RULES = """

---
Rules for this run (from the orchestrating agent):
- You run non-interactively. Nobody can answer you mid-run.
- Never run `git commit`, `git push`, or anything else that changes git history, branches or remotes.
- Choices that change no behaviour are yours: naming, internal structure, how to organise the tests.
__DECISION_RULES__
- Work in small steps. Before each major step say in one short sentence what you are about to do.
- Do not paste diffs, logs or file contents into your messages.
__SHELL_RULE__- Sandbox limits: tools that call os.userInfo (drizzle-kit, for example) fail with ENOMEM: do not run them,
  report what they would have done. Bun prints EPERM on a parent folder, yet its test summary is real. An
  environment failure is retried at most once, then reported.
- Keep output small, since every printed line is reread on every later step: no whole big files, no
  unbounded searches (rg -m, --max-columns), line ranges cut to a width (sed -n Np | cut -c1-3000), only
  the tail of test output.
- Fix the class of a bug, not the reported point: find the general rule, try neighbouring bypasses, add a
  test for each. Before the report, walk the changed files against AGENTS.md and fix what breaks it.
- One operation per file in one apply_patch: several operations on one file are rejected.
""".replace("__DECISION_RULES__\n", report_module.DECISION_RULES) + report_module.REPORT_FORM

def run_rules(windows):
    return RUN_RULES.replace(SHELL_RULE_MARKER, SHELL_RULE_WINDOWS if windows else "")


RESUME_TEXT = (
    "The previous run was interrupted at {when} ({why}). Continue the same task from where you "
    "stopped. The last step may be incomplete: check the current state of the files first. "
    "Keep the same rules and finish with the same report format."
)

SWITCH_TEXT = (
    "The previous model ran out of usage at {when}. You are taking over the same task on a "
    "different model. Continue from where it stopped; check the current state of the files first. "
    "Keep the same rules and finish with the same report format."
)

def now():
    return time.time()


def hhmm(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def pid_alive(pid):
    if not pid:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    kernel32.CloseHandle(handle)
    return bool(ok) and code.value == 259  # STILL_ACTIVE


def kill_tree(pid):
    if not pid:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(pid, 9)
        except OSError:
            pass


# ---------- models ----------

def version_of(slug, line):
    m = re.fullmatch(r"gpt-(\d+(?:\.\d+)*)-" + line, slug or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def resolve_model(line):
    cache = read_json(MODELS_CACHE)
    if not cache:
        sys.exit(f"ERROR: cannot read {MODELS_CACHE}; run any codex command once to create it")
    best = None
    for m in cache.get("models") or []:
        if m.get("visibility") != "list":
            continue
        v = version_of(m.get("slug"), line)
        if v is not None and v >= FLOORS[line] and (best is None or v > best[0]):
            best = (v, m)
    if best is None:
        floor = ".".join(map(str, FLOORS[line]))
        sys.exit(f"ERROR: no visible {line} model at version {floor} or newer in {MODELS_CACHE}")
    m = best[1]
    efforts = [e.get("effort") for e in m.get("supported_reasoning_levels") or []]
    return m["slug"], efforts


# ---------- events ----------

def scan_events(path, start=0):
    """Return (end_offset, list of events) from byte offset `start`."""
    events = []
    try:
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read()
    except OSError:
        return start, events
    end = data.rfind(b"\n") + 1
    for raw in data[:end].splitlines():
        try:
            events.append(json.loads(raw.decode("utf-8")))
        except ValueError:
            continue
    return start + end, events


def short(text, n=DIGEST_TEXT_CHARS):
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


# ---------- supervisor ----------

class Supervisor:
    def __init__(self, job_dir):
        self.dir = Path(job_dir)
        self.state_path = self.dir / "state.json"
        self.events_path = self.dir / "events.jsonl"
        self.state = read_json(self.state_path)
        self.last_event = now()
        self.saw_turn_completed = False
        self.error_text = ""
        self.running_commands = set()

    def save(self, **kw):
        self.state.update(kw)
        self.state["updated"] = now()
        write_json(self.state_path, self.state)

    def heartbeat_age(self):
        try:
            return now() - (self.dir / "heartbeat").stat().st_mtime
        except OSError:
            return now() - self.state["created"]

    def command(self, resume_text=None):
        s = self.state
        args = [shutil.which("codex") or "codex", "exec"]
        common = ["--json", "--skip-git-repo-check", "-m", s["slug"],
                  "-c", f"model_reasoning_effort={s['effort']}",
                  "-c", "model_reasoning_summary=auto",
                  "-c", f"sandbox_mode={'read-only' if s['read_only'] else 'workspace-write'}",
                  "-o", str(self.dir / "last.md")]
        if resume_text is None:
            return args + common + ["-"], (self.dir / "prompt.md").read_text(encoding="utf-8")
        return args + ["resume", s["session_id"]] + common + [resume_text], None

    def pump(self, proc, sink):
        for raw in proc.stdout:
            sink.write(raw)
            sink.flush()
            self.last_event = now()
            try:
                e = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            t = e.get("type")
            if t == "thread.started" and e.get("thread_id"):
                self.save(session_id=e["thread_id"])
            elif t == "turn.completed":
                self.saw_turn_completed = True
            elif t in ("error", "turn.failed"):
                err = e.get("message") or (e.get("error") or {}).get("message") or json.dumps(e)
                self.error_text = str(err)
            item = e.get("item") or {}
            if t == "item.started" and item.get("type") == "command_execution":
                self.running_commands.add(item.get("id"))
            elif t == "item.completed":
                self.running_commands.discard(item.get("id"))

    def run_once(self, resume_text=None):
        cmd, stdin_text = self.command(resume_text)
        self.saw_turn_completed = False
        self.error_text = ""
        self.running_commands = set()
        self.last_event = now()
        flags = CREATE_NO_WINDOW if os.name == "nt" else 0
        with open(self.events_path, "ab") as sink, open(self.dir / "codex.err", "ab") as err:
            # On POSIX the job is its own process group, so kill_tree's killpg reaches its children.
            proc = subprocess.Popen(cmd, cwd=self.state["cwd"], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=err, creationflags=flags,
                                    start_new_session=os.name != "nt")
            self.save(codex_pid=proc.pid, status="running")
            if stdin_text is not None:
                proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()
            reader = threading.Thread(target=self.pump, args=(proc, sink), daemon=True)
            reader.start()
            reason = None
            while proc.poll() is None:
                time.sleep(POLL_SECONDS)
                if (self.dir / "cancel").exists():
                    reason = "cancelled"
                elif self.heartbeat_age() > ORPHAN_SECONDS:
                    reason = "orphaned"
                elif now() - self.last_event > (COMMAND_IDLE_SECONDS if self.running_commands else IDLE_SECONDS):
                    reason = "hung"
                if reason:
                    kill_tree(proc.pid)
                    break
            proc.wait()
            reader.join(timeout=10)
        return reason, proc.returncode

    def note(self, text):
        notes = self.state.setdefault("notes", [])
        notes.append(f"{hhmm(now())} {text}")
        self.save()

    def run(self):
        reply = self.dir / "reply.md"
        resume_text = None
        if reply.exists():
            resume_text = reply.read_text(encoding="utf-8")
            reply.unlink()
            self.save(malformed_follow_ups=0)  # a reply starts a new turn with its own malformed follow-up
        self.save(supervisor_pid=os.getpid(), status="running", started=self.state.get("started") or now())
        restarts = 0
        while True:
            run_started = now()
            reason, code = self.run_once(resume_text)
            if reason in ("cancelled", "orphaned"):
                return self.save(status=reason, ended=now())
            last = self.dir / "last.md"
            if reason is None and self.saw_turn_completed and last.exists():
                report = last.read_text(encoding="utf-8", errors="replace")
                status, error = validate_report(report)
                if not error:
                    return self.save(status=status, ended=now(), exit_code=code, error=None, report_error=None)
                if self.state.get("malformed_follow_ups", 0) or not self.state.get("session_id"):
                    return self.save(status="malformed", ended=now(), exit_code=code, error=None, report_error=error)
                self.save(malformed_follow_ups=1, report_error=error)
                resume_text = report_module.malformed_follow_up(error)
                continue
            if now() - run_started >= HEALTHY_RUN_SECONDS:
                restarts = 0  # it worked for a while before dying: a fresh failure, not a loop
            if LIMIT_RE.search(self.error_text or ""):
                lower = DOWNGRADE.get(self.state["line"])
                if lower is None or not self.state.get("session_id"):
                    return self.save(status="limit", ended=now(), error=self.error_text)
                slug, efforts = resolve_model(lower)
                effort = self.state["effort"] if self.state["effort"] in efforts else "medium"
                self.note(f"usage limit on {self.state['slug']}; switching to {slug}")
                self.save(line=lower, slug=slug, effort=effort)
                resume_text = SWITCH_TEXT.format(when=hhmm(now()))
                continue
            why = {"hung": "no output for too long, stopped as hung"}.get(
                reason, f"process exited with code {code} without a final report"
                + (f": {short(self.error_text, 200)}" if self.error_text else ""))
            if restarts >= MAX_RESTARTS or not self.state.get("session_id"):
                return self.save(status="blocked", ended=now(), error=why)
            restarts += 1
            self.note(f"restart {restarts}/{MAX_RESTARTS}: {why}")
            self.save(restarts=self.state.get("restarts", 0) + 1)
            resume_text = RESUME_TEXT.format(when=hhmm(now()), why=why)


# ---------- client commands ----------

def job_dir(job):
    d = JOBS_DIR / job
    if not (d / "state.json").exists():
        sys.exit(f"ERROR: no job {job}")
    return d


def take_prompt(path):
    """Read a prompt file; a codex-prompt-*.md file the worker wrote is removed once read."""
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    if path.name.startswith("codex-prompt-") and path.suffix == ".md":
        path.unlink(missing_ok=True)
    return text


def cleanup_old_jobs():
    if not JOBS_DIR.exists():
        return
    cutoff = now() - KEEP_JOBS_DAYS * 86400
    for d in JOBS_DIR.iterdir():
        st = read_json(d / "state.json") or {}
        if st.get("status") in TERMINAL and st.get("updated", now()) < cutoff:
            shutil.rmtree(d, ignore_errors=True)


def spawn_supervisor(d):
    cmd = [sys.executable, "-I", str(Path(__file__).resolve()), "_supervise", str(d)]
    log = open(d / "supervisor.log", "ab")
    kw = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True)
    if os.name == "nt":
        base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        try:
            subprocess.Popen(cmd, creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **kw)
        except OSError:
            subprocess.Popen(cmd, creationflags=base, **kw)
    else:
        subprocess.Popen(cmd, start_new_session=True, **kw)


def cmd_session_hint(a):
    return


def cmd_start(a):
    line = a.model
    if line == "astra" and not a.approved:
        sys.exit("REFUSED: astra needs the user's explicit consent (--approved)")
    if a.effort not in FREE_EFFORTS and line not in FREE_LINES and not a.approved:
        sys.exit(f"REFUSED: effort {a.effort} is above high and needs the user's consent (--approved)")
    slug, efforts = resolve_model(line)
    if a.effort not in efforts:
        sys.exit(f"ERROR: {slug} does not support effort {a.effort}; supported: {', '.join(efforts)}")
    prompt = take_prompt(a.prompt_file)
    cleanup_old_jobs()
    job = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
    d = JOBS_DIR / job
    d.mkdir(parents=True)
    (d / "prompt.md").write_text(prompt.rstrip() + run_rules(windows=os.name == "nt"), encoding="utf-8")
    write_json(d / "state.json", {
        "job": job, "line": line, "slug": slug, "effort": a.effort, "read_only": a.read_only,
        "cwd": str(Path(a.cwd or os.getcwd()).resolve()), "status": "starting",
        "created": now(), "updated": now(), "restarts": 0, "notes": [],
    })
    (d / "heartbeat").touch()
    spawn_supervisor(d)
    print(f"job {job} started: {slug} / {a.effort}, cwd {Path(a.cwd or os.getcwd()).resolve()}")
    # return at once: the job id reaches the worker's transcript only when this call ends, and the hub
    # reads it there to show the job live
    print(f"\n(still running; call: wait {job})")


def digest(d, st, events, final):
    lines = []
    elapsed = int((st.get("ended") or now()) - st.get("started", st["created"])) // 60
    cmds = sum(1 for e in events if e.get("type") == "item.completed"
               and (e.get("item") or {}).get("type") == "command_execution")
    last_ts = (d / "events.jsonl").stat().st_mtime if (d / "events.jsonl").exists() else st["created"]
    lines.append(f"codex job {st['job']} · {st['status']} · {st['slug']}/{st['effort']} · {elapsed} min"
                 f" · last activity {hhmm(last_ts)} · {cmds} commands since last check"
                 f" · restarts {st.get('restarts', 0)}")
    for n in st.get("notes", [])[-3:]:
        lines.append(f"note: {n}")
    msgs, reasoning, files, last_cmd = [], [], [], None
    for e in events:
        it = e.get("item") or {}
        kind = it.get("type")
        if e.get("type") == "item.started" and kind == "command_execution":
            last_cmd = it.get("command")
        if e.get("type") != "item.completed":
            continue
        if kind == "agent_message":
            msgs.append(it.get("text") or "")
        elif kind == "reasoning":
            reasoning.append(it.get("text") or "")
        elif kind == "file_change":
            for ch in it.get("changes") or []:
                p = ch.get("path") if isinstance(ch, dict) else None
                if p and p not in files:
                    files.append(p)
    if not final:
        for r in reasoning[-2:]:
            lines.append(f"thinking: {short(r, 250)}")
        for m in [m for m in msgs if not report_module.has_status_line(m)][-DIGEST_MESSAGES:]:
            lines.append(f"codex: {short(m)}")
        if last_cmd:
            lines.append(f"running: {short(last_cmd, 160)}")
    if files:
        lines.append("files touched: " + ", ".join(Path(f).name for f in files[:15]))
    if final:
        last = d / "last.md"
        if st["status"] in REPORT_STATUSES and not st.get("error") and last.exists():
            lines.append("")
            lines.append(last.read_text(encoding="utf-8", errors="replace").strip())
            if st["status"] == "malformed":
                lines.append(f"report problem: {st.get('report_error')}")
        else:
            lines.append(f"error: {st.get('error') or 'no final report'}")
            if msgs:
                lines.append(f"last codex message: {short(msgs[-1], 800)}")
    return "\n".join(lines)


def cmd_wait(a):
    d = job_dir(a.job)
    deadline = now() + a.interval
    offset_path = d / "digest_offset"
    try:
        offset = int(offset_path.read_text())
    except (OSError, ValueError):
        offset = 0
    while True:
        (d / "heartbeat").touch()
        st = read_json(d / "state.json") or {}
        status = st.get("status")
        if status not in TERMINAL and status != "starting" and not pid_alive(st.get("supervisor_pid")):
            st.update(status="blocked", error="supervisor process died", ended=now())
            write_json(d / "state.json", st)
            status = "blocked"
        if status in TERMINAL or now() >= deadline:
            break
        if status == "starting" and now() - st["created"] > 60:
            st.update(status="blocked", error="supervisor did not start (see supervisor.log)", ended=now())
            write_json(d / "state.json", st)
            break
        time.sleep(POLL_SECONDS)
    end, events = scan_events(d / "events.jsonl", offset)
    offset_path.write_text(str(end))
    final = st.get("status") in TERMINAL
    print(digest(d, st, events, final))
    print("" if final else f"\n(still running; call: wait {st['job']})")


def cmd_reply(a):
    d = job_dir(a.job)
    st = read_json(d / "state.json") or {}
    if st.get("status") not in REPLY_STATUSES or not st.get("session_id"):
        sys.exit(f"ERROR: job {a.job} is {st.get('status')}; reply needs a finished job with a session")
    text = take_prompt(a.prompt_file).rstrip()
    (d / "reply.md").write_text(text + "\n\nKeep the same rules and finish with the same report format.",
                                encoding="utf-8")
    for name in ("cancel", "last.md"):
        (d / name).unlink(missing_ok=True)
    st.update(status="starting", created=now(), ended=None, error=None)
    write_json(d / "state.json", st)
    (d / "heartbeat").touch()
    spawn_supervisor(d)
    print(f"job {a.job} resumed with the reply")
    cmd_wait(a)


def cmd_cancel(a):
    d = job_dir(a.job)
    (d / "cancel").touch()
    st = read_json(d / "state.json") or {}
    deadline = now() + 15
    while now() < deadline and (read_json(d / "state.json") or {}).get("status") not in TERMINAL:
        time.sleep(1)
    st = read_json(d / "state.json") or {}
    if st.get("status") not in TERMINAL:
        kill_tree(st.get("codex_pid"))
        kill_tree(st.get("supervisor_pid"))
        st.update(status="cancelled", ended=now())
        write_json(d / "state.json", st)
    print(f"job {a.job}: {st.get('status')}")


def cmd_prompt_path(a):
    # the worker has no clock: a name it made up itself would clash between workers started together
    name = datetime.now().strftime("codex-prompt-%Y%m%d-%H%M%S-") + secrets.token_hex(4) + ".md"
    print(Path(a.cwd).resolve() / ".tmp" / name)


def cmd_list(a):
    if not JOBS_DIR.exists():
        return print("no jobs")
    for d in sorted(JOBS_DIR.iterdir())[-15:]:
        st = read_json(d / "state.json") or {}
        print(f"{d.name}  {st.get('status')}  {st.get('slug')}/{st.get('effort')}  {st.get('cwd')}")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "_supervise":
        return Supervisor(sys.argv[2]).run()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("--model", choices=sorted(FLOORS), default="terra")
    s.add_argument("--effort", choices=ALL_EFFORTS, default="medium")
    s.add_argument("--prompt-file", required=True)
    s.add_argument("--cwd")
    s.add_argument("--read-only", action="store_true")
    s.add_argument("--approved", action="store_true")
    s.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    for name in ("wait", "attach"):
        w = sub.add_parser(name)
        w.add_argument("job")
        w.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    r = sub.add_parser("reply")
    r.add_argument("job")
    r.add_argument("--prompt-file", required=True)
    r.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    c = sub.add_parser("cancel")
    c.add_argument("job")
    sub.add_parser("list")
    pp = sub.add_parser("prompt-path")
    pp.add_argument("--cwd", required=True)
    sub.add_parser("session-hint")
    a = p.parse_args()
    handlers = {"start": cmd_start, "wait": cmd_wait, "attach": cmd_wait, "reply": cmd_reply,
                "cancel": cmd_cancel, "list": cmd_list, "prompt-path": cmd_prompt_path,
                "session-hint": cmd_session_hint}
    handlers[a.cmd](a)


if __name__ == "__main__":
    if os.name == "nt":
        sys.stdout.reconfigure(encoding="utf-8")
    main()

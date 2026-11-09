"""Run a task for Claude on free cloud models: detached, supervised, resumable.

Same shape as codex-run.py, but the worker is OpenCode talking to a local freellmpool proxy.

Commands:
  start  --prompt-file F [--cwd DIR] [--read-only]
         refuses a cwd outside the project whitelist, creates a job, starts the supervisor, returns at once
  wait   <job> [--interval SECONDS]   block until the job ends, asks, is blocked, or the interval passes;
                                      print a digest of what the worker did since the previous wait
  attach <job>                         same as wait (for a new relay after the old one died)
  reply  <job> --prompt-file F         continue a finished job's session with answers or a follow-up
  cancel <job>                         stop the worker and everything it started
  list                                 recent jobs and their states
  prompt-path --cwd DIR                a fresh prompt file name under DIR/.tmp

The model is never chosen by the caller: the supervisor takes them in order from the cache
~/.claude/volunteer-jobs/models.json (built by volunteer-models.py), uses one model at a time and
switches to the next one, continuing the same OpenCode session, only when the current one fails.
The cache may change under a running job: every model choice re-reads it (a bad or empty read keeps the old list).
The job's `slug` in state.json is always the model that is answering now.
Every wait is a heartbeat: with no heartbeat for ORPHAN_SECONDS the supervisor stops the worker.
"""
import argparse
import ctypes
import importlib.util
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

report_spec = importlib.util.spec_from_file_location("run_report", Path(__file__).resolve().parents[3] / "base/tools/run-report.py")
report_module = importlib.util.module_from_spec(report_spec)
report_spec.loader.exec_module(report_module)
validate_report = report_module.validate_report
process_job_spec = importlib.util.spec_from_file_location(
    "process_job", Path(__file__).resolve().parents[3] / "base/tools/process-job.py")
process_job = importlib.util.module_from_spec(process_job_spec)
process_job_spec.loader.exec_module(process_job)

HOME = Path.home()
PROJECTS_FILE = HOME / ".agent-rig" / "volunteer-projects.json"
TOOLS_DIR = Path(__file__).resolve().parent
JOBS_DIR = Path(os.environ.get("VOLUNTEER_JOBS_DIR") or HOME / ".claude" / "volunteer-jobs")
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 18080
PROXY_URL = os.environ.get("VOLUNTEER_PROXY_URL") or f"http://{PROXY_HOST}:{PROXY_PORT}"
PROXY_VERSION = "freellmpool@0.13.0"
PROXY_CMD = json.loads(os.environ["VOLUNTEER_PROXY_CMD"]) if os.environ.get("VOLUNTEER_PROXY_CMD") else [
    "uvx", PROXY_VERSION, "proxy", "--host", PROXY_HOST, "--port", str(PROXY_PORT)]
PROXY_START_TIMEOUT = int(os.environ.get("VOLUNTEER_PROXY_START_SECONDS", 90))
OPENCODE_CMD = json.loads(os.environ["VOLUNTEER_OPENCODE_CMD"]) if os.environ.get("VOLUNTEER_OPENCODE_CMD") \
    else [shutil.which("opencode") or "opencode"]
MODELS_SCRIPT = os.environ.get("VOLUNTEER_MODELS_SCRIPT") or str(TOOLS_DIR / "volunteer-models.py")
GLOBAL_RULES = (HOME / ".codex" / "AGENTS.md").as_posix()  # goes into the JSON config: a forward-slash string
GIT_BASH = "C:/Program Files/Git/bin/bash.exe"
PROVIDER = "freellmpool"
MODELS_MAX_AGE = 24 * 3600
REFRESH_TIMEOUT = int(os.environ.get("VOLUNTEER_REFRESH_SECONDS", 15 * 60))
MAX_PROMPT_CHARS = 24000  # the prompt travels in argv; Windows caps a command line near 32k

DEFAULT_INTERVAL = 180
POLL_SECONDS = 2
ORPHAN_SECONDS = int(os.environ.get("VOLUNTEER_ORPHAN_SECONDS", 30 * 60))
# The gateway buffers tool-calling replies, so OpenCode sees no events while a model thinks; the gateway itself
# gives up on an upstream after this long (freellmpool 0.13.0 proxy.py _AGENT_UPSTREAM_TIMEOUT) and then answers
# with an error. Silence shorter than that is a live request, not a hang.
GATEWAY_REPLY_DEADLINE_SECONDS = 540
IDLE_MARGIN_SECONDS = 60
IDLE_SECONDS = int(os.environ.get("VOLUNTEER_IDLE_SECONDS",
                                  GATEWAY_REPLY_DEADLINE_SECONDS + IDLE_MARGIN_SECONDS))
HARD_TIMEOUT_SECONDS = int(os.environ.get("VOLUNTEER_HARD_TIMEOUT_SECONDS", 3 * 3600))
KEEP_JOBS_DAYS = 14
DIGEST_MESSAGES = 6
DIGEST_TEXT_CHARS = 400
REASON_CHARS = 160
CHANGED_FILES_MAX = 50
TERMINAL = ("done", "question", "blocked", "malformed", "cancelled", "orphaned", "limit")
# Statuses that come from the agent's own report; the final digest prints last.md for them.
REPORT_STATUSES = ("done", "question", "blocked", "malformed")
# A reply continues a job that ended on its own; a cancelled or orphaned one was stopped from outside.
REPLY_STATUSES = ("done", "question", "blocked", "malformed", "limit")

# A failed run is blamed on the model only while the infrastructure is healthy.
NETWORK_POLL_SECONDS = 15
NETWORK_CONNECT_TIMEOUT = 3
WMI_LAUNCH_TIMEOUT = 60  # PowerShell start-up plus one WMI call: seconds on a healthy machine
MAX_GATEWAY_RESTARTS = 3
REPLACE_RETRIES = 20  # state.json readers (the CLI, tests) hold the file open for milliseconds
REPLACE_RETRY_SECONDS = 0.05
PROVIDER_HOSTS = {"openrouter": "openrouter.ai", "requesty": "router.requesty.ai", "groq": "api.groq.com",
                  "zhipu": "api.z.ai"}

# A transient failure (timeout, 5xx, overloaded, 429, hang) puts a model aside for this long, then it is tried again.
MODEL_COOLDOWN_SECONDS = 5 * 60
# Tokens kept free in a model's context window for its reply. Source: OpenCode answers of 2-8k tokens per step
# in the probes (volunteer-probes.md); the larger figure is used so a nearly full window is not entered.
REPLY_HEADROOM_TOKENS = 8000
BYTES_PER_TOKEN = 4  # rough size of English/code text; OpenCode's step_finish events report 0 tokens
# Context windows the listings do not carry. Source: Groq free plan, 8K tokens per minute for one request
# (volunteer-design.md, "Limits"). A provider missing here has an unknown window: the model is tried and an
# overflow error then removes it for the job.
PROVIDER_WINDOWS = {"groq": 8000}
# Errors that no retry fixes: the session does not fit, or the request/credentials are wrong.
PERMANENT_STATUSES = (400, 401, 403, 404, 413)
PERMANENT_MARKERS = ("ContextOverflowError", "exceeded the context window", "Prompt exceeds max length",
                     "context_length_exceeded", "maximum context length")
OVERFLOW_TOKENS_RE = re.compile(r"input is ~([\d,]+) tokens", re.I)
LAUNCH_ENV_KEYS = ("PATH", "PATHEXT", "SYSTEMROOT", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP",
                   "TMP", "TMPDIR", "PYTHONUTF8")

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000

RUN_RULES = """

---
Rules for this run (from the orchestrating agent):
- You run non-interactively. Nobody can answer you mid-run.
- Work only inside the current directory and use relative paths. A denied tool call is final: do not retry
  it, report it.
- Never run `git commit`, `git push`, or anything else that changes git history, branches or remotes.
- Choices that change no behaviour are yours: naming, internal structure, how to organise the tests.
__DECISION_RULES__
- Work in small steps. Before each major step say in one short sentence what you are about to do.
- Do not paste diffs, logs or file contents into your messages.
- Keep output small, since every printed line is reread on every later step: no whole big files, no
  unbounded searches, only the tail of test output.
""".replace("__DECISION_RULES__\n", report_module.DECISION_RULES) + report_module.REPORT_FORM

RESUME_TEXT = (
    "The previous run was interrupted at {when} ({why}). Continue the same task from where you "
    "stopped. The last step may be incomplete: check the current state of the files first. "
    "Keep the same rules and finish with the same report format."
)

SWITCH_TEXT = (
    "The previous model failed at {when} ({why}). You are taking over the same task on a different "
    "model. Continue from where it stopped; check the current state of the files first. "
    "Keep the same rules and finish with the same report format."
)

# git commands that change history, branches, remotes or the index of other work: denied in write mode
GIT_DENY = ["commit", "push", "reset", "rebase", "merge", "cherry-pick", "revert", "am", "tag",
            "filter-branch", "update-ref", "remote", "reflog", "gc", "clean", "stash", "checkout", "switch",
            "branch -d", "branch -D", "branch -m", "branch -M"]
READ_ONLY_BASH = ["ls", "cat", "head", "tail", "grep", "rg", "find", "git status", "git diff", "git log",
                  "git show"]

MINIMAL_PROMPT = ("You are a terse coding agent. Use the tools to do the task in the current directory. "
                  "Use relative paths.")
MINIMAL_TOOLS = {"read": True, "edit": True, "bash": True, "glob": True, "grep": True, "write": True,
                 "list": False, "patch": False, "todowrite": False, "todoread": False, "webfetch": False,
                 "task": False, "skill": False, "websearch": False, "context7_*": False,
                 "list_mcp_resource_templates": False, "list_mcp_resources": False,
                 "read_mcp_resource": False, "apply_patch": True}


class Fail(Exception):
    """A job-level failure with a reason the user should read."""


def now():
    return time.time()


def hhmm(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def read_json(path, default=None):
    for attempt in range(REPLACE_RETRIES):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except PermissionError:
            # Windows refuses a read that lands on the instant write_json replaces the file.
            if attempt < REPLACE_RETRIES - 1:
                time.sleep(REPLACE_RETRY_SECONDS)
        except (OSError, ValueError):
            return default
    return default


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for attempt in range(REPLACE_RETRIES):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # Windows refuses to replace a file another process has open for reading at this instant.
            if attempt == REPLACE_RETRIES - 1:
                raise
            time.sleep(REPLACE_RETRY_SECONDS)


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


def kill_pid(pid):
    if not pid:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True,
                       creationflags=CREATE_NO_WINDOW)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


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


def spawn_detached(cmd, log_path, env=None, cwd=None):
    """Start a process that outlives this one and its console; stdout/stderr go to log_path."""
    # Windows: a hidden console (CREATE_NO_WINDOW), not DETACHED_PROCESS: a detached process has no console, so every
    # console child it starts opens its own visible window; with a hidden console the children inherit it.
    # If the caller's Job object forbids breakaway, the process is started through WMI instead (it is then
    # created by WmiPrvSE, outside the Job). There is no further fallback: failing both is an error.
    log = open(log_path, "ab")
    kw = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, env=env, cwd=cwd)
    try:
        if os.name == "nt":
            base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
            try:
                proc = subprocess.Popen(cmd, creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **kw)
            except OSError:
                log.close()
                proc = spawn_via_wmi(cmd, log_path, env, cwd)
        else:
            proc = subprocess.Popen(cmd, start_new_session=True, **kw)
    finally:
        log.close()
    # Fire and forget by design; callers may keep the handle (tests do) but production ignores it.
    return proc


class Launched:
    """Handle for a process started through WMI: only the pid is known."""

    def __init__(self, pid):
        self.pid = pid

    def wait(self, timeout=None):
        deadline = None if timeout is None else now() + timeout
        while pid_alive(self.pid):
            if deadline is not None and now() > deadline:
                raise subprocess.TimeoutExpired("launched", timeout)
            time.sleep(0.2)


def spawn_via_wmi(cmd, log_path, env, cwd):
    """Start `cmd` outside the caller's Job object via Win32_Process.Create; return a handle with the pid.

    WMI creates the process in WmiPrvSE's context, so it has no inherited environment: a non-secret allowlist
    (plus VOLUNTEER_* and the caller's overrides) travels in a spec file read by the `_launch` subcommand.
    """
    source = env if env is not None else os.environ
    keep = {k: v for k, v in source.items() if k.upper() in LAUNCH_ENV_KEYS or k.startswith("VOLUNTEER_")}
    keep.update({k: v for k, v in (env or {}).items() if os.environ.get(k) != v})
    fd, spec_path = tempfile.mkstemp(prefix="volunteer-launch-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"cmd": [str(c) for c in cmd], "log": str(log_path), "cwd": str(cwd) if cwd else None,
                   "env": keep}, f)
    launch_cmd = [sys.executable, "-I", str(Path(__file__).resolve()), "_launch", spec_path]
    ps1 = TOOLS_DIR / "volunteer-launch.ps1"
    run_env = dict(os.environ, VR_CMDLINE=subprocess.list2cmdline(launch_cmd), VR_CWD=str(cwd or TOOLS_DIR))
    try:
        res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                              "-File", str(ps1)], capture_output=True, text=True, env=run_env,
                             creationflags=CREATE_NO_WINDOW, timeout=WMI_LAUNCH_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        Path(spec_path).unlink(missing_ok=True)
        raise Fail(f"cannot start a detached process: breakaway from the Job object was refused and WMI failed: {e}")
    out = (res.stdout or "").strip().splitlines()
    if res.returncode != 0 or not out or not out[-1].strip().isdigit():
        Path(spec_path).unlink(missing_ok=True)
        raise Fail("cannot start a detached process: breakaway from the Job object was refused and WMI failed: "
                   + short((res.stderr or res.stdout or "").strip(), 200))
    return Launched(int(out[-1].strip()))


def run_launch(spec_path):
    """Hidden `_launch`: run the command from a spec file written by spawn_via_wmi; exit with its code."""
    p = Path(spec_path)
    spec = json.loads(p.read_text(encoding="utf-8"))
    p.unlink(missing_ok=True)
    env = dict(os.environ)
    env.update(spec.get("env") or {})
    with open(spec["log"], "ab") as log:
        proc = subprocess.Popen(spec["cmd"], stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
                                cwd=spec.get("cwd"), creationflags=CREATE_NO_WINDOW)
        return proc.wait()


def run_proxy_serve():
    """Hidden `proxy-serve`: run the gateway with the token read from its file, so it is never on a command line."""
    env = dict(os.environ, PYTHONUTF8="1", FREELLMPOOL_PROXY_KEY=proxy_token())
    with open(JOBS_DIR / "proxy.log", "ab") as log:
        proc = subprocess.Popen(PROXY_CMD, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
                                creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0)
        return proc.wait()


# ---------- whitelist ----------

def norm_path(p):
    return os.path.normcase(str(Path(p).resolve()))


def inside(path, root):
    p, r = norm_path(path), norm_path(root)
    return p == r or p.startswith(r.rstrip("\\/") + os.sep)


def check_cwd(cwd):
    """Return the resolved cwd, or raise Fail with the refusal reason."""
    p = Path(cwd).resolve()
    try:
        config = json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise Fail(f"projects file {PROJECTS_FILE} is missing; create it as {{\"allowed\": [\"C:/projects/one\", \"C:/projects/two\"]}}")
    except json.JSONDecodeError as e:
        raise Fail(f"projects file {PROJECTS_FILE} contains malformed JSON: {e}")
    except (OSError, UnicodeError) as e:
        raise Fail(f"cannot read projects file {PROJECTS_FILE}: {e}")
    if not isinstance(config, dict) or not isinstance(config.get("allowed"), list) or \
            not all(isinstance(root, str) for root in config["allowed"]):
        raise Fail(f"invalid projects file {PROJECTS_FILE}: expected {{\"allowed\": [\"C:/projects/one\", ...]}} with allowed as a list of strings")
    try:
        allowed = any(inside(p, root) for root in config["allowed"])
    except (OSError, RuntimeError, ValueError) as e:
        raise Fail(f"invalid path in projects file {PROJECTS_FILE}: {e}")
    if not allowed:
        raise Fail(f"{p} is not inside an allowed project listed in {PROJECTS_FILE}")
    if not p.is_dir():
        raise Fail(f"{p} is not a directory")
    return p


# ---------- gateway ----------

def proxy_token():
    path = JOBS_DIR / "proxy-token"
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if not token:
        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(32)
        path.write_text(token, encoding="utf-8")
    return token


def proxy_up(token):
    req = urllib.request.Request(PROXY_URL + "/v1/status", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=3):
            return True
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Fail(f"the gateway at {PROXY_URL} refuses the volunteer token (HTTP {e.code}); "
                       "another proxy may be using the port")
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def tcp_reachable(host, port, timeout):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def network_up(model_ids):
    """True when the API host of any provider in use accepts a TCP connection (all known hosts if none is known)."""
    hosts = {PROVIDER_HOSTS[i.split("/")[0]] for i in model_ids if i.split("/")[0] in PROVIDER_HOSTS}
    return any(tcp_reachable(h, 443, NETWORK_CONNECT_TIMEOUT) for h in sorted(hosts or PROVIDER_HOSTS.values()))


def is_permanent_failure(why):
    """A failure that retrying the same model cannot fix: context overflow or a 4xx client error."""
    if any(m in why for m in PERMANENT_MARKERS):
        return True
    found = re.match(r"\w+ (\d{3}):", why) or re.search(r"HTTP (\d{3})", why)
    return bool(found) and int(found.group(1)) in PERMANENT_STATUSES


def model_fits(entry, session_tokens):
    """False only when the model's context window is known and too small for the session plus reply headroom."""
    window = entry.get("context") or PROVIDER_WINDOWS.get(entry["id"].split("/")[0])
    # Headroom is at most half the window, so a small window (Groq 8000 TPM) still admits a short session.
    return window is None or session_tokens <= window - min(REPLY_HEADROOM_TOKENS, window // 2)


def ensure_proxy():
    token = proxy_token()
    if proxy_up(token):
        return token
    spawn_detached([sys.executable, "-I", str(Path(__file__).resolve()), "proxy-serve"], JOBS_DIR / "proxy.log")
    deadline = now() + PROXY_START_TIMEOUT
    while now() < deadline:
        time.sleep(1)
        if proxy_up(token):
            return token
    raise Fail(f"the gateway did not answer at {PROXY_URL} within {PROXY_START_TIMEOUT} s (see proxy.log)")


# ---------- models cache ----------

def models_cache_path():
    return JOBS_DIR / "models.json"


def cache_age(cache):
    try:
        stamp = datetime.strptime(cache["checked_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return now() - stamp.timestamp()
    except (KeyError, TypeError, ValueError):
        return None


def refresh_cmd():
    return [sys.executable, "-I", MODELS_SCRIPT, "refresh", "--proxy-url", PROXY_URL,
            "--token-file", str(JOBS_DIR / "proxy-token"), "--cache", str(models_cache_path())]


def ensure_models():
    """Return the cached model list; refresh it first when missing, in the background when only stale."""
    path = models_cache_path()
    cache = read_json(path)
    if cache is None:
        code = None
        try:
            code = subprocess.run(refresh_cmd(), capture_output=True, timeout=REFRESH_TIMEOUT,
                                  creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0).returncode
        except subprocess.TimeoutExpired:
            pass
        if code == 3:  # another refresh holds the lock: wait for its cache
            deadline = now() + REFRESH_TIMEOUT
            while read_json(path) is None and now() < deadline:
                time.sleep(1)
        cache = read_json(path)
        if cache is None:
            raise Fail("the model list could not be built (volunteer-models.py refresh produced no cache)")
    else:
        refresh_if_stale(cache)
    return cache


def refresh_if_stale(cache):
    """Start the background refresh when the cache is older than MODELS_MAX_AGE (a second one exits on the lock)."""
    age = cache_age(cache)
    if age is None or age > MODELS_MAX_AGE:
        spawn_detached(refresh_cmd(), JOBS_DIR / "refresh.log")


def usable_models(cache):
    return [m for m in (cache or {}).get("models") or [] if m.get("id")]


def first_model():
    cache = read_json(models_cache_path()) or {}
    models = cache.get("models") or []
    return models[0]["id"] if models else None


# ---------- OpenCode config ----------

def bash_rules(read_only):
    if read_only:
        rules = {"*": "deny"}
        for c in READ_ONLY_BASH:
            rules[c] = "allow"
            rules[c + " *"] = "allow"
        return rules
    rules = {"*": "allow"}
    for c in GIT_DENY:
        rules[f"git {c}"] = "deny"
        rules[f"git {c} *"] = "deny"
        rules[f"git * {c}"] = "deny"
        rules[f"git * {c} *"] = "deny"
    return rules


def permission(read_only):
    return {"read": "allow", "edit": "deny" if read_only else "allow", "bash": bash_rules(read_only),
            "external_directory": "deny", "webfetch": "deny", "websearch": "deny", "task": "deny",
            "question": "deny"}


def build_config(state, models, entry):
    """OpenCode config for one run. The token travels by env reference, never in argv."""
    cwd = Path(state["cwd"])
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "provider": {PROVIDER: {
            "npm": "@ai-sdk/openai-compatible", "name": PROVIDER,
            "options": {"baseURL": PROXY_URL + "/v1", "apiKey": "{env:FLP_TOKEN}"},
            "models": {m["id"]: {"name": m["id"], "tool_call": True} for m in models},
        }},
        "mcp": {"context7": {"enabled": False}},
        "permission": permission(state["read_only"]),
        "agent": {"title": {"disable": True}},
    }
    if entry.get("agent") == "minimal":
        cfg["agent"]["minimal"] = {"mode": "primary", "description": "minimal", "prompt": MINIMAL_PROMPT,
                                   "tools": MINIMAL_TOOLS, "permission": permission(state["read_only"])}
    else:
        instructions = [GLOBAL_RULES]
        if (cwd / "CLAUDE.md").exists():
            instructions.append(str(cwd / "CLAUDE.md"))
        cfg["instructions"] = instructions
    return cfg


def build_env(state, models, entry, token):
    env = dict(os.environ)
    env.update(OPENCODE_CONFIG_CONTENT=json.dumps(build_config(state, models, entry)), FLP_TOKEN=token,
               PWD=state["cwd"], PYTHONUTF8="1")
    if os.path.exists(GIT_BASH):
        env["SHELL"] = GIT_BASH
    if entry.get("agent") == "minimal":
        env["OPENCODE_DISABLE_CLAUDE_CODE"] = "1"
    else:
        # OpenCode has no switch that drops only ~/.claude/CLAUDE.md: its prompt flag drops it together with
        # the project CLAUDE.md, which build_config adds back through `instructions`.
        env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"] = "1"
        env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] = "1"
    return env


# ---------- events ----------

def describe_tool(part):
    tool = part.get("tool") or "tool"
    state = part.get("state") or {}
    inp = state.get("input") or {}
    if tool == "bash" and inp.get("command"):
        return short(inp["command"], 300)
    for key in ("filePath", "path", "pattern", "url", "query"):
        if inp.get(key):
            return short(f"{tool} {inp[key]}", 300)
    return short(state.get("title") or tool, 300)


def error_text(e):
    err = e.get("error") or {}
    data = err.get("data") or {}
    msg = data.get("message") or err.get("message") or err.get("name") or "unknown error"
    code = data.get("statusCode")
    return short(f"{err.get('name') or 'error'}{' ' + str(code) if code else ''}: {msg}", 300)


def translate(e):
    """One OpenCode event -> a list of Codex-shaped events."""
    t = e.get("type")
    part = e.get("part") or {}
    if t == "text":
        text = part.get("text") or ""
        if not text.strip():
            return []
        return [{"type": "item.completed", "item": {"id": part.get("id"), "type": "agent_message", "text": text}}]
    if t == "tool_use":
        call = part.get("callID") or part.get("id") or secrets.token_hex(4)
        status = (part.get("state") or {}).get("status")
        item = {"id": call, "type": "command_execution", "command": describe_tool(part)}
        return [{"type": "item.started", "item": dict(item, status="in_progress")},
                {"type": "item.completed", "item": dict(item, status="failed" if status == "error" else "completed")}]
    if t == "step_start":
        return [{"type": "turn.started"}]
    if t == "step_finish" and part.get("reason") == "stop":
        return [{"type": "turn.completed"}]
    if t == "error":
        return [{"type": "turn.failed", "error": {"message": error_text(e)}}]
    return []


def changed_files(cwd):
    try:
        r = subprocess.run(["git", "-C", str(cwd), "status", "--porcelain"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30,
                           creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return [line for line in r.stdout.splitlines() if line.strip()]


# ---------- supervisor ----------

class Supervisor:
    def __init__(self, job_dir):
        self.dir = Path(job_dir)
        self.state_path = self.dir / "state.json"
        self.events_path = self.dir / "events.jsonl"
        self.raw_path = self.dir / "opencode-events.jsonl"
        self.state = read_json(self.state_path)
        self.last_event = now()
        self.t0 = now()
        self.fail_reason = ""
        self.last_text = ""
        self.token = ""
        self.cache, self.models, self.refresh_started = {}, [], False  # the one current model list, see prepare()

    def save(self, **kw):
        self.state.update(kw)
        self.state["updated"] = now()
        write_json(self.state_path, self.state)

    def heartbeat_age(self):
        try:
            return now() - (self.dir / "heartbeat").stat().st_mtime
        except OSError:
            return now() - self.state["created"]

    def note(self, text):
        self.state.setdefault("notes", []).append(f"{hhmm(now())} {text}")
        self.save()

    def command(self, entry, text):
        """argv for one OpenCode run: the full prompt on a fresh session, `text` on a continued one."""
        s = self.state
        cmd = list(OPENCODE_CMD) + ["run", "--format", "json", "-m", f"{PROVIDER}/{entry['id']}"]
        if entry.get("agent") == "minimal":
            cmd += ["--agent", "minimal"]
        if s.get("session_id") and text is not None:
            return cmd + ["-s", s["session_id"], text]
        return cmd + [(self.dir / "prompt.md").read_text(encoding="utf-8")]

    def pump(self, proc, raw_sink, events_sink):
        for raw in proc.stdout:
            raw_sink.write(raw)
            raw_sink.flush()
            self.last_event = now()
            try:
                e = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            sid = e.get("sessionID")
            if sid and sid != self.state.get("session_id"):
                self.save(session_id=sid)
            t = e.get("type")
            if t == "step_finish":
                self.save(steps=self.state.get("steps", 0) + 1)
            elif t == "text":
                text = (e.get("part") or {}).get("text") or ""
                if text.strip():
                    self.last_text = text
            elif t == "error":
                self.fail_reason = error_text(e)
            for out in translate(e):
                events_sink.write((json.dumps(out, ensure_ascii=False) + "\n").encode("utf-8"))
            events_sink.flush()

    def run_once(self, entry, text, models):
        cmd = self.command(entry, text)
        env = build_env(self.state, models, entry, self.token)
        self.fail_reason = ""
        self.last_text = ""
        self.last_event = now()
        flags = CREATE_NO_WINDOW if os.name == "nt" else 0
        with open(self.raw_path, "ab") as raw_sink, open(self.events_path, "ab") as events_sink, \
                open(self.dir / "opencode.err", "ab") as err:
            proc, job = process_job.start(cmd, cwd=self.state["cwd"], env=env, stdin=subprocess.DEVNULL,
                                          stdout=subprocess.PIPE, stderr=err, creationflags=flags)
            reader = None
            reason = None
            try:
                self.save(opencode_pid=proc.pid, status="running")
                reader = threading.Thread(target=self.pump, args=(proc, raw_sink, events_sink), daemon=True)
                reader.start()
                while proc.poll() is None:
                    time.sleep(POLL_SECONDS)
                    if (self.dir / "cancel").exists():
                        reason = "cancelled"
                    elif self.heartbeat_age() > ORPHAN_SECONDS:
                        reason = "orphaned"
                    elif now() - self.t0 > HARD_TIMEOUT_SECONDS:
                        reason = "timeout"
                    elif self.fail_reason:
                        reason = "error"
                    elif now() - self.last_event > IDLE_SECONDS:
                        reason = "hung"
                    if reason:
                        process_job.close(job)
                        break
                proc.wait()
            finally:
                process_job.close(job)
                if proc.poll() is None:
                    proc.wait()
                if reader is not None:
                    reader.join(timeout=10)
                    if not reader.is_alive():
                        proc.stdout.close()
        if reason is None and self.fail_reason:
            reason = "error"
        return reason, proc.returncode

    def prepare(self):
        self.token = ensure_proxy()
        cache = ensure_models()
        models = usable_models(cache)
        if not models:
            rejected = "; ".join(f"{r.get('id')}: {short(r.get('reason'), 60)}" for r in (cache.get("rejected") or [])[:5])
            raise Fail("no free models available" + (f": {rejected}" if rejected else ""))
        self.cache, self.models = cache, models
        self.refresh_started = True  # ensure_models has just spawned the refresh when the cache was stale
        return models

    def reload_models(self):
        """Adopt the current models.json when it changed and holds models; True when the list was replaced.

        A missing, unreadable or empty cache never replaces the list a running job already has."""
        cache = read_json(models_cache_path())
        models = usable_models(cache)
        if not models or cache == self.cache:
            return False
        self.cache, self.models = cache, models
        return True

    def choice_point(self):
        """Called before every model choice: follow the cache, and refresh it in the background when it went stale."""
        self.reload_models()
        if not self.refresh_started:
            refresh_if_stale(self.cache)
        self.refresh_started = False

    def finish(self, status_hint=None):
        report = self.last_text.strip()
        files = changed_files(self.state["cwd"])
        if files:
            shown = files[:CHANGED_FILES_MAX]
            extra = f"\n... and {len(files) - len(shown)} more" if len(files) > len(shown) else ""
            report += "\n\nWorking tree changes (git status --porcelain):\n" + "\n".join(shown) + extra
        (self.dir / "last.md").write_text(report + "\n", encoding="utf-8")
        status, error = validate_report(self.last_text)
        if error:
            if self.state.get("malformed_follow_ups", 0) or not self.state.get("session_id"):
                return self.save(status="malformed", ended=now(), error=None, report_error=error)
            self.save(malformed_follow_ups=1, report_error=error)
            return None
        return self.save(status=status, ended=now(), error=None, report_error=None)

    def estimate_tokens(self):
        """Session size: OpenCode reports no token usage, so count the bytes of everything it has seen."""
        size = 0
        for p in (self.raw_path, self.dir / "prompt.md"):
            try:
                size += p.stat().st_size
            except OSError:
                pass
        return size // BYTES_PER_TOKEN

    def follow_up(self, template, why):
        """Text for a continued session; None on a fresh one (the full prompt is sent then)."""
        if not self.state.get("session_id"):
            return None
        return template.format(when=hhmm(now()), why=short(why, REASON_CHARS))

    def pause(self, waiting, ready, interval, timeout_error):
        """Wait until ready() is true, checking cancel, orphaning and the hard timeout. True when the job was ended here (cancelled, orphaned, blocked)."""
        self.save(waiting=waiting)
        next_check = 0
        while True:
            if (self.dir / "cancel").exists():
                self.save(status="cancelled", ended=now(), waiting=None)
                return True
            if self.heartbeat_age() > ORPHAN_SECONDS:
                self.save(status="orphaned", ended=now(), waiting=None)
                return True
            if now() - self.t0 > HARD_TIMEOUT_SECONDS:
                self.save(status="blocked", ended=now(), error=timeout_error(), waiting=None)
                return True
            if now() >= next_check:
                if ready():
                    break
                next_check = now() + interval
            time.sleep(POLL_SECONDS)
        self.save(waiting=None)
        return None

    def run(self):
        reply = self.dir / "reply.md"
        text = None
        if reply.exists():
            text = reply.read_text(encoding="utf-8")
            reply.unlink()
            self.save(malformed_follow_ups=0)  # a reply starts a new turn with its own malformed follow-up
        self.t0 = now()
        self.save(supervisor_pid=os.getpid(), status="running", started=self.state.get("started") or now())
        try:
            self.prepare()
        except Fail as f:
            return self.save(status="blocked", ended=now(), error=str(f))
        by_id = {m["id"]: m for m in self.models}
        hard_timeout = lambda: f"hard timeout after {HARD_TIMEOUT_SECONDS // 60} min"
        banned, cooling, failures = {}, {}, []
        restarts = 0
        overflow_tokens = 0
        forced = by_id.get(self.state.get("slug")) if self.state.get("session_id") else None
        prev, last_why = (forced["id"] if forced else None), ""
        while True:
            entry, forced = forced, None
            if entry is None:
                self.choice_point()
                est = max(overflow_tokens, self.estimate_tokens())
                alive = [m for m in self.models if m["id"] not in banned]
                if not alive:
                    tail = "; ".join(f"{i.split('/')[-1]}: {w[:70]}" for i, w in failures[-5:])
                    return self.save(status="blocked", ended=now(), error=f"no free models available: {tail}")
                fit = [m for m in alive if model_fits(m, est)]
                if not fit:
                    return self.save(status="blocked", ended=now(),
                                     error=f"no model fits the session context (~{est} tokens)")
                ready = [m for m in fit if cooling.get(m["id"], 0) <= now()]
                if not ready:
                    until = min(cooling[m["id"]] for m in fit)
                    self.note(f"all models cooling down, waiting until {hhmm(until)}")
                    stop = self.pause("models", lambda: now() >= until or self.reload_models(),
                                      POLL_SECONDS, hard_timeout)
                    if stop:
                        return stop
                    continue
                entry = ready[0]
                if prev is not None:
                    if entry["id"] != prev:
                        self.save(switches=self.state.get("switches", 0) + 1)
                        self.note(f"model {prev} failed: {last_why}; switching to {entry['id']}")
                        text = self.follow_up(SWITCH_TEXT, last_why)
                    else:
                        text = self.follow_up(RESUME_TEXT, last_why)
            self.save(slug=entry["id"])
            # a forced retry may name a model the fresh list dropped: OpenCode still needs it in its config
            models = self.models if entry["id"] in {m["id"] for m in self.models} else self.models + [entry]
            reason, code = self.run_once(entry, text, models)
            if reason in ("cancelled", "orphaned"):
                return self.save(status=reason, ended=now())
            if reason == "timeout":
                return self.save(status="blocked", ended=now(), error=hard_timeout())
            if reason is None and code == 0:
                self.finish()
                if self.state.get("status") in TERMINAL:
                    return
                forced = entry
                text = report_module.malformed_follow_up(self.state["report_error"])
                continue
            why = self.fail_reason or {"hung": f"no events for {IDLE_SECONDS // 60 or IDLE_SECONDS} "
                                                f"{'min' if IDLE_SECONDS >= 60 else 's'}"}.get(reason) or \
                f"exit code {code}" + ("" if self.last_text.strip() else ", no final message")
            last_why = short(why, REASON_CHARS)
            failures.append((entry["id"], last_why))
            prev = entry["id"]
            # blame the model only when the gateway and the internet are healthy
            try:
                gateway_up = proxy_up(self.token)
            except Fail as f:
                return self.save(status="blocked", ended=now(), error=str(f))
            if not gateway_up:
                restarts += 1
                if restarts > MAX_GATEWAY_RESTARTS:
                    return self.save(status="blocked", ended=now(), error="gateway keeps dying (see proxy.log)")
                try:
                    self.token = ensure_proxy()
                except Fail as f:
                    return self.save(status="blocked", ended=now(), error=str(f))
                self.note(f"gateway was down, restarted; retrying {entry['id']}")
                forced, text = entry, self.follow_up(RESUME_TEXT, last_why)
                continue
            up = lambda: network_up([m["id"] for m in self.models if m["id"] not in banned])
            if not up():
                since = now()
                self.note("no network, waiting")
                stop = self.pause("network", up,
                                  NETWORK_POLL_SECONDS, lambda: f"no network since {hhmm(since)}")
                if stop:
                    return stop
                forced, text = entry, self.follow_up(RESUME_TEXT, last_why)
                continue
            if is_permanent_failure(why):
                banned[entry["id"]] = last_why
                found = OVERFLOW_TOKENS_RE.search(why)
                if found:
                    overflow_tokens = max(overflow_tokens, int(found.group(1).replace(",", "")))
            else:
                cooling[entry["id"]] = now() + MODEL_COOLDOWN_SECONDS


# ---------- client commands ----------

def job_dir(job):
    d = JOBS_DIR / job
    if not (d / "state.json").exists():
        sys.exit(f"ERROR: no job {job}")
    return d


def take_prompt(path):
    """Read a prompt file; a volunteer-prompt-*.md file the relay wrote is removed once read."""
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    if path.name.startswith("volunteer-prompt-") and path.suffix == ".md":
        path.unlink(missing_ok=True)
    return text


def cleanup_old_jobs():
    if not JOBS_DIR.exists():
        return
    cutoff = now() - KEEP_JOBS_DAYS * 86400
    for d in JOBS_DIR.iterdir():
        if not d.is_dir():
            continue
        st = read_json(d / "state.json") or {}
        if st.get("status") in TERMINAL and st.get("updated", now()) < cutoff:
            shutil.rmtree(d, ignore_errors=True)


def spawn_supervisor(d):
    cmd = [sys.executable, "-I", str(Path(__file__).resolve()), "_supervise", str(d)]
    spawn_detached(cmd, d / "supervisor.log")


def cmd_start(a):
    try:
        cwd = check_cwd(a.cwd or os.getcwd())
    except Fail as f:
        sys.exit(f"REFUSED: {f}")
    prompt = take_prompt(a.prompt_file)
    full = prompt.rstrip() + RUN_RULES
    if len(full) > MAX_PROMPT_CHARS:
        sys.exit(f"ERROR: the prompt is {len(full)} characters; the limit is {MAX_PROMPT_CHARS}")
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_old_jobs()
    job = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
    d = JOBS_DIR / job
    d.mkdir(parents=True)
    model = first_model() or "pending"
    (d / "prompt.md").write_text(full, encoding="utf-8")
    write_json(d / "state.json", {
        "job": job, "slug": model, "effort": "-", "read_only": a.read_only,
        "cwd": str(cwd), "status": "starting",
        "created": now(), "updated": now(), "switches": 0, "steps": 0, "notes": [],
    })
    (d / "heartbeat").touch()
    spawn_supervisor(d)
    print(f"volunteer job {job} started: {model}, cwd {cwd}")
    # return at once: the job id reaches the relay's transcript only when this call ends, and the hub
    # reads it there to show the job live
    print(f"\n(still running; call: wait {job})")


def digest(d, st, events, final):
    lines = []
    elapsed = int((st.get("ended") or now()) - st.get("started", st["created"])) // 60
    cmds = sum(1 for e in events if e.get("type") == "item.completed"
               and (e.get("item") or {}).get("type") == "command_execution")
    last_ts = (d / "events.jsonl").stat().st_mtime if (d / "events.jsonl").exists() else st["created"]
    lines.append(f"volunteer job {st['job']} · {st['status']} · {st['slug']} · {elapsed} min"
                 f" · last activity {hhmm(last_ts)} · {cmds} commands since last check"
                 f" · switches {st.get('switches', 0)}")
    for n in st.get("notes", [])[-3:]:
        lines.append(f"note: {n}")
    msgs, last_cmd = [], None
    for e in events:
        it = e.get("item") or {}
        kind = it.get("type")
        if e.get("type") == "item.started" and kind == "command_execution":
            last_cmd = it.get("command")
        if e.get("type") == "item.completed" and kind == "agent_message":
            msgs.append(it.get("text") or "")
    if not final:
        for m in [m for m in msgs if not report_module.has_status_line(m)][-DIGEST_MESSAGES:]:
            lines.append(f"volunteer: {short(m)}")
        if last_cmd:
            lines.append(f"running: {short(last_cmd, 160)}")
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
                lines.append(f"last volunteer message: {short(msgs[-1], 800)}")
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
    deadline = now() + 15
    while now() < deadline and (read_json(d / "state.json") or {}).get("status") not in TERMINAL:
        time.sleep(1)
    st = read_json(d / "state.json") or {}
    if st.get("status") not in TERMINAL:
        kill_pid(st.get("supervisor_pid"))
        st.update(status="cancelled", ended=now())
        write_json(d / "state.json", st)
    print(f"job {a.job}: {st.get('status')}")


def cmd_prompt_path(a):
    # the relay has no clock: a name it made up itself would clash between relays started together
    name = datetime.now().strftime("volunteer-prompt-%Y%m%d-%H%M%S-") + secrets.token_hex(4) + ".md"
    print(Path(a.cwd).resolve() / ".tmp" / name)


def cmd_list(a):
    if not JOBS_DIR.exists():
        return print("no jobs")
    dirs = [d for d in sorted(JOBS_DIR.iterdir()) if (d / "state.json").exists()]
    for d in dirs[-15:]:
        st = read_json(d / "state.json") or {}
        print(f"{d.name}  {st.get('status')}  {st.get('slug')}  {st.get('cwd')}")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "_supervise":
        return Supervisor(sys.argv[2]).run()
    if len(sys.argv) >= 3 and sys.argv[1] == "_launch":
        return run_launch(sys.argv[2])
    if len(sys.argv) >= 2 and sys.argv[1] == "proxy-serve":
        return run_proxy_serve()
    p =argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("--prompt-file", required=True)
    s.add_argument("--cwd")
    s.add_argument("--read-only", action="store_true")
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
    a = p.parse_args()
    handlers = {"start": cmd_start, "wait": cmd_wait, "attach": cmd_wait, "reply": cmd_reply,
                "cancel": cmd_cancel, "list": cmd_list, "prompt-path": cmd_prompt_path}
    handlers[a.cmd](a)


if __name__ == "__main__":
    if os.name == "nt":
        sys.stdout.reconfigure(encoding="utf-8")
    main()

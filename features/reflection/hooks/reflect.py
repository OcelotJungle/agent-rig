"""Stop hook: a cheap reviewer looks at the turn before it ends.

Haiku gets the user's rules, the last few user messages and what the assistant did since (short
tool inputs and results, with times and how long each call took), and may read the whole turn from a
file. It answers ok, problem or unsure; on unsure Sonnet decides. Catch-up mode (asyncRewake): the
answer has already gone out; a serious problem exits 2 with the reason on stderr and wakes the
assistant for a short follow-up. The woken turn is never reviewed (WAKE_MARKER in its start, and a
one-shot stamp file for WAKE_GUARD_SECONDS).

Skipped: claude's own non-interactive runs (claude -p, SDK), the reviewer's own runs, and turns with
no tool call and a short reply. A reviewer that fails after its retries lets the turn end.

Input: hook JSON on stdin. Output: exit 2 with the reason on stderr, or exit 0 with nothing;
the reason asks the assistant to open its follow-up with the findings, since the user sees only the reply.
Every review goes to ~/.claude/reflect/log.jsonl with its verdict, cost and time.

Replay for tests, never blocks: python reflect.py --replay <transcript.jsonl> <line>
reviews the turn that ends before that line of the transcript.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(REPOSITORY_ROOT / "base" / "hooks"))
from compact_history import block_text, clip, iter_line_events  # noqa: E402

HOME_CLAUDE = Path.home() / ".claude"
PROMPT_FILE = Path(__file__).with_name("reflect_prompt.md")
STATE_DIR = HOME_CLAUDE / "reflect"
LOG_FILE = STATE_DIR / "log.jsonl"
TURNS_DIR = STATE_DIR / "turns"
CHILD_ENV = "REFLECT_CHILD"

FIRST_MODEL = "haiku"
SECOND_MODEL = "sonnet"
BUDGET_USD = {FIRST_MODEL: "0.15", SECOND_MODEL: "0.40"}
USER_MESSAGES = 3
CONVERSATION_BUDGET = 40_000
RULES_LIMIT = 14_000
TEXT_LIMIT = 3_000
OLD_TEXT_LIMIT = 800
EVENT_LIMIT = 400
CALL_LIMIT = 300
RESULT_LIMIT = 500
FULL_CALL_LIMIT = 1_500
FULL_RESULT_LIMIT = 2_000
SLOW_SECONDS = 60
TRIVIAL_REPLY = 300
ATTEMPTS = 3
RETRY_PAUSE = 5
CALL_TIMEOUT = 120
DEADLINE = 300
TURN_FILE_DAYS = 3
TAIL_CHUNK = 4 * 1024 * 1024
REPLAY_KEEP = 64 * 1024 * 1024
MAX_PROBLEMS = 3
WAKE_EXIT = 2
WAKE_GUARD_SECONDS = 600
WAKE_DIR = STATE_DIR / "wake"
WAKE_MARKER = "[reflect-catchup]"
SERIOUS_KINDS = frozenset({1, 2, 3, 4, 5})

REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)
EVENT_MARKS = ("<task-notification>", "[SYSTEM NOTIFICATION", "<agent-message", "Another Claude session sent a message")
# The user's words that arrive like events: a topic message that interrupted the work comes as a
# peer message. And a channel message of telegram-hub itself (user="telegram-hub") is an event, not the user.
USER_MARKS = ("telegram-hub: the user interrupted your work from Telegram",)
TELEGRAM_HUB_OWN = re.compile(r'<channel\b[^>]*\buser="telegram-hub"')
TOOL_KINDS = ("tool_use", "tool_result")
# The user's own words: typed or Telegram messages, and answers to a poll (AskUserQuestion's result).
USER_KINDS = ("user", "answer")
POLL_TOOL = "AskUserQuestion"
# Attachment lines line_events reads itself: queued user messages and session notes.
SESSION_MARKS = ('"queued_command"', '"instructions"', '"deferred_tools_delta"')


def schema(verdicts: list[str]) -> str:
    problem = {
        "type": "object",
        "properties": {
            "kind": {"type": "integer"},
            "evidence": {"type": "string"},
            "what": {"type": "string"},
            "fix": {"type": "string"},
        },
        "required": ["kind", "evidence", "what", "fix"],
        "additionalProperties": False,
    }
    return json.dumps({
        "type": "object",
        "properties": {"verdict": {"enum": verdicts}, "problems": {"type": "array", "items": problem}},
        "required": ["verdict", "problems"],
        "additionalProperties": False,
    })


def log(entry: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry}
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def seconds_between(start: str, end: str) -> float | None:
    try:
        return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
    except ValueError:
        return None


def tail_lines(transcript: Path) -> list[str]:
    """The transcript's last lines, enough to hold USER_MESSAGES messages of the user: a long
    session's transcript runs to hundreds of MB, and reading it whole would hold every turn's end."""
    size = transcript.stat().st_size
    chunk = TAIL_CHUNK
    while True:
        start = max(0, size - chunk)
        with transcript.open("rb") as f:
            f.seek(start)
            raw = f.read()
        lines = raw.decode("utf-8", errors="replace").splitlines()
        if start > 0:
            lines = lines[1:]
        if start == 0 or sum(1 for e in events_of(lines) if e["kind"] == "user") >= USER_MESSAGES:
            return lines
        chunk *= 2


def session_note(attachment: dict) -> str | None:
    """What a session attachment says about the window itself: the instruction files re-read when
    the session (re)started, the tools that came or went (a new plugin version after a restart)."""
    kind = attachment.get("type")
    if kind == "instructions":
        return "the session (re)started: instruction files re-read"
    if kind == "deferred_tools_delta":
        added = ", ".join(attachment.get("addedNames") or [])
        removed = ", ".join(attachment.get("removedNames") or [])
        parts = ([f"tools now available: {added}"] if added else []) + ([f"tools removed: {removed}"] if removed else [])
        return "; ".join(parts) or None
    return None


def line_events(lines: list[str]):
    """iter_line_events plus the user's messages that came while the assistant worked (stored as
    queued_command attachments, not as user entries) and session notes (see session_note)."""
    for line in lines:
        if any(mark in line for mark in SESSION_MARKS):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            attachment = entry.get("attachment") or {}
            stamp = (entry.get("timestamp") or "")[:19].replace("T", " ")
            prompt = attachment.get("prompt")
            if entry.get("type") == "attachment" and attachment.get("type") == "queued_command" and isinstance(prompt, str):
                yield "user", stamp, prompt
                continue
            note = session_note(attachment) if entry.get("type") == "attachment" else None
            if note:
                yield "session", stamp, note
                continue
        yield from iter_line_events([line])


def is_users(text: str) -> bool:
    """The user's words, typed or from Telegram, or a notification."""
    if any(m in text for m in USER_MARKS):
        return True
    return not any(m in text for m in EVENT_MARKS) and not TELEGRAM_HUB_OWN.search(text)


def events_of(lines: list[str]) -> list[dict]:
    """The main chain as {kind, stamp, ...}: user (the user's words), event (a notification),
    assistant, tool_use, tool_result (with the seconds since its call)."""
    out: list[dict] = []
    called: dict[str, str] = {}
    polls: set[str] = set()
    for kind, stamp, data in line_events(lines):
        if kind == "user":
            text = REMINDER.sub("", data).strip()
            if text:
                out.append({"kind": "user" if is_users(text) else "event", "stamp": stamp, "text": text})
        elif kind == "assistant":
            out.append({"kind": "assistant", "stamp": stamp, "text": data})
        elif kind == "tool_use":
            called[data.get("id", "")] = stamp
            if data.get("name") == POLL_TOOL:
                polls.add(data.get("id", ""))
            args = json.dumps(data.get("input"), ensure_ascii=False)
            out.append({"kind": "tool_use", "stamp": stamp, "name": data.get("name"), "args": args})
        elif kind == "tool_result" and data.get("tool_use_id", "") in polls and not data.get("is_error"):
            # a poll's result holds the user's own answers, not tool output
            out.append({"kind": "answer", "stamp": stamp, "text": block_text(data.get("content"))})
        elif kind == "tool_result":
            start = called.get(data.get("tool_use_id", ""))
            took = seconds_between(start, stamp) if start else None
            out.append({"kind": "tool_result", "stamp": stamp, "text": block_text(data.get("content")), "error": bool(data.get("is_error")), "took": took})
        elif kind in ("boundary", "summary", "session"):
            out.append({"kind": kind, "stamp": stamp, "text": data})
    return out


def window(events: list[dict]) -> list[dict]:
    """From the USER_MESSAGES-th last message of the user to the end."""
    users = [i for i, e in enumerate(events) if e["kind"] == "user"]
    start = users[-USER_MESSAGES] if len(users) >= USER_MESSAGES else 0
    return [e for e in events[start:] if e["kind"] != "summary"]


def current_turn(events: list[dict]) -> list[dict]:
    """The events since the last message that started a turn (the user's or a notification)."""
    starts = [i for i, e in enumerate(events) if e["kind"] in ("user", "event")]
    return events[starts[-1] + 1:] if starts else events


def line_of(event: dict, call_limit: int, result_limit: int, text_limit: int) -> str:
    time_of = event["stamp"][11:19]
    kind = event["kind"]
    if kind == "user":
        return f"[{time_of}] USER: {clip(event['text'], text_limit)}"
    if kind == "answer":
        return f"[{time_of}] USER (poll answer): {clip(event['text'], text_limit)}"
    if kind == "event":
        return f"[{time_of}] NOTIFICATION: {clip(event['text'], EVENT_LIMIT)}"
    if kind == "assistant":
        return f"[{time_of}] ASSISTANT: {clip(event['text'], text_limit)}"
    if kind == "tool_use":
        return f"[{time_of}] CALL {event['name']}: {clip(event['args'], call_limit)}"
    if kind == "tool_result":
        took = event["took"]
        slow = f" (took {took / 60:.1f} min)" if took is not None and took >= SLOW_SECONDS else ""
        error = " ERROR" if event["error"] else ""
        return f"[{time_of}] RESULT{error}{slow}: {clip(event['text'], result_limit)}"
    if kind == "session":
        return f"[{time_of}] SESSION: {event['text']}"
    return f"[{time_of}] COMPACTION"


def conversation(events: list[dict]) -> str:
    """The window in CONVERSATION_BUDGET chars: the oldest tool events go first, then old
    assistant messages are clipped, then the oldest lines go."""
    lines = [{"kind": e["kind"], "text": line_of(e, CALL_LIMIT, RESULT_LIMIT, TEXT_LIMIT), "event": e} for e in events]
    total = sum(len(line["text"]) for line in lines)
    for line in lines:
        if total <= CONVERSATION_BUDGET:
            break
        if line["kind"] in TOOL_KINDS:
            total -= len(line["text"])
            line["text"] = None
    last_user = max((i for i, line in enumerate(lines) if line["kind"] == "user"), default=0)
    for i, line in enumerate(lines):
        if total <= CONVERSATION_BUDGET:
            break
        if line["kind"] == "assistant" and line["text"] and i < last_user:
            short = line_of(line["event"], CALL_LIMIT, RESULT_LIMIT, OLD_TEXT_LIMIT)
            total -= len(line["text"]) - len(short)
            line["text"] = short
    for line in lines:
        if total <= CONVERSATION_BUDGET:
            break
        if line["kind"] not in USER_KINDS and line["text"]:
            total -= len(line["text"])
            line["text"] = None
    out: list[str] = []
    cut = 0
    for line in lines:
        if line["text"] is None:
            cut += 1
            continue
        if cut:
            out.append(f"[... {cut} events cut here; they are in the FULL TURN file]")
            cut = 0
        out.append(line["text"])
    return "\n".join(out)


def rules(payload: dict, transcript: Path) -> str:
    cwd = Path(payload.get("cwd") or ".")
    files = [HOME_CLAUDE / "CLAUDE.md", cwd / "CLAUDE.md", cwd / ".claude" / "CLAUDE.md", transcript.parent / "memory" / "MEMORY.md"]
    parts = [f"--- {f}\n{clip(f.read_text(encoding='utf-8'), RULES_LIMIT)}" for f in files if f.is_file()]
    return "\n\n".join(parts) or "(none)"


def prune_turns() -> None:
    cutoff = time.time() - TURN_FILE_DAYS * 86_400
    for f in TURNS_DIR.glob("*.md"):
        if f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)


def ask(model: str, verdicts: list[str], text: str, cwd: str, dirs: list[Path], started: float) -> tuple[dict | None, float, str]:
    """One reviewer, with retries for a dropped network. Returns (answer, cost, error)."""
    claude = shutil.which("claude")
    if not claude:
        return None, 0.0, "claude not on PATH"
    cmd = [claude, "-p", "--model", model, "--tools", "Read,Grep", "--allowedTools", "Read,Grep"]
    for d in dirs:
        cmd += ["--add-dir", str(d)]
    cmd += [
        "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config",
        "--setting-sources", "", "--system-prompt-file", str(PROMPT_FILE),
        "--json-schema", schema(verdicts), "--output-format", "json",
        "--max-budget-usd", BUDGET_USD[model],
    ]
    env = dict(os.environ, **{CHILD_ENV: "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"})
    cost, error = 0.0, ""
    for attempt in range(ATTEMPTS):
        if time.monotonic() - started + CALL_TIMEOUT > DEADLINE:
            return None, cost, error or "no time left"
        if attempt:
            time.sleep(RETRY_PAUSE)
        try:
            proc = subprocess.run(cmd, input=text, capture_output=True, text=True, encoding="utf-8", env=env, cwd=cwd, timeout=CALL_TIMEOUT)
            envelope = json.loads(proc.stdout)
        except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as e:
            error = f"{type(e).__name__}: {str(e)[:200]}"
            continue
        cost += envelope.get("total_cost_usd") or 0.0
        answer = envelope.get("structured_output")
        if not envelope.get("is_error") and isinstance(answer, dict) and answer.get("verdict") in verdicts:
            return answer, cost, ""
        error = str(envelope.get("result") or envelope.get("subtype"))[:200]
    return None, cost, error


def review(payload: dict) -> tuple[str, dict | None]:
    """Returns (what happened, the answer that blocks or None)."""
    started = time.monotonic()
    transcript = Path(payload.get("transcript_path") or "")
    if not transcript.is_file():
        return "no transcript", None
    events = events_of(tail_lines(transcript))
    final = payload.get("last_assistant_message") or ""
    turn = current_turn(events)
    if not any(e["kind"] == "tool_use" for e in turn) and len(final) < TRIVIAL_REPLY:
        return "trivial", None

    session = payload.get("session_id") or transcript.stem
    TURNS_DIR.mkdir(parents=True, exist_ok=True)
    prune_turns()
    full_file = TURNS_DIR / f"{session}.md"
    shown = window(events)
    full_file.write_text("\n\n".join(line_of(e, FULL_CALL_LIMIT, FULL_RESULT_LIMIT, 10**9) for e in shown), encoding="utf-8")

    text = (
        f"RULES\n{rules(payload, transcript)}\n\n"
        f"CONVERSATION\n{conversation(shown)}\n\n"
        f"FINAL MESSAGE\n{final}\n\n"
        f"FULL TURN\n{full_file}\n"
    )
    if os.environ.get("REFLECT_DRY"):
        (TURNS_DIR / f"{session}.input.txt").write_text(text, encoding="utf-8")
        return f"dry: input {len(text)} chars, read {round(time.monotonic() - started, 1)}s", None
    memory = transcript.parent / "memory"
    dirs =[TURNS_DIR] + ([memory] if memory.is_dir() else [])
    cwd = payload.get("cwd") or str(Path.cwd())

    answer, cost, error = ask(FIRST_MODEL, ["ok", "problem", "unsure"], text, cwd, dirs, started)
    judge = FIRST_MODEL
    if answer and answer["verdict"] == "unsure":
        doubts = json.dumps(answer["problems"], ensure_ascii=False)
        second_text = f"{text}\nFIRST REVIEWER WAS UNSURE ABOUT\n{doubts}\n\nDecide `ok` or `problem`; `unsure` is not open to you.\n"
        second, second_cost, error = ask(SECOND_MODEL, ["ok", "problem"], second_text, cwd, dirs, started)
        cost += second_cost
        judge = f"{FIRST_MODEL}+{SECOND_MODEL}"
        answer = second
    seconds = round(time.monotonic() - started, 1)
    verdict = answer["verdict"] if answer else "failed"
    log({"session": session, "cwd": cwd, "judge": judge, "verdict": verdict, "cost": round(cost, 4), "seconds": seconds, "error": error or None, "problems": answer["problems"] if answer else []})
    if verdict == "problem":
        answer = {**answer, "problems": [p for p in answer["problems"] if p.get("kind") in SERIOUS_KINDS]}
    return f"{judge}: {verdict}, ${cost:.4f}, {seconds}s{', ' + error if error else ''}", answer if verdict == "problem" and answer["problems"] else None


def reason(answer: dict) -> str:
    items = [f"{i}. {p['what']} ({p['evidence']}). Сделай: {p['fix']}" for i, p in enumerate(answer["problems"][:MAX_PROBLEMS], 1)]
    return (
        f"{WAKE_MARKER} Рефлексия по твоему предыдущему ответу, он уже отправлен пользователю:\n" + "\n".join(items) + "\n\n"
        "Начни КОРОТКОЕ дополнительное сообщение блоком «Рефлексия:», где каждый пункт идёт своей строкой от первого лица, "
        "как твоя собственная рефлексия: что ты упустил и что теперь сделал («я не выяснил X — выяснил: …», «я не сделал Y — сделал»). "
        "Где пункт неверен, коротко скажи почему. Где пункт верен и в отправленном ответе что-то неполно или неверно "
        "(что угодно: абзац, список, объяснение, цифра, вывод, рекомендация), одной пометки о пробеле мало: "
        "пришли эту часть заново, исправленную и целиком, чтобы пользователь мог читать её вместо старой. "
        "Части, которых пункты не касаются, не повторяй. "
        "Никаких «хук сказал», «она нашла», «замечание»."
    )


def wake_file(payload: dict) -> Path:
    session = re.sub(r"[^\w-]", "_", str(payload.get("session_id") or "none"))
    return WAKE_DIR / f"{session}.stamp"


def arm_wake_guard(payload: dict) -> None:
    """Written when the hook wakes the assistant: the next Stop of the session is the woken turn's."""
    WAKE_DIR.mkdir(parents=True, exist_ok=True)
    wake_file(payload).write_text(str(time.time()), encoding="utf-8")


def guard_hit(payload: dict) -> bool:
    """True once after a wake within WAKE_GUARD_SECONDS; the stamp is cleared either way."""
    stamp = wake_file(payload)
    if not stamp.is_file():
        return False
    try:
        fresh = time.time() - float(stamp.read_text(encoding="utf-8")) < WAKE_GUARD_SECONDS
    except ValueError:
        fresh = False
    stamp.unlink(missing_ok=True)
    return fresh


def started_by_wake(transcript: Path) -> bool:
    """The turn under review began with our own wake text: it sits after the user's last message
    in a line that is not the assistant's own."""
    if not transcript.is_file():
        return False
    lines = tail_lines(transcript)
    last_user = max((i for i, line in enumerate(lines) if any(k == "user" and WAKE_MARKER not in t for k, _, t in line_events([line]))), default=-1)
    return any(WAKE_MARKER in line and not re.search(r'"type"\s*:\s*"assistant"', line) for line in lines[last_user + 1:])


def skipped(payload: dict) -> bool:
    entry = os.environ.get("CLAUDE_CODE_ENTRYPOINT", "")
    if bool(os.environ.get(CHILD_ENV)) or entry.startswith("sdk") or os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0" or bool(payload.get("stop_hook_active")):
        return True
    if guard_hit(payload):
        return True
    return started_by_wake(Path(payload.get("transcript_path") or ""))


def replay(transcript: Path, line: int) -> None:
    """Review the turn that ends before `line` (1-based) of a transcript; print, never block."""
    head: deque[str] = deque()
    kept = 0
    with transcript.open(encoding="utf-8") as f:
        for _, raw in zip(range(line - 1), f):
            head.append(raw)
            kept += len(raw)
            while kept > REPLAY_KEEP:
                kept -= len(head.popleft())
    last = ""
    for raw in head:
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "assistant" and not entry.get("isSidechain"):
            texts = [b.get("text", "") for b in (entry.get("message") or {}).get("content") or [] if isinstance(b, dict) and b.get("type") == "text"]
            last = "\n".join(t for t in texts if t.strip()) or last
    with tempfile.TemporaryDirectory() as tmp:
        cut = Path(tmp) / transcript.name
        cut.write_text("".join(head), encoding="utf-8")
        (Path(tmp) / "memory").mkdir()
        memory = transcript.parent / "memory" / "MEMORY.md"
        if memory.is_file():
            shutil.copyfile(memory, Path(tmp) / "memory" / "MEMORY.md")
        payload = {"transcript_path": str(cut), "session_id": f"replay-{line}", "cwd": os.getcwd(), "last_assistant_message": last}
        what, answer = review(payload)
    print(what)
    print(json.dumps(answer, ensure_ascii=False, indent=1) if answer else "no block")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) == 4 and sys.argv[1] == "--replay":
        replay(Path(sys.argv[2]), int(sys.argv[3]))
        return
    payload = json.load(sys.stdin)
    if skipped(payload):
        return
    try:
        _, answer = review(payload)
    except Exception as e:  # a broken reviewer must never hold the turn
        log({"session": payload.get("session_id"), "verdict": "crashed", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        return
    if answer:
        arm_wake_guard(payload)
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stderr.write(reason(answer))
        sys.exit(WAKE_EXIT)


if __name__ == "__main__":
    main()

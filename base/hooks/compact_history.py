"""SessionStart(compact) hook: keep the pre-compaction history greppable.

Compaction replaces the conversation with a summary, but the session transcript
(.jsonl) keeps every message. This hook renders that transcript into a readable
Markdown file next to it and tells the model where both files are, so details
lost in the summary can be recovered with Grep instead of re-reading code.

Input: hook JSON on stdin (session_id, transcript_path).
Output: SessionStart JSON with additionalContext.
"""

import json
import sys
from pathlib import Path

TOOL_INPUT_LIMIT = 1500
TOOL_RESULT_LIMIT = 2000
META_KEPT = ("channel", "peer")


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [{len(text) - limit} more chars clipped; full text in the .jsonl]"


def block_text(content) -> str:
    """Flatten a tool_result content field (string or list of blocks) to text."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict):
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            else:
                parts.append(f"[{block.get('type')} block]")
    return "\n".join(parts)


def iter_events(transcript: Path):
    """Yield (kind, stamp, data) for the main conversation chain of a transcript.

    kind is one of: boundary, summary, user, assistant, tool_use, tool_result.
    data: text for boundary/summary/user/assistant; the block dict for tool events.
    Sidechain (subagent) entries, meta entries (but channel and peer messages) and thinking
    blocks are skipped.
    """
    with transcript.open(encoding="utf-8") as f:
        yield from iter_line_events(f)


def iter_line_events(lines):
    """iter_events over transcript lines already read (e.g. only a transcript's tail)."""
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("isSidechain"):
            continue
        kind = entry.get("type")
        stamp = (entry.get("timestamp") or "")[:19].replace("T", " ")

        if kind == "system" and entry.get("subtype") == "compact_boundary":
            yield "boundary", stamp, ""
            continue
        if kind not in ("user", "assistant"):
            continue
        # Meta entries are Claude Code's own (caveats, reminders), except messages from a channel
        # (the user writing from Telegram) and from peers (subagent reports, telegram-hub interrupts).
        if entry.get("isMeta") and (entry.get("origin") or {}).get("kind") not in META_KEPT:
            continue

        content = (entry.get("message") or {}).get("content")
        if entry.get("isCompactSummary"):
            yield "summary", stamp, block_text(content)
            continue
        if isinstance(content, str):
            yield kind, stamp, content
            continue

        for block in content or []:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text" and block.get("text", "").strip():
                yield kind, stamp, block["text"]
            elif btype in ("tool_use", "tool_result"):
                yield btype, stamp, block


def format_event(kind: str, stamp: str, data, input_limit: int, result_limit: int) -> str:
    if kind == "boundary":
        return f"\n---\n## [{stamp}] COMPACTION BOUNDARY\n"
    if kind == "summary":
        return f"## [{stamp}] COMPACTION SUMMARY\n\n{data}\n"
    if kind == "tool_use":
        args = json.dumps(data.get("input"), ensure_ascii=False, indent=1)
        return f"### [{stamp}] TOOL CALL {data.get('name')}\n\n```\n{clip(args, input_limit)}\n```\n"
    if kind == "tool_result":
        status = " (error)" if data.get("is_error") else ""
        text = clip(block_text(data.get("content")), result_limit)
        return f"### [{stamp}] TOOL RESULT{status}\n\n```\n{text}\n```\n"
    return f"## [{stamp}] {kind.upper()}\n\n{data}\n"


def render(transcript: Path) -> str:
    out = [
        f"# Session history: {transcript.stem}",
        "",
        "Rendered from the session transcript after compaction. Thinking blocks are omitted;",
        f"tool inputs and results are clipped. Raw source: {transcript}",
        "",
    ]
    for kind, stamp, data in iter_events(transcript):
        out.append(format_event(kind, stamp, data, TOOL_INPUT_LIMIT, TOOL_RESULT_LIMIT))
    return "\n".join(out)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    payload = json.load(sys.stdin)
    transcript = Path(payload.get("transcript_path") or "")
    if not transcript.is_file():
        return

    history = transcript.parent / transcript.stem / "pre-compact-history.md"
    history.parent.mkdir(parents=True, exist_ok=True)
    history.write_text(render(transcript), encoding="utf-8")

    context = (
        "The conversation was just compacted. The full pre-compaction history is on disk:\n"
        f"- readable: {history}\n"
        f"- raw transcript: {transcript}\n"
        "When the summary lacks a detail you need (an exact command, error text, a decision, "
        "what you changed in a file), Grep the readable history for it before re-reading or "
        "re-exploring code. Do not read the whole file; it is large."
    )
    json.dump(
        {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}},
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()

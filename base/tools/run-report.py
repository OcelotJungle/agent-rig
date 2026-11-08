"""Shared final-report contract for supervised agent runs."""
import re

REPORT_FORM = """- End with this report and nothing after it:
  STATUS: done | question | blocked
  Done: 3-7 bullets
  Changed files: paths only
  Tests: one line
  Questions: for question, each question with its options and a recommendation; otherwise "none"
  Blocked by: for blocked, "access: ..." or "environment: ...": what exactly blocks, where (file:line or the brief line), and what is needed to continue; otherwise "none"
  Risks: bullets or "none"
"""

DECISION_RULES = """- More work than expected is never a reason to stop. Work required by the brief or directly needed for it is part of the task.
- question is only for a decision the brief, code and docs leave open that changes behaviour, data or money. Finish independent work first.
- If two brief requirements contradict, quote both verbatim, give options and a recommendation, and end with question. Never silently do half.
- blocked is only for missing access or an environment failure after one retry that makes continuing impossible.
- Unfinished work is never blocked: if the task is not done and nothing blocks it, keep working until it is done.
"""

STATUS_LINE = re.compile(r"^[ \t]*STATUS:[ \t]*(.*?)[ \t]*$", re.I | re.M)
HEADING = re.compile(r"^[ \t]*(?:Done|Changed files|Tests|Questions|Blocked by|Risks):[ \t]*", re.I | re.M)


def has_status_line(text):
    """True when an agent message carries a report STATUS line: the report is for the orchestrator, never progress."""
    return bool(STATUS_LINE.search(text))


def validate_report(report):
    match = STATUS_LINE.search(report)
    if not match:
        return None, "missing STATUS line"
    status = match.group(1).lower()
    if status not in ("done", "question", "blocked"):
        return None, "invalid status in STATUS line"
    required = {"question": "Questions", "blocked": "Blocked by"}.get(status)
    if required:
        sections = list(HEADING.finditer(report, match.end()))
        for index, section in enumerate(sections):
            if section.group().strip().lower().startswith(required.lower() + ":"):
                end = sections[index + 1].start() if index + 1 < len(sections) else len(report)
                value = report[section.end():end].strip()
                if status == "blocked":
                    # A bulleted or bold cause ("- access: ...", "**access:** ...") is the same cause.
                    cause = re.match(r"(?:access|environment):\s*(.*)", value.lstrip("- *\t\r\n"), re.I | re.S)
                    if cause and cause.group(1).strip().lower().strip("- *\t\r\n.") not in ("", "none"):
                        return status, None
                    break
                if value and value.lower().strip("- *\t\r\n.") != "none":
                    return status, None
                break
        if status == "blocked":
            return None, "blocked needs an access or environment cause; unfinished work is not a blocker"
        return None, f"missing or empty {required} section"
    return status, None


def malformed_follow_up(error):
    return (f"The report did not follow the required form: {error}. If nothing blocks you, continue and finish "
            "the task; otherwise end with question or blocked, in the required form.\n\n" + REPORT_FORM)

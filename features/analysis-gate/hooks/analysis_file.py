"""Validity check for a project's analysis file, <project>/.tmp/analysis.md.

Shared by the hooks that gate Agent launches and that run the reflection at Stop. Stdlib only.
The clock is passed in as `now`, so the check never reads time itself.
"""
import os
from pathlib import Path

ANALYSIS_RELATIVE = ".tmp/analysis.md"
# The 30 minutes is the user's choice: an analysis older than this no longer describes the current work.
FRESH_SECONDS = 30 * 60
SECONDS_PER_MINUTE = 60
SECTIONS = ("## Unknowns", "## Class")
REQUIREMENT = ('the file needs two sections: `## Unknowns` (what is not known yet and could change the work or its time) '
               'and `## Class` (for each defect: the principle it breaks and every site that breaks it the same way; '
               'or "no defect: <what is being built>").')


def project_root(payload):
    # Same root as project-tmp.sh: CLAUDE_PROJECT_DIR, else the hook payload's cwd, else the process cwd.
    env_root = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_root:
        return Path(env_root)
    cwd = payload.get("cwd")
    if cwd:
        return Path(cwd)
    return Path.cwd()


def section_bodies(lines, heading):
    # Lines under each line that equals `heading`; a body ends at the next line starting with "## ".
    bodies = []
    body = None
    for line in lines:
        if line.startswith("## "):
            body = [] if line.rstrip() == heading else None
            if body is not None:
                bodies.append(body)
        elif body is not None:
            body.append(line)
    return bodies


def has_text(lines):
    return any(line.strip() for line in lines)


def check(root, now):
    path = root / ANALYSIS_RELATIVE
    if not path.is_file():
        return False, f"{path}: missing. {REQUIREMENT}"
    problems = []
    signed_age = now - path.stat().st_mtime
    if abs(signed_age) > FRESH_SECONDS:
        age_minutes = int(abs(signed_age) // SECONDS_PER_MINUTE)
        when = "ago" if signed_age >= 0 else "in the future"
        problems.append(f"stale, last written {age_minutes} min {when} (limit {FRESH_SECONDS // SECONDS_PER_MINUTE} min)")
    lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    for heading in SECTIONS:
        bodies = section_bodies(lines, heading)
        if not bodies:
            problems.append(f"section `{heading}` missing")
        elif not all(has_text(body) for body in bodies):
            problems.append(f"section `{heading}` empty")
    if problems:
        return False, f"{path}: {'; '.join(problems)}. {REQUIREMENT}"
    return True, f"{path}: ok"

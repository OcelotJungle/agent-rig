"""Per-category denylist of project directories; loaded by path by the agent run launchers.

Config: ~/.agent-rig/project-denylist.json, `{"codex": ["C:/projects/bloxels"], "volunteers": ["C:/projects/bloxels"]}`.
  - no file, or a category key missing: nothing is denied for that category
  - a category list present: a session whose project directory is a listed directory or lies inside one is refused
  - malformed file (bad JSON, top level not an object, a category value not a list of non-empty strings): every
    category is refused, the reason names the file
Match: resolved real paths (symlinks and junctions resolved where they exist), compared component by component
(`C:/projects/bloxels-backup` is not inside `C:/projects/bloxels`), case-insensitive where the OS is, `/` and `\\`
equivalent.
Project directory of a run: the launcher's own working directory. For the SessionStart hook: the `cwd` field of the
hook's JSON input on stdin when present, else the working directory.
Query from outside (the telegram hub's /info):
  python -I project-denylist.py check <codex|volunteers> --project-dir <dir>
prints {"allowed": bool, "reason": str} as one JSON line, exit 0 in both cases.
  python -I project-denylist.py batch --project-dir <dir> --category <name>...
prints {"categories": {"<name>": {"allowed": bool, "reason": str} | {"error": str}}} as one JSON line.
"""
import argparse
import json
import os
import sys
from pathlib import Path

CATEGORIES = ("codex", "volunteers")
CONFIG_DISPLAY = "~/.agent-rig/project-denylist.json"


def config_path(home):
    return Path(home) / ".agent-rig" / "project-denylist.json"


def _is_dir_list(value):
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def load_config(home):
    """(config dict, error text or None). A missing file is an empty config."""
    path = config_path(home)
    if not path.is_file():
        return {}, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {}, f"{CONFIG_DISPLAY} is malformed ({e.__class__.__name__}); fix or delete it"
    if not isinstance(data, dict):
        return {}, f"{CONFIG_DISPLAY} is malformed (the top level must be an object); fix or delete it"
    for category in CATEGORIES:
        if category in data and not _is_dir_list(data[category]):
            return {}, f'{CONFIG_DISPLAY} is malformed ("{category}" must be a list of project directories); fix or delete it'
    return data, None


def _real(path):
    return os.path.normcase(os.path.realpath(path))


def _is_inside(project, directory):
    """Both arguments are resolved paths; true when `project` is `directory` or lies under it."""
    try:
        return os.path.commonpath([project, directory]) == directory
    except ValueError:  # different drives
        return False


def check(category, project_dir, home=None):
    """(allowed, reason). The reason is empty when allowed."""
    home = Path.home() if home is None else Path(home)
    config, error = load_config(home)
    if error:
        return False, f"REFUSED: {category} is blocked: {error}"
    project = _real(project_dir)
    for listed in config.get(category, []):
        if _is_inside(project, _real(listed)):
            return False, f"REFUSED: {category} is not allowed in project {listed} (set in {CONFIG_DISPLAY})"
    return True, ""


def refuse_if_blocked(category, project_dir=None, home=None):
    """Exit with the refusal text when the category is denied in the project directory (default: the working directory)."""
    allowed, reason = check(category, os.getcwd() if project_dir is None else project_dir, home)
    if not allowed:
        raise SystemExit(reason)


def hook_project_dir(stream=None):
    """The `cwd` of a SessionStart hook's JSON input on `stream` (default stdin), else the working directory."""
    stream = sys.stdin if stream is None else stream
    try:
        data = {} if stream.isatty() else json.loads(stream.read())
    except (OSError, ValueError):
        data = {}
    cwd = data.get("cwd") if isinstance(data, dict) else None
    return cwd if isinstance(cwd, str) and cwd else os.getcwd()


def session_hint(category, hint, project_dir=None, home=None, out=None):
    """Print the SessionStart hook output carrying `hint` when the category is denied in the project directory."""
    allowed, reason = check(category, os.getcwd() if project_dir is None else project_dir, home)
    if allowed:
        return
    text = json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                              "additionalContext": f"{hint} ({reason})"}}, ensure_ascii=True)
    print(text, file=out)


def _project_dir_arg(text):
    if not text.strip():
        raise argparse.ArgumentTypeError("must not be empty")
    return text


def build_parser():
    parser = argparse.ArgumentParser(description="Query the project denylist.")
    commands = parser.add_subparsers(dest="command", required=True)
    query = commands.add_parser("check", help="print whether a category is allowed in a project directory")
    query.add_argument("category", choices=CATEGORIES)
    query.add_argument("--project-dir", type=_project_dir_arg, required=True, help="the project directory of the session")
    batch = commands.add_parser("batch", help="query several categories for one project directory in one process")
    batch.add_argument("--project-dir", type=_project_dir_arg, required=True, help="the project directory of the session")
    batch.add_argument("--category", action="append", choices=CATEGORIES, default=[])
    return parser


def main(argv=None):
    """`check <category> --project-dir <dir>`: one line of JSON {"allowed", "reason"}, exit 0 in both cases.
    `batch --project-dir <dir> --category <name>...`: one line of JSON {"categories"} mapping each category to
    {"allowed", "reason"}; a category whose check raised is {"error": text} instead, the others are unaffected.
    """
    args = build_parser().parse_args(argv)
    if args.command == "batch":
        categories = {}
        for category in args.category:
            try:
                allowed, reason = check(category, args.project_dir)
                categories[category] = {"allowed": allowed, "reason": reason}
            except Exception as e:  # one failing category must not fail the others
                categories[category] = {"error": f"{e.__class__.__name__}: {e}"}
        print(json.dumps({"categories": categories}, ensure_ascii=True))
        return 0
    allowed, reason = check(args.category, args.project_dir)
    print(json.dumps({"allowed": allowed, "reason": reason}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

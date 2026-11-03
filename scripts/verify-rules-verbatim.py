#!/usr/bin/env python3
# Compare rule chunks with any person's live instruction files.
"""Verify rule sections against the live instruction files."""

import argparse
import json
import os
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
WINDOWS_PLATFORM = "windows"
FEATURE_NAMES = ("codex", "volunteers", "telegram")
HEADING_PATTERN = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
DISABLED_FEATURE_PATTERNS = {
    "codex": re.compile(r"\bcodex\b", re.IGNORECASE),
    "volunteers": re.compile(r"\bvolunteers?\b", re.IGNORECASE),
    "telegram": re.compile(r"\btelegram\b", re.IGNORECASE),
    "skills": re.compile(r"\bmeasurement-runs\b", re.IGNORECASE),
}

# Section ownership copied from the "Base and features" tables in the design spec.
SPEC_SECTIONS = (
    ("Addressing the user", "shared"),
    ("Temporary files", "shared"),
    ("Tests and runs", "shared"),
    ("Specs are living documents", "shared"),
    ("JS/TS code conventions", "shared"),
    ("Compact instructions", "claude"),
    ("Global rules vs project memory", "claude"),
    ("Ask-driven development", "claude"),
    ("Every message gets an answer", "claude"),
    ("Writing to the user", "claude"),
    ("Fixing a sent answer", "claude"),
    ("BLOCKERS GO FIRST, LOUD, IN THEIR OWN MESSAGE", "claude"),
    ("Review and engineering method", "claude"),
    ("Subagent models", "claude"),
    ("Delegation: keep the main context small", "claude"),
    ("Commits", "claude"),
    ("No heredocs", "claude"),
    ("Windows commands go through Bash", "claude"),
    ("Background tasks and monitors", "claude"),
    ("Delegating to Codex", "claude"),
    ("Delegating to volunteers", "claude"),
    ("Attention chime", "claude"),
)

# Each entry names a live line or path intentionally kept out of the base rules,
# records the spec's reason, and identifies whether it is removed or normalized.
PERMITTED_REMOVED_LINES = (
    {
        "name": "telegram-mode-line",
        "live_text": "- Telegram mode: send a finished artifact with tg_send_file; write the final message once.",
        "reason": "the spec moves this line to the telegram feature",
        "remove_from": "Writing to the user",
        "destination_feature": "telegram",
        "destination_marker": "- Telegram mode: send a finished artifact with tg_send_file; write the final message once.",
        "path_replacement": None,
    },
    {
        "name": "measurement-runs-line",
        "live_text": "- Measurements, benchmarks, paid or long runs, comparisons: the `measurement-runs` skill.",
        "reason": "the spec moves measurement-runs to the skills feature",
        "remove_from": "Review and engineering method",
        "destination_feature": "skills",
        "destination_marker": "`measurement-runs` skill",
        "path_replacement": None,
    },
    {
        "name": "global-rules-personal-path",
        "live_text": "- a rule for any agent's work (code, tests, specs, tools, this machine) goes into `~/.codex/AGENTS.md`;",
        "reason": "the spec removes personal paths from shared rules",
        "remove_from": "Global rules vs project memory",
        "destination_feature": None,
        "destination_marker": None,
        "path_replacement": None,
        "normalized_live_text": "- a rule for any agent's work (code, tests, specs, tools, this machine) goes into `{{HOME}}/.codex/AGENTS.md`;",
        "comparison_text": "- a rule for any agent's work (code, tests, specs, tools, this machine) goes into shared rules;",
    },
    {
        "name": "codex-run-personal-path",
        "live_text": "~/.claude/tools/codex-run.py",
        "reason": "the spec replaces personal paths with clone placeholders",
        "remove_from": None,
        "destination_feature": "codex",
        "destination_marker": "{{CLONE}}/features/codex/tools/codex-run.py",
        "path_replacement": "{{CLONE}}/features/codex/tools/codex-run.py",
        "comparison_text": None,
    },
    {
        "name": "volunteer-run-personal-path",
        "live_text": "~/.claude/tools/volunteer-run.py",
        "reason": "the spec replaces personal paths with clone placeholders",
        "remove_from": None,
        "destination_feature": "volunteers",
        "destination_marker": "{{CLONE}}/features/volunteers/tools/volunteer-run.py",
        "path_replacement": "{{CLONE}}/features/volunteers/tools/volunteer-run.py",
        "comparison_text": None,
    },
    {
        "name": "volunteer-design-personal-path",
        "live_text": "~/.claude/tools/volunteer-design.md",
        "reason": "the spec replaces personal paths with clone placeholders",
        "remove_from": None,
        "destination_feature": "volunteers",
        "destination_marker": "{{CLONE}}/features/volunteers/tools/volunteer-design.md",
        "path_replacement": "{{CLONE}}/features/volunteers/tools/volunteer-design.md",
        "comparison_text": None,
    },
)


def normalize_line_endings(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def read_live_text(path, replacements):
    text = normalize_line_endings(path.read_text(encoding="utf-8-sig"))
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    return text.rstrip("\n")


def parse_heading(line):
    match = HEADING_PATTERN.fullmatch(line)
    if match is None:
        return None
    title = re.sub(r"[ \t]+#+[ \t]*$", "", match.group(2)).strip()
    return len(match.group(1)), title


def read_manifests(root):
    manifest_paths = [root / "base" / "feature.json"]
    manifest_paths.extend(sorted((root / "features").glob("*/feature.json")))
    manifests = []
    for path in manifest_paths:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data.get("name"), str) or not isinstance(data.get("rules"), list):
            raise ValueError(f"Invalid feature manifest: {path}")
        manifests.append((path, data))
    return manifests


def rule_is_selected(rule, enabled, platform):
    if rule.get("platform") not in (None, platform):
        return False
    if not all(name in enabled for name in rule.get("whenEnabled", [])):
        return False
    return all(name not in enabled for name in rule.get("whenDisabled", []))


def load_rule_chunks(root, manifests, enabled, platform):
    selected = []
    grouped = {"shared": {}, "claude": {}}
    current_headings = {}
    feature_text = {}
    for manifest_path, manifest in manifests:
        feature_name = manifest["name"]
        if feature_name != "base" and feature_name not in enabled:
            continue
        if platform not in manifest.get("platforms", []):
            continue
        feature_text[feature_name] = []
        part_root = root / "base" if feature_name == "base" else root / "features" / feature_name
        for rule in manifest["rules"]:
            if not rule_is_selected(rule, enabled, platform):
                continue
            target = rule.get("target")
            if target not in grouped:
                raise ValueError(f"Invalid rule target in {manifest_path}: {target}")
            chunk_path = part_root / rule["path"]
            chunk_text = normalize_line_endings(chunk_path.read_text(encoding="utf-8-sig"))
            first_content_line = next((line for line in chunk_text.split("\n") if line.strip()), "")
            heading = parse_heading(first_content_line)
            if heading is not None:
                current_headings[target] = heading[1]
            section_heading = current_headings.get(target)
            if section_heading is None:
                raise ValueError(f"Rule chunk has no section heading before it: {chunk_path}")
            entry = {
                "feature": feature_name,
                "target": target,
                "heading": section_heading,
                "path": chunk_path,
                "text": chunk_text,
            }
            selected.append(entry)
            grouped[target].setdefault(section_heading, []).append(entry)
            feature_text[feature_name].append(chunk_text)
    return selected, grouped, feature_text


def build_target_text(chunks, target):
    return "".join(entry["text"] for entry in chunks if entry["target"] == target)


def find_section(text, title, boundary_titles=None):
    lines = normalize_line_endings(text).rstrip("\n").split("\n")
    headings = []
    for index, line in enumerate(lines):
        heading = parse_heading(line)
        if heading is not None:
            headings.append((index, heading[0], heading[1]))
    matches = [item for item in headings if item[2] == title]
    if len(matches) != 1:
        return None, len(matches)
    start, level, _ = matches[0]
    boundaries = set(boundary_titles or ())
    end = next(
        (
            index
            for index, next_level, next_title in headings
            if index > start and (next_title in boundaries or next_level <= level)
        ),
        len(lines),
    )
    return "\n".join(lines[start:end]).rstrip("\n"), 1


def path_variants(path_text):
    return {path_text, path_text.replace("/", "\\"), path_text.replace("\\", "/")}


def normalize_live_paths(text, root, home):
    normalized = text
    for item in PERMITTED_REMOVED_LINES:
        replacement = item["path_replacement"]
        if replacement is None:
            continue
        for variant in path_variants(item["live_text"]):
            normalized = re.sub(re.escape(variant), lambda _: replacement, normalized, flags=re.IGNORECASE)

    path_replacements = {
        str(home): "{{HOME}}",
        home.as_posix(): "{{HOME}}",
        os.environ.get("HOME", ""): "{{HOME}}",
        os.environ.get("USERPROFILE", ""): "{{HOME}}",
        str(root.resolve()): "{{CLONE}}",
        root.resolve().as_posix(): "{{CLONE}}",
        sys.executable: "{{PYTHON}}",
        Path(sys.executable).as_posix(): "{{PYTHON}}",
    }
    for value, replacement in sorted(path_replacements.items(), key=lambda item: len(item[0]), reverse=True):
        if not value:
            continue
        for variant in path_variants(value):
            normalized = re.sub(re.escape(variant), replacement, normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?<![\w{}])~(?=[/\\])", "{{HOME}}", normalized)
    normalized = re.sub(r"(?<![\w{}])python(?=\s+-I\b)", "{{PYTHON}}", normalized, flags=re.IGNORECASE)
    # A clone path can hold spaces, so chunks quote it in commands; the live rules use a space-free `~` path.
    normalized = re.sub(r"(\{\{PYTHON\}\} -I )(\{\{CLONE\}\}/\S+)", r'\1"\2"', normalized)
    return normalized


def apply_permitted_line_changes(section_text, title):
    lines = section_text.split("\n")
    remaining = []
    for line in lines:
        matching = next(
            (
                item
                for item in PERMITTED_REMOVED_LINES
                if item["remove_from"] == title and item.get("normalized_live_text", item["live_text"]) == line
            ),
            None,
        )
        if matching is None:
            remaining.append(line)
        elif matching.get("comparison_text"):
            remaining.append(matching["comparison_text"])
    return "\n".join(remaining).rstrip("\n")


def describe_differences(expected, actual):
    expected_lines = expected.split("\n") if expected else []
    actual_lines = actual.split("\n") if actual else []
    import difflib

    matcher = difflib.SequenceMatcher(a=expected_lines, b=actual_lines, autojunk=False)
    differences = []
    for tag, expected_start, expected_end, actual_start, actual_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        for index in range(actual_start, actual_end):
            differences.append(f"  live line {index + 1}: {actual_lines[index]}")
        for index in range(expected_start, expected_end):
            differences.append(f"  chunk line {index + 1}: {expected_lines[index]}")
    return differences


def validate_permitted_lines(live_text, chunks, feature_text, personal_rules):
    errors = []
    chunk_text = "\n".join(entry["text"] for entry in chunks)
    for item in PERMITTED_REMOVED_LINES:
        if item["live_text"] not in live_text:
            errors.append(f"permitted line disappeared: {item['name']} ({item['reason']})")
            continue
        if item["remove_from"] is not None:
            boundary_titles = {title for title, _ in SPEC_SECTIONS}
            section_text, count = find_section(live_text, item["remove_from"], boundary_titles)
            if count != 1 or item["live_text"] not in section_text.split("\n"):
                errors.append(f"permitted line is not in its live section: {item['name']}")
        if item["destination_feature"] is not None:
            destination = "\n".join(feature_text.get(item["destination_feature"], []))
            if item["destination_marker"] not in destination:
                errors.append(f"permitted line is missing from its feature chunk: {item['name']}")
    for line in personal_rules["removedLines"]:
        if line not in live_text:
            errors.append(f"personal removed line is missing from live text: {line}")
        if line in chunk_text:
            errors.append(f"personal removed line is present in a rule chunk: {line}")
    for marker in personal_rules["markers"]:
        if marker in chunk_text:
            errors.append(f"personal-only text is present in a rule chunk: {marker}")
    return errors


def verify_sections(live_by_target, target_text, grouped, root, home):
    errors = []
    passes = 0
    for title, target in SPEC_SECTIONS:
        if not grouped[target].get(title):
            errors.append(f"FAIL section has no chunks: {title}")
            continue
        boundary_titles = {section for section, section_target in SPEC_SECTIONS if section_target == target}
        expected, expected_count = find_section(target_text[target], title, boundary_titles)
        if expected_count != 1:
            errors.append(f"FAIL rebuilt section heading count {expected_count}: {title}")
            continue
        live_normalized = normalize_live_paths(live_by_target[target], root, home)
        actual, actual_count = find_section(live_normalized, title, boundary_titles)
        if actual_count != 1:
            errors.append(f"FAIL live section heading count {actual_count}: {title}")
            continue
        actual = apply_permitted_line_changes(actual, title)
        differences = describe_differences(expected, actual)
        if differences:
            errors.append(f"FAIL verbatim section: {title}")
            errors.extend(differences)
        else:
            print(f"PASS verbatim section: {title}")
            passes += 1
    return errors, passes


def verify_combinations(root, manifests):
    errors = []
    passes = 0
    all_features = {manifest["name"] for _, manifest in manifests if manifest["name"] != "base"}
    for codex_enabled in (False, True):
        for volunteers_enabled in (False, True):
            for telegram_enabled in (False, True):
                enabled = set(all_features)
                enabled.discard("skills")
                if not codex_enabled:
                    enabled.discard("codex")
                if not volunteers_enabled:
                    enabled.discard("volunteers")
                if not telegram_enabled:
                    enabled.discard("telegram")
                chunks, _, _ = load_rule_chunks(root, manifests, enabled, WINDOWS_PLATFORM)
                combination = (
                    f"codex={'on' if codex_enabled else 'off'}, "
                    f"volunteers={'on' if volunteers_enabled else 'off'}, "
                    f"telegram={'on' if telegram_enabled else 'off'}, skills=off"
                )
                output = build_target_text(chunks, "claude")
                disabled = [name for name in (*FEATURE_NAMES, "skills") if name not in enabled]
                found = []
                for name in disabled:
                    for line_number, line in enumerate(output.split("\n"), start=1):
                        if DISABLED_FEATURE_PATTERNS[name].search(line):
                            found.append(f"  {name} mentioned on output line {line_number}: {line}")
                if found:
                    errors.append(f"FAIL feature combination: {combination}")
                    errors.extend(found)
                else:
                    print(f"PASS feature combination: {combination}")
                    passes += 1
    return errors, passes


def verify_personal_headings(chunks, section_headings):
    errors = []
    for entry in chunks:
        for line in entry["text"].split("\n"):
            heading = parse_heading(line)
            if heading is not None and heading[1] in section_headings:
                errors.append(f"FAIL personal section in chunk {entry['path']}: {heading[1]}")
    return errors


def load_personal_rules(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {"sectionHeadings": [], "markers": [], "removedLines": [], "liveTextReplacements": []}
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid personal file {path}: {error}") from error

    keys = ("sectionHeadings", "markers", "removedLines")
    if not isinstance(data, dict) or any(
        not isinstance(data.get(key), list)
        or any(not isinstance(value, str) for value in data[key])
        for key in keys
    ):
        raise ValueError(f"invalid personal file {path}: expected string lists for {', '.join(keys)}")
    replacements = data.get("liveTextReplacements", [])
    if not isinstance(replacements, list) or any(
        not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(value, str) for value in pair)
        for pair in replacements
    ):
        raise ValueError(f"invalid personal file {path}: liveTextReplacements must be [pattern, replacement] pairs")
    for pattern, _ in replacements:
        try:
            re.compile(pattern)
        except re.error as error:
            raise ValueError(f"invalid personal file {path}: bad pattern {pattern}: {error}") from error
    return {**{key: data[key] for key in keys}, "liveTextReplacements": replacements}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root used for manifests and rule chunks")
    parser.add_argument("--claude-path", type=Path, default=Path.home() / ".claude" / "CLAUDE.md")
    parser.add_argument("--codex-path", type=Path, default=Path.home() / ".codex" / "AGENTS.md")
    parser.add_argument(
        "--personal-file",
        type=Path,
        default=Path.home() / ".agent-rig" / "rules-personal.json",
        help="JSON file containing this person's excluded headings, markers, and removed lines",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        personal_rules = load_personal_rules(args.personal_file)
        manifests = read_manifests(args.root)
        all_features = {manifest["name"] for _, manifest in manifests if manifest["name"] != "base"}
        enabled = set(all_features)
        chunks, grouped, feature_text = load_rule_chunks(args.root, manifests, enabled, WINDOWS_PLATFORM)
        live_by_target = {
            "claude": read_live_text(args.claude_path, personal_rules["liveTextReplacements"]),
            "shared": read_live_text(args.codex_path, personal_rules["liveTextReplacements"]),
        }
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        if str(error).startswith("invalid personal file "):
            print(f"FAIL {error}", file=sys.stderr)
            return 1
        print(f"FAIL could not load rules or live files: {error}", file=sys.stderr)
        return 1

    all_live_text = "\n".join(live_by_target.values())
    errors = validate_permitted_lines(all_live_text, chunks, feature_text, personal_rules)
    errors.extend(verify_personal_headings(chunks, personal_rules["sectionHeadings"]))
    target_text = {target: build_target_text(chunks, target) for target in ("shared", "claude")}
    section_errors, section_passes = verify_sections(live_by_target, target_text, grouped, args.root, Path.home())
    errors.extend(section_errors)
    combination_errors, combination_passes = verify_combinations(args.root, manifests)
    errors.extend(combination_errors)

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"PASS total: {section_passes + combination_passes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Seed and check user-owned settings data in Docker scenarios."""
import json
import sys
from pathlib import Path


def get_path(value, path):
    current = value
    for part in path:
        current = current[part]
    return current


def put_path(value, path, replacement):
    parent = get_path(value, path[:-1])
    parent[path[-1]] = replacement


def read_object(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_object(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def changed_value(value):
    if isinstance(value, bool):
        return not value
    if isinstance(value, (int, float)):
        return value + 1
    if isinstance(value, str):
        return value + " user edit"
    if isinstance(value, list):
        return value + ["user edit"]
    if isinstance(value, dict):
        return {**value, "dockerScenario": "user edit"}
    return "user edit"


mode, settings_path, state_path, expected_path = sys.argv[1:]
settings = read_object(settings_path)
if mode == "seed":
    state = read_object(state_path)
    settings["dockerScenarioForeign"] = {"value": "keep this"}
    ownership = [json.loads(value) for key, value in state["records"].items() if key.startswith("setting:")]
    selected = next((record for record in ownership if record.get("kind") == "list-entry"), None)
    if selected is not None:
        path = selected["path"]
        values = get_path(settings, path)
        index = values.index(selected["value"])
        replacement = selected["value"] + " user edit"
        values[index] = replacement
        expected = {"kind": "list-entry", "path": path, "value": replacement}
    else:
        selected = next((record for record in ownership if record.get("kind") == "value"), None)
        if selected is None:
            raise SystemExit("No owned list-entry or value setting is available for the preservation check")
        path = selected["path"]
        replacement = changed_value(get_path(settings, path))
        put_path(settings, path, replacement)
        expected = {"kind": "value", "path": path, "value": replacement}
    write_object(settings_path, settings)
    write_object(expected_path, expected)
elif mode == "verify":
    expected = read_object(expected_path)
    if settings.get("dockerScenarioForeign") != {"value": "keep this"}:
        raise SystemExit("Foreign settings key was lost")
    current = get_path(settings, expected["path"])
    if expected["kind"] == "list-entry":
        if expected["value"] not in current:
            raise SystemExit("Changed owned list entry was not preserved")
    elif current != expected["value"]:
        raise SystemExit("Changed owned setting value was not preserved")
else:
    raise SystemExit(f"Unknown settings fixture mode: {mode}")

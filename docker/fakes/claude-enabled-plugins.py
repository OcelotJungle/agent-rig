#!/usr/bin/env python3
"""Used by the fake `claude`: mirrors what the real CLI does to ~/.claude/settings.json.

`install <id>` sets enabledPlugins[<id>] = true; `uninstall <id>` removes the key. A settings file that is not a JSON
object is left alone, like the real CLI refuses to touch it.

`marketplace-name <root>` prints the marketplace name declared by <root>/.claude-plugin/marketplace.json and exits 1
when that manifest is missing, not JSON, or has no name. `lists-plugin <root> <plugin>` exits 0 only when that
manifest lists <plugin> among its plugins.
"""
import json
import os
import sys

JSON_INDENT = 2
MANIFEST_DIRECTORY = ".claude-plugin"
MANIFEST_FILENAME = "marketplace.json"
FAILURE_EXIT_CODE = 1


def read_manifest(root: str):
    path = os.path.join(root, MANIFEST_DIRECTORY, MANIFEST_FILENAME)
    try:
        with open(path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return manifest if isinstance(manifest, dict) else None


def marketplace_name(root: str) -> int:
    manifest = read_manifest(root)
    name = manifest.get("name") if manifest is not None else None
    if not isinstance(name, str) or not name:
        return FAILURE_EXIT_CODE
    print(name)
    return 0


def lists_plugin(root: str, plugin: str) -> int:
    manifest = read_manifest(root)
    plugins = manifest.get("plugins", []) if manifest is not None else []
    listed = isinstance(plugins, list) and any(isinstance(entry, dict) and entry.get("name") == plugin for entry in plugins)
    return 0 if listed else FAILURE_EXIT_CODE


def main() -> int:
    if sys.argv[1] == "marketplace-name":
        return marketplace_name(sys.argv[2])
    if sys.argv[1] == "lists-plugin":
        return lists_plugin(sys.argv[2], sys.argv[3])
    action, plugin = sys.argv[1], sys.argv[2]
    path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
    settings = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            try:
                settings = json.load(handle)
            except json.JSONDecodeError:
                return 0
        if not isinstance(settings, dict):
            return 0
    enabled = settings.get("enabledPlugins")
    if not isinstance(enabled, dict):
        enabled = {}
    if action == "install":
        enabled[plugin] = True
    else:
        enabled.pop(plugin, None)
    settings["enabledPlugins"] = enabled
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(settings, handle, indent=JSON_INDENT, ensure_ascii=False)
        handle.write("\n")
    return 0


sys.exit(main())

"""Deny explicit tool write targets in system temp. Variable targets such as $TEMP/x and %TEMP% pass.

This is a literal command guard, not a shell interpreter: computed paths and scripts are not inspected.
"""
import ctypes
import json
import ntpath
import os
import posixpath
import re
import sys

TOKEN = re.compile(r'''(?:[^\s;&|<>"']|"[^"]*"|'[^']*')+|(?:\d*>>?|&>>?)|[;|&]''')
VARIABLE = re.compile(r"\$(?:env:)?[A-Za-z_][\w:]*|%[^%]+%", re.I)
LOCAL_APPDATA = re.compile(r"%LOCALAPPDATA%|\$env:LOCALAPPDATA\b|\$LOCALAPPDATA\b", re.I)
GIT_DRIVE = re.compile(r"^/([a-zA-Z])(?:/|$)")


def unquote(value):
    return value.replace('"', '').replace("'", "")


def long_path(path):
    if os.name != "nt":
        return path
    # Resolve the existing ancestor too, since the target itself may not exist yet.
    tail = []
    current = path
    while current and not os.path.exists(current):
        parent, name = ntpath.split(current)
        if parent == current or not name:
            break
        tail.append(name)
        current = parent
    size = ctypes.windll.kernel32.GetLongPathNameW(current, None, 0)
    if size:
        buffer = ctypes.create_unicode_buffer(size)
        if ctypes.windll.kernel32.GetLongPathNameW(current, buffer, size):
            current = buffer.value
    return ntpath.join(current, *reversed(tail))


def tmp_on_windows(path, env):
    # Git Bash mounts /tmp on the bash process TEMP directory (/etc/fstab usertemp), not on C:\tmp.
    if path != "/tmp" and not path.startswith("/tmp/"):
        return path
    temp = env.get("TEMP") or env.get("TMP") or (ntpath.join(env["LOCALAPPDATA"], "Temp") if env.get("LOCALAPPDATA") else "")
    if not temp:
        return path
    return temp.rstrip("/\\") + path[len("/tmp"):]


def normalize(path, base, home, env, windows):
    path = unquote(path)
    path = LOCAL_APPDATA.sub(lambda _: env.get("LOCALAPPDATA", ""), path)
    if VARIABLE.search(path):
        return None
    pathmod = ntpath if windows else posixpath
    if path == "~" or path.startswith(("~/", "~\\")):
        path = pathmod.join(home, path[2:]) if len(path) > 1 else home
    if windows:
        path = tmp_on_windows(path, env)
        path = GIT_DRIVE.sub(lambda m: m.group(1) + ":/", path.replace("\\", "/"))
    if not pathmod.isabs(path):
        path = pathmod.join(base, path)
    path = pathmod.normpath(path)
    if windows:
        path = ntpath.normcase(long_path(path))
    return path


def inside(path, root, windows):
    pathmod = ntpath if windows else posixpath
    try:
        return pathmod.commonpath([path, root]) == root
    except ValueError:
        return False


def targets(command):
    tokens = [unquote(item) for item in TOKEN.findall(command)]
    # Redirections can occur anywhere, including on commands that otherwise only read.
    for index, token in enumerate(tokens[:-1]):
        if re.fullmatch(r"(?:\d*|&)(?:>|>>)", token):
            yield tokens[index + 1]
    segments = []
    segment = []
    for token in tokens + [";"]:
        if token in (";", "|", "&"):
            if segment:
                segments.append(segment)
            segment = []
        else:
            segment.append(token)
    for segment in segments:
        name = ntpath.basename(segment[0].replace("/", "\\")).lower()
        name = name.removesuffix(".exe")
        args = segment[1:]
        # Remove redirections and their destinations before identifying positional operands.
        clean = []
        index = 0
        while index < len(args):
            if re.fullmatch(r"(?:\d*|&)(?:>|>>)", args[index]):
                index += 2
            else:
                clean.append(args[index])
                index += 1
        if name in ("mkdir", "touch", "tee"):
            yield from (arg for arg in clean if not arg.startswith("-"))
        elif name in ("cp", "mv", "install", "ln"):
            operands = [arg for arg in clean if not arg.startswith("-")]
            if len(operands) >= 2:
                yield operands[-1]
        elif name in ("curl", "wget"):
            for index, arg in enumerate(clean):
                options = ("-o", "--output") if name == "curl" else ("-O", "--output-document")
                if arg in options and index + 1 < len(clean):
                    yield clean[index + 1]
                elif any(arg.startswith(option + "=") for option in options if option.startswith("--")):
                    yield arg.split("=", 1)[1]
                elif arg.startswith(options[0]) and len(arg) > 2:
                    yield arg[2:]
        elif name in ("set-content", "out-file", "new-item"):
            for index, arg in enumerate(clean):
                if arg.lower() in ("-path", "-literalpath", "-filepath") and index + 1 < len(clean):
                    yield clean[index + 1]
            if clean and not clean[0].startswith("-"):
                yield clean[0]


def decision(data, env=None, windows=None):
    env = os.environ if env is None else env
    windows = os.name == "nt" if windows is None else windows
    pathmod = ntpath if windows else posixpath
    home = env.get("USERPROFILE") if windows else env.get("HOME")
    home = home or os.path.expanduser("~")
    cwd = data.get("cwd") or home
    project = env.get("CLAUDE_PROJECT_DIR") or cwd
    project = normalize(project, cwd, home, env, windows)
    home = normalize(home, cwd, home, env, windows)
    if not project or project == home:
        return None
    roots = []
    if windows:
        if env.get("LOCALAPPDATA"):
            roots.append(pathmod.join(env["LOCALAPPDATA"], "Temp"))
        roots.extend(env.get(key, "") for key in ("TEMP", "TMP"))
    else:
        roots.extend(("/tmp", "/var/tmp"))
        if sys.platform == "darwin" and env.get("TMPDIR"):
            roots.append(env["TMPDIR"])
    normalized_roots = []
    for root in roots:
        if root:
            root = normalize(root, cwd, home, env, windows)
            if root and not inside(root, project, windows):
                normalized_roots.append(root)
    tool = data.get("tool_name")
    tool_input = data.get("tool_input") or {}
    if tool in ("Write", "Edit", "NotebookEdit"):
        candidates = [tool_input.get("notebook_path") or tool_input.get("file_path") or ""]
    elif tool == "Bash":
        candidates = targets(tool_input.get("command") or "")
    else:
        candidates = []
    for candidate in candidates:
        if not candidate:
            continue
        path = normalize(candidate, cwd, home, env, windows)
        project_temp = pathmod.join(project, ".tmp")
        if path and not inside(path, project_temp, windows) and any(inside(path, root, windows) for root in normalized_roots):
            return f"Write to {candidate} denied. Use {pathmod.join(project, '.tmp')}; take the temp path from $TEMP or the language temp API."
    return None


if __name__ == "__main__":
    reason = decision(json.load(sys.stdin))
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))

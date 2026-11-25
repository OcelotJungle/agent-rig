"""Records one Claude Code session in ~/.agent-rig/sessions/<session_id>.json and its processes in
~/.agent-rig/sessions/<session_id>/processes/<pid>.json (one file per Claude process, so hooks never rewrite each other's facts).

Run by the SessionStart and SessionEnd hooks as `python -I session_record.py start|end`, with the hook's JSON on stdin.
`start` writes the session record (no process fields) and its own process file; the process is the CLAUDE_PID value when it
is a claude ancestor of the hook, otherwise the nearest claude ancestor. It also deletes process files whose process is
gone and turns a still-running legacy pid of the record into a process file. `end` deletes only its own process file.
The hook prints nothing and always exits 0.
Process table: PowerShell Get-CimInstance on Windows, /proc on Linux. Other systems get pid null and a pid_error.
Two more modes print JSON and exit 1 on failure: `created-at <pid>...` (creation time per pid) and `list` (every process with its command line).
"""
import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,128}")
POWERSHELL_TIMEOUT_SECONDS = 10
MAX_ANCESTOR_DEPTH = 64
FILETIME_EPOCH_100NS = 116444736000000000
FILETIME_TICKS_PER_US = 10
SECOND_US = 1000000
CLAUDE_NAMES = ("claude.exe", "claude")
EVENTS = ("start", "end")
SESSIONS_DIR_PARTS = (".agent-rig", "sessions")
PROCESSES_DIR_NAME = "processes"
PROC_STAT_STARTTIME_INDEX = 19
PROC_STAT_PPID_INDEX = 1
WINDOWS_TABLE_COLUMNS = "ProcessId,ParentProcessId,Name,"
# The command line is asked only by the `list` mode: the hooks and `created-at` do not need it, and it is the largest column.
WINDOWS_COMMAND_LINE_COLUMN = "CommandLine,"
WINDOWS_TABLE_TAIL = "@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}}} | ConvertTo-Json -Compress"
WINDOWS_TABLE_PREFIX = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object "
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


@dataclass
class Process:
    pid: int
    parent: int
    name: str
    created_us: int | None
    # Empty unless the table was loaded with command lines (the `list` mode); a process whose line cannot be read has an empty one too.
    command_line: str = ""


def session_id_valid(value):
    return isinstance(value, str) and SESSION_ID_PATTERN.fullmatch(value) is not None


def ancestors(table, start):
    chain = []
    seen = set()
    pid = start
    for _ in range(MAX_ANCESTOR_DEPTH):
        process = table.get(pid)
        if process is None or pid in seen:
            break
        seen.add(pid)
        chain.append(process)
        pid = process.parent
    return chain


def is_claude(process):
    return process.name.lower() in CLAUDE_NAMES


def claude_pid_hint(env):
    value = env.get("CLAUDE_PID", "")
    return int(value) if value.isdigit() else None


def resolve_claude(table, start, env):
    chain = ancestors(table, start)
    hint = claude_pid_hint(env)
    if hint is not None:
        for process in chain:
            if process.pid == hint and is_claude(process):
                return process, None
    for process in chain:
        if is_claude(process):
            return process, None
    return None, f"no claude ancestor of the hook process (walk from pid {start})"


def parse_windows_table(text):
    data = json.loads(text)
    rows = data if isinstance(data, list) else [data]
    table = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("process row is not an object")
        pid = row["ProcessId"]
        created = row["Created"]
        created_us = (created - FILETIME_EPOCH_100NS) // FILETIME_TICKS_PER_US if created else None
        command_line = row.get("CommandLine")
        table[pid] = Process(
            pid=pid,
            parent=row["ParentProcessId"],
            name=row["Name"],
            created_us=created_us,
            command_line=command_line if isinstance(command_line, str) else "",
        )
    return table


def windows_table_command(with_command_line):
    columns = WINDOWS_TABLE_COLUMNS + (WINDOWS_COMMAND_LINE_COLUMN if with_command_line else "")
    return WINDOWS_TABLE_PREFIX + columns + WINDOWS_TABLE_TAIL


def windows_process_table(run=subprocess.run, with_command_line=False):
    try:
        done = run(
            ["powershell", "-NoProfile", "-Command", windows_table_command(with_command_line)],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=POWERSHELL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return None, f"process table: {error}"
    if done.returncode != 0:
        return None, f"process table: powershell exit {done.returncode}"
    try:
        return parse_windows_table(done.stdout.decode("utf-8", errors="replace")), None
    except (ValueError, KeyError, TypeError) as error:
        return None, f"process table: {error}"


def parse_proc_stat(text):
    close = text.rindex(")")
    comm = text[text.index("(") + 1 : close]
    fields = text[close + 1 :].split()
    return comm, int(fields[PROC_STAT_PPID_INDEX]), int(fields[PROC_STAT_STARTTIME_INDEX])


def read_btime(stat_path):
    for line in stat_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("btime "):
            return int(line.split()[1])
    raise ValueError("no btime line in proc stat")


def linux_process_table(proc=Path("/proc"), clock_ticks=None, with_command_line=False):
    ticks = clock_ticks or os.sysconf("SC_CLK_TCK")
    try:
        btime = read_btime(proc / "stat")
        entries = [entry for entry in proc.iterdir() if entry.name.isdigit()]
    except (OSError, ValueError) as error:
        return None, f"process table: {error}"
    table = {}
    for entry in entries:
        try:
            comm, ppid, start_ticks = parse_proc_stat((entry / "stat").read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError, IndexError) as error:
            return None, f"process table: {error}"
        name = comm
        command_line = ""
        with contextlib.suppress(OSError):
            raw = (entry / "cmdline").read_bytes()
            argv = raw.split(b"\0")
            if argv[0]:
                name = PurePosixPath(argv[0].decode("utf-8", errors="replace")).name
            if with_command_line:
                command_line = " ".join(part.decode("utf-8", errors="replace") for part in argv if part)
        pid = int(entry.name)
        created_us = btime * SECOND_US + start_ticks * SECOND_US // ticks
        table[pid] = Process(pid=pid, parent=ppid, name=name, created_us=created_us, command_line=command_line)
    return table, None


def load_process_table(with_command_line=False):
    if sys.platform == "win32":
        return windows_process_table(with_command_line=with_command_line)
    return linux_process_table(with_command_line=with_command_line)


def iso_seconds(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_micro_from_us(microseconds):
    return (EPOCH + timedelta(microseconds=microseconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_hook_input(text):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def read_record(path):
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(temp, path)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(temp)


def string_or_null(data, key):
    value = data.get(key)
    return value if isinstance(value, str) else None


def identity_live(table, pid, pid_created):
    process = table.get(pid) if isinstance(pid, int) else None
    return process is not None and process.created_us is not None and isinstance(pid_created, str) and iso_micro_from_us(process.created_us) == pid_created


def delete_dead_process_files(processes_dir, table):
    if not processes_dir.is_dir():
        return
    for entry in processes_dir.glob("*.json"):
        entry_record = read_record(entry)
        if entry_record is None or not identity_live(table, entry_record.get("pid"), entry_record.get("pid_created")):
            with contextlib.suppress(OSError):
                entry.unlink()


def migrate_legacy_process(previous, processes_dir, table):
    # Before per-process files, the record itself held one pid; keep a still-running one as a process entry.
    if previous is None or previous.get("ended_at") is not None:
        return
    pid = previous.get("pid")
    pid_created = previous.get("pid_created")
    if not identity_live(table, pid, pid_created):
        return
    target = processes_dir / f"{pid}.json"
    if target.exists():
        return
    write_json_atomic(target, {
        "pid": pid,
        "pid_created": pid_created,
        "started_at": string_or_null(previous, "started_at"),
        "source": string_or_null(previous, "source"),
        "config_dir": previous.get("config_dir") if isinstance(previous.get("config_dir"), str) else "",
    })


def run_event(event, stdin_text, home, env, start_pid, load_table, now):
    if event not in EVENTS:
        return
    data = parse_hook_input(stdin_text)
    if data is None or not session_id_valid(data.get("session_id")):
        return
    sessions_dir = home.joinpath(*SESSIONS_DIR_PARTS)
    path = sessions_dir / f"{data['session_id']}.json"
    processes_dir = sessions_dir / data["session_id"] / PROCESSES_DIR_NAME
    if event == "end":
        # Only this process's own file goes: another process of the same session may still run.
        if not processes_dir.is_dir():
            return
        table, _ = load_table()
        if table is None:
            return
        process, _ = resolve_claude(table, start_pid, env)
        if process is not None:
            with contextlib.suppress(OSError):
                (processes_dir / f"{process.pid}.json").unlink()
        return

    previous = read_record(path)
    started_at = previous.get("started_at") if previous and isinstance(previous.get("started_at"), str) else iso_seconds(now)
    cwd = previous.get("cwd") if previous and isinstance(previous.get("cwd"), str) else string_or_null(data, "cwd")
    transcript_path = previous.get("transcript_path") if previous and isinstance(previous.get("transcript_path"), str) else string_or_null(data, "transcript_path")
    table, pid_error = load_table()
    process = None
    if table is not None:
        process, pid_error = resolve_claude(table, start_pid, env)
        migrate_legacy_process(previous, processes_dir, table)
        delete_dead_process_files(processes_dir, table)
    if process is not None:
        # Publish the process first so a newly published record has its live registration.
        write_json_atomic(processes_dir / f"{process.pid}.json", {
            "pid": process.pid,
            "pid_created": iso_micro_from_us(process.created_us) if process.created_us is not None else None,
            "started_at": iso_seconds(now),
            "source": string_or_null(data, "source"),
            "config_dir": env.get("CLAUDE_CONFIG_DIR", ""),
        })
    record = {
        "session_id": data["session_id"],
        "cwd": cwd,
        "transcript_path": transcript_path,
        "config_dir": env.get("CLAUDE_CONFIG_DIR", ""),
        "pid_error": pid_error,
        "started_at": started_at,
    }
    write_json_atomic(path, record)


def list_processes():
    # Every process as {pid, parent, name, commandLine, createdAt}; a process whose creation time is unknown has createdAt null.
    table, error = load_process_table(with_command_line=True)
    if table is None:
        raise ValueError(error or "process table unavailable")
    return [
        {
            "pid": process.pid,
            "parent": process.parent,
            "name": process.name,
            "commandLine": process.command_line,
            "createdAt": iso_micro_from_us(process.created_us) if process.created_us is not None else None,
        }
        for process in table.values()
    ]


def main(argv):
    event = argv[1] if len(argv) > 1 else ""
    if event == "list":
        try:
            print(json.dumps(list_processes()))
            return 0
        except Exception as error:
            sys.stderr.write(f"session_record: {error}\n")
            return 1
    if event == "created-at":
        try:
            pids = [int(value) for value in argv[2:]]
            if any(pid <= 0 for pid in pids):
                raise ValueError("invalid process id")
            table, error = load_process_table()
            if table is None:
                raise ValueError(error or "process table unavailable")
            result = {}
            for pid in pids:
                process = table.get(pid)
                if process is not None and process.created_us is None:
                    raise ValueError(f"creation time unavailable for pid {pid}")
                result[str(pid)] = iso_micro_from_us(process.created_us) if process is not None else None
            print(json.dumps(result))
            return 0
        except Exception as error:
            sys.stderr.write(f"session_record: {error}\n")
            return 1
    try:
        text = sys.stdin.buffer.read().decode("utf-8")
        run_event(event, text, Path.home(), dict(os.environ), os.getppid(), load_process_table, datetime.now(timezone.utc))
    except Exception as error:
        sys.stderr.write(f"session_record: {error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

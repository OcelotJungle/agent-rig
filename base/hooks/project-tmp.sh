#!/usr/bin/env bash
# SessionStart hook: redirect TEMP/TMP/TMPDIR of everything agents run into <project>/.tmp

failed=0
settings_failed=0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
is_windows=0
command -v cygpath >/dev/null 2>&1 && is_windows=1
[ "$is_windows" = 1 ] && root="$(cygpath -u "$root")"

# Session started outside a project (home directory): do nothing.
[ "$(cd "$root" 2>/dev/null && pwd -P)" = "$(cd "$HOME" && pwd -P)" ] && exit 0

tmp="$root/.tmp"
inherited_temp="${TEMP:-${TMPDIR:-${TMP:-/tmp}}}"
inherited_value="$inherited_temp"
if [ "$is_windows" = 1 ]; then
  inherited_value="$(cygpath -m "$inherited_temp" 2>/dev/null || printf '%s' "$inherited_temp")"
fi

warn_temp=""
emit_warning() {
  local reasons="$1"
  printf 'WARNING: %s Bash TEMP is "%s"; project temp is "%s". Write scratch only under the project temp via $TEMP or the language temp API.\n' \
    "$reasons" "$inherited_value" "$value"
}

if ! mkdir -p "$tmp"; then
  value="$tmp"
  [ "$is_windows" = 1 ] && value="$(cygpath -m "$tmp")"
  emit_warning "Creating project .tmp failed."
  exit 0
fi

# Path understood by Git Bash and native Windows programs alike: the clone's .tmp directory
value="$tmp"
[ "$is_windows" = 1 ] && value="$(cygpath -m "$tmp")"

# 1) Bash commands: via CLAUDE_ENV_FILE (immediate, from the first command).
bash_step_failed=0
if [ -z "$CLAUDE_ENV_FILE" ]; then
  bash_step_failed=1
elif ! grep -q '# project-tmp hook' "$CLAUDE_ENV_FILE" 2>/dev/null; then
  if ! {
    echo '# project-tmp hook'
    printf 'export TEMP=%q\n'   "$value"
    printf 'export TMP=%q\n'    "$value"
    printf 'export TMPDIR=%q\n' "$value"
  } >> "$CLAUDE_ENV_FILE"; then
    bash_step_failed=1
  fi
fi

# 2) Whole Claude Code process (PowerShell, MCP, Bash): env block in .claude/settings.local.json.
if [ "$is_windows" = 1 ]; then
  ps=powershell.exe
  command -v pwsh.exe >/dev/null 2>&1 && ps=pwsh.exe
  # The settings script sits next to this hook in the clone; the hook is not copied anywhere else.
  hook_dir="$(cd "$(dirname "$0")" && pwd)"
  "$ps" -NoProfile -ExecutionPolicy Bypass \
    -File "$(cygpath -w "$hook_dir/project-tmp-settings.ps1")" \
    -ProjectDir "$(cygpath -w "$root")" -TmpPath "$value" >/dev/null 2>&1 \
    || { echo "project-tmp: failed to update .claude/settings.local.json" >&2; failed=1; settings_failed=1; }
else
  settings="$root/.claude/settings.local.json"
  mkdir -p "$(dirname "$settings")"
  python3 -c 'exec("import json, os, pathlib, sys, tempfile\np=pathlib.Path(sys.argv[1])\nraw=p.read_text(encoding=\"utf-8\") if p.is_file() else \"\"\nd=json.loads(raw) if raw.strip() else {}\nif not isinstance(d, dict): raise ValueError(\"settings must be an object\")\ne=d.setdefault(\"env\", {})\nif not isinstance(e, dict): raise ValueError(\"env must be an object\")\nv=sys.argv[2]\nchanged=any(e.get(k) != v for k in (\"TEMP\", \"TMP\", \"TMPDIR\"))\nif changed:\n e.update({k:v for k in (\"TEMP\", \"TMP\", \"TMPDIR\")})\n with tempfile.NamedTemporaryFile(mode=\"w\", encoding=\"utf-8\", dir=p.parent, prefix=p.name+\".\", delete=False) as f:\n  json.dump(d, f, ensure_ascii=False, indent=2)\n  tmp=f.name\n try: os.replace(tmp, p)\n finally:\n  if os.path.exists(tmp): os.unlink(tmp)")' "$settings" "$value" >/dev/null 2>&1 \
    || { echo "project-tmp: failed to update .claude/settings.local.json" >&2; failed=1; settings_failed=1; }
fi

# Warn before the agent's first write if Bash did not receive the project temp.
temp_mismatch=0
if [ "$is_windows" = 1 ]; then
  [ "${inherited_value,,}" != "${value,,}" ] && temp_mismatch=1
else
  for candidate in "${TMPDIR:-}" "${TEMP:-}" "${TMP:-}"; do
    [ -z "$candidate" ] || [ "$candidate" = "$tmp" ] || temp_mismatch=1
  done
  if [ -z "${TMPDIR:-}${TEMP:-}${TMP:-}" ]; then
    temp_mismatch=1
  fi
fi
if [ "$bash_step_failed" = 1 ] && [ "$temp_mismatch" = 1 ]; then
  warn_temp="CLAUDE_ENV_FILE step failed or was unavailable."
fi
if [ "$settings_failed" = 1 ]; then
  warn_temp="${warn_temp:+$warn_temp }Updating .claude/settings.local.json step failed."
fi
[ -n "$warn_temp" ] && emit_warning "$warn_temp"

# 3) Keep .tmp/ and settings.local.json out of git without touching .gitignore.
if exclude="$(git -C "$root" rev-parse --git-path info/exclude 2>/dev/null)"; then
  case "$exclude" in /*) ;; *) exclude="$root/$exclude" ;; esac
  mkdir -p "$(dirname "$exclude")"
  for line in '.tmp/' '.claude/settings.local.json'; do
    grep -qxF "$line" "$exclude" 2>/dev/null || echo "$line" >> "$exclude"
  done
fi

# 4) Cleanup: remove top-level entries in .tmp untouched for more than 3 days.
find "$tmp" -mindepth 1 -maxdepth 1 ! -name claude -mtime +3 -exec rm -rf {} + 2>/dev/null

exit $failed

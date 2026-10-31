# No heredocs

Never use a heredoc (`<<EOF`, `<<'EOF'`, `<<-EOF`) or a PowerShell here-string (`@'…'@`, `@"…"@`), in any tool, for
any purpose, no exceptions. A shell command never carries multi-line text.
- A new file or full rewrite: Write. A change to an existing file: Edit. Never write files from the shell (`cat >`,
  `tee`, `echo`/`printf` with newlines).
- A script of any language: Write it to the scratchpad and run it by path. No multi-line `python -c`, `node -e`,
  `bun -e`, `bash -c`.
- Text for a command (commit message, PR body): Write it to a file and pass the path (`git commit -F`,
  `gh pr create --body-file`). A one-line `-m "..."` is fine.
- An edit whose pattern holds a backslash goes through Edit or a script file, never `sed`, `perl -pi -e` or `grep`.
- When Edit cannot match text plainly in the file (CRLF), or one change goes into several places, a Python driver
  calls `patch(path, [(old, new), ...])` from `{{HOME}}/.claude/tools/patchlib.py`.

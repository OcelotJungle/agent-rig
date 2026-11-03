## Temporary files

- TEMP, TMP and TMPDIR already point to `.tmp/` in the project root (hook `{{HOME}}/.claude/hooks/project-tmp.sh`; Codex
  inherits them). Take the temp path from `$TEMP` in the shell, not from a summary or an old brief.
- Temporary files only through the language's temp API (`os.tmpdir()`, `fs.mkdtemp`, `tempfile`, etc.); never hardcode
  the system temp (`/tmp`, `C:\Temp`, `%TEMP%`).
- Tests delete their temporary files (afterEach / teardown / finally), including on failure.
- Nothing valuable in `.tmp/`: anything older than 3 days is deleted. Notes and results go to a normal project folder.
- If a tool does not work with a temp inside the project, do not work around it silently; tell the user.

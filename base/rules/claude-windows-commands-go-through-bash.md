# Windows commands go through Bash

Git Bash is the only shell tool (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`). PowerShell is called from Bash: a one-liner as
`powershell -NoProfile -Command '…'` in single quotes; anything longer as a `.ps1` in `$TEMP` (the project's `.tmp/`) run with
`powershell -NoProfile -ExecutionPolicy Bypass -File <path>`. Never write files through PowerShell (Set-Content,
Out-File, `>`).

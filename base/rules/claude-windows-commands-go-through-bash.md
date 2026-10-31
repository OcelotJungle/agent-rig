# Windows commands go through Bash

Git Bash is the only shell tool (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`). PowerShell is called from Bash: a one-liner as
`powershell -NoProfile -Command '…'` in single quotes; anything longer as a `.ps1` in the scratchpad run with
`powershell -NoProfile -ExecutionPolicy Bypass -File <path>`. Never write files through PowerShell (Set-Content,
Out-File, `>`).

Global config (settings, hooks, user CLAUDE.md, global skills) goes into `{{HOME}}/.claude`, never `$CLAUDE_CONFIG_DIR`.

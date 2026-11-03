- Prompt: lines `model:`, `effort:`, `mode: write` or `mode: read-only`, `approved: no`, `cwd: <absolute path>`,
  then `task:` and a self-contained assignment with completion criteria. Continue a session: `reply: <job>` + `task:`;
  reconnect after the worker crashed: `attach: <job>`. Stop: `{{PYTHON}} -I "{{CLONE}}/features/codex/tools/codex-run.py" cancel <job>`;
  list: `… list`.

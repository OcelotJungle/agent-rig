- `volunteer` always runs in the background; `description` is only the gist of the task. Prompt: `mode: write` or `mode: read-only`,
  `cwd: <absolute path>`, then `task:` and a self-contained assignment with completion criteria; the model is not chosen.
  Continue: `reply: <job>` + `task:`; reconnect: `attach: <job>`; stop:
  `{{PYTHON}} -I "{{CLONE}}/features/volunteers/tools/volunteer-run.py" cancel <job>`.

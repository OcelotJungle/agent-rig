- A job ends as `done`, `question`, `blocked` or `malformed`. `question`: answer the Questions section through
  `reply: <job>`. `blocked`: remove the `access:` or `environment:` cause the Blocked by section names, then repeat
  the task. `malformed` (unfinished work reported as blocked included) — the same task to `codex` (`luna` + `high`; `terra` if the task is complex) with a description of what was tried.
  `no free models available` — one line to the user, the task goes to `codex`. Codex unavailable — complex work also goes
  to a volunteer with a detailed brief, review — to general-purpose.

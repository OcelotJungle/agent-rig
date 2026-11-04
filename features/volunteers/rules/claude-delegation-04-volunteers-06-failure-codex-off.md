- A job ends as `done`, `question`, `blocked` or `malformed`. `question`: answer the Questions section through
  `reply: <job>`. `blocked`: remove the cause the Blocked by section names, then repeat the task. `malformed` — the
  same task to a Claude subagent by the tiers in "Subagent models" with a description of what was tried.
  `no free models available` — one line to the user, the task goes to a Claude subagent.

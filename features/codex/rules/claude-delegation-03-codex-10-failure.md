- A job ends as `done`, `question`, `blocked`, `malformed` or `limit`. `question`: answer the Questions section with
  the decisions through `reply: <job>`. `blocked`: remove the cause the Blocked by section names, then repeat the task.
  `malformed` (no valid report after the launcher's one automatic follow-up): the same brief one level up
  (`luna` → `terra` → `sol`), then do it yourself or ask the user. `limit` (the shared Codex usage limit ran out): tell
  the user the reset time from the result, wait for the reset, then continue the same job through `reply: <job>`; it
  stays on the line it was started on. If Codex is unavailable for another reason — one line to the user, then
  Explore or general-purpose.

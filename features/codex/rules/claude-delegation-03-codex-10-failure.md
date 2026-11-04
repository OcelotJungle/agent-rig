- A job ends as `done`, `question`, `blocked` or `malformed`. `question`: answer the Questions section with the
  decisions through `reply: <job>`. `blocked`: remove the cause the Blocked by section names, then repeat the task.
  `malformed` (no valid report after the launcher's one automatic follow-up): the same brief one level up
  (`luna` → `terra` → `sol`), then do it yourself or ask the user. If the model's limit runs out, the script takes the
  model below by itself; if Codex is wholly unavailable — one line to the user, then Explore or general-purpose.

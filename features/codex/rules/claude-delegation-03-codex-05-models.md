- Model, four lines. `luna`: mechanical work and simple tasks where it is hard to go wrong (search, simple
  implementation, tests, logs) — `high` by default (its usage is tiny anyway, and it has more brains); `medium` only
  for purely mechanical work with no decisions. `luna` at any effort, `xhigh` and `max` included, runs freely: it
  barely spends limits and the wrapper does not stop it; where brains are needed, `luna` is not set below `high`.
  `terra`: medium and complex tasks, and the preliminary review — usually `medium`, `high` on hard tasks and on
  reviews. `sol`: very complex tasks and the final review of a stage (`high`). Rework after a long task is a new
  agent with a narrow brief, not `reply:` into the old session. `terra` and `sol` above `high` only with the user's
  consent (`approved: yes`, otherwise the script refuses).
  `astra` only for a very complex task, with the user's consent after explaining why Sol is not enough
  (`approved: yes`, otherwise the script refuses).
- Review on Codex has two stages. First the preliminary review on `terra` `high`. Serious problems (High severity and
  above) are fixed and the `terra` review is repeated; minor findings are fixed before the next stage without another
  `terra` round. Only when `terra` finds no serious problems does the final review run on `sol` `high`.
- The Codex usage limit is one for all lines: when it runs out, every line is out at once, so another line is no way
  around it.

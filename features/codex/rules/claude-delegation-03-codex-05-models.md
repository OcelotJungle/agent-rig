- Model: most tasks (search, mechanical work, implementation, refactoring, tests, logs) — `luna` + `high` (its usage is
  tiny anyway, and it has more brains); `medium` only for purely mechanical work with no decisions. `sol` only with a weighty reason: truly
  complex work (usually `medium`) and the final review of a stage (`high`). Rework after a long task is a new agent with a
  narrow brief, not `reply:` into the old session. `luna` at `high`, `xhigh` and `max` runs freely: it barely
  spends limits, the wrapper does not stop it; where brains are needed, `luna` is not set below `high`. `sol` above `high` only with
  the user's consent.
  `astra` only for a very complex task, with the user's consent after explaining why Sol is not enough
  (`approved: yes`, otherwise the script refuses).

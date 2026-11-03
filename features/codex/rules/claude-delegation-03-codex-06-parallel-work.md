- Split large tasks into independent parts and run them in parallel: each task gets its own working copy (I create the
  worktree, Codex cannot) and its own shared resources — test database, ports, output folders; a shared test database
  is no reason to work in turns. How to separate the database in a project is in its memory. Do not re-check diffs already verified by tests,
  if the change is not critical. Do not ask for full diffs and logs.

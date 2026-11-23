- Split large tasks into independent parts and run them in parallel: each task gets its own working copy (I create the
  worktree, Codex cannot) and its own shared resources — test database, ports, output folders; a shared test database
  is no reason to work in turns. How to separate the database in a project is in its memory. Read the diff of every
  result before accepting it; do not ask Codex for full diffs and logs in its report.

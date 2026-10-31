# Commits

Whether you commit yourself is decided per project (Claude Code's "only when asked" default is not the user's rule):
- follow the project memory if it says whether you may commit and to which branches;
- if it says nothing, ask before the first commit there (may you commit your own work as it lands; to which branches),
  save the answer to project memory. Until then do not commit and say plainly that work waits uncommitted.
- Never write a commit restriction into a summary or memory as the user's rule unless the user stated it.
- Never add Claude attribution to commits, PRs, specs, plans or docs.
- One logical change per commit: split a mixed index, each commit with its own docs and tests passing alone.
- Never lose uncommitted work: back up before a rebase, stash apply rather than pop, no hard resets, rebase over
  merge, one git step at a time.

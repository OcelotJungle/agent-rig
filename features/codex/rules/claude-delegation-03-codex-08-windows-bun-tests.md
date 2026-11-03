- The Codex sandbox on Windows does not let tests run on Bun (EPERM when resolving paths, an open Codex bug);
  do not disable the sandbox. Test runs and bringing tests to green after Codex — general-purpose with `model: "haiku"`,
  `effort: "high"`; the first run on a large build of new code (many tasks or files, probably many fixes) —
  general-purpose with `model: "sonnet"`, `effort: "high"`. A task with tests is still led by Codex (`luna` + `high`): it writes the code and tests, and Haiku
  after it only runs the tests and fixes what failed. It is better to load Codex than the Claude limit.
  Haiku is not run after every small piece: let Codex finish all the parallel parts, they are collected into one
  branch, and one run with all the tests and code-breakage checks is called on it (on a large build — Sonnet).

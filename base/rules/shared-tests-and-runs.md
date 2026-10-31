# Tests and runs

- Never disable a failing test or gate a broken regime ("skip above N"); find the law it violates and fix that.
- A flaky bug gets its cause found (a race: fix it; not a race: explain it), never "under watch".
- Keep probes of a recurring problem as a filtered probe-category test; delete only one-off probes of a closed question;
  a probe's criterion must match what the user sees.
- No tuning to one case: every number in code and tests notes its source and conditions; a limit that follows from a
  setting is derived from it in code.
- Tests run as fast as possible: no real sleeps or waits on wall-clock timeouts (inject the clock or timer), seed in
  batches, minimal per-file and per-run overhead. A slow suite is a defect, fixed before review.
- Targeted tests while working. The full suite once before finishing only when the change touches code with callers
  beyond the changed feature (shared modules, protocol, config, test helpers); a change inside one feature runs that
  feature's tests and the type check. Save the full output to a file before filtering; on a failure read it before
  rerunning; failing test names stay visible.
- Chain a rebuild and the runs that depend on it with `&&`; never `build | grep; run`. Do not edit files a running job
  reads.
- Leave at least one core free across all your runs; serialize heavy runs; cap test parallelism; never background a
  full suite you cannot stop.
- Never kill processes by image name (`taskkill /IM`, `Stop-Process -Name`, `pkill` without `-f`, `killall`): it also
  kills other sessions' processes of that name, such as the telegram-hub hub and its plugins. Kill by PID or by a
  command-line match.
- Never commit a fix whose check was not run; the check must fail on the old code.
- Examples in model prompts are invented, never from the data a check runs on.
- A working (production) database is read-only for ad-hoc, manual or dev work; tests use their own disposable database.

# Background tasks and monitors

- Every background run that can last over ~2 min gets a Monitor in the same turn. A monitor speaks only when you must
  act: the result monitor emits terminal states only (done, failed, killed, error/Traceback lines), no progress lines.
  A run that can stay silent for minutes also gets a watchdog: checks every ~2 min (process alive, log growing), silent
  while healthy, one line and exit when the process died without a result or the log stalled. A background
  `until grep …` waiter is not a monitor. Re-arm on expiry while the run lasts.
- A Monitor tails the run's own output path from the run_in_background reply, armed after that reply; never `ls -t`.
- Jobs over a minute or two run in the background; no `&` in a foreground call.
- Before (re)starting a run, check `tasklist` (Git Bash `ps` misses other shells). TaskStop leaves a run's children
  alive: kill them by match and confirm 0. Never edit a running script.
- Every `tail -f`/`-F` in a monitor or background shell carries `--pid=$$` (TaskStop leaves `tail -f` running).
- Stop a background shell or monitor with TaskStop once its result is read. Before each final report, check for orphans
  (`tasklist | grep -ci tail.exe`) and kill the ones no live task uses.

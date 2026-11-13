# Background tasks of a subagent

A subagent stops every background task it started (a Monitor, a Bash with `run_in_background`, a background Agent) with TaskStop before it reports or ends. A hook refuses `SubagentHandback` and the end of a subagent while one of its tasks is alive, and the refusal lists the tasks: stop each with TaskStop, then report again. The main session is never guarded.

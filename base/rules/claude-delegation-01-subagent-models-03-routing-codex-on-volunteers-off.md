Model tiers for Claude subagents; they only pick the model once a task is a Claude subagent's. Whether a task goes to
Codex or a Claude subagent is decided by the delegation sections below: executive and complex work goes to Codex
(`terra` for complex tasks; the lines are chosen in «Delegating to Codex»), and a Claude subagent (Sonnet) takes it only
when Codex is unavailable or the task needs Claude-side tools.

  `{{HOME}}/.claude/CLAUDE.md`, below its two import lines, which stay untouched; or into a global skill under
  `{{HOME}}/.claude/skills/` when it applies only in a rare situation;
- a change to a rule that rig ships (text inside the rig block, or in `{{HOME}}/.agent-rig/generated/CLAUDE.md`) is made
  in the rule chunks of the rig clone, `{{CLONE}}/base/rules/` and `{{CLONE}}/features/*/rules/`, never in the
  generated files: rig rewrites them at the next `rig apply`. If the clone is the developer's working copy, edit it
  there. Otherwise do not edit or commit in the clone: tell the user which change to make in the rig repository.
Project memory holds only what is true of one project: decisions, data, infrastructure, state, pointers. When unsure,
it is global. No dates in rules, except where the date is the fact itself (a deadline, a limit reset).

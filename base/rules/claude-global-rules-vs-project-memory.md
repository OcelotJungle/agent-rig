# Global rules vs project memory

Before saving to memory, ask: does it hold beyond this project? Then it is not project memory:
- a new rule for any agent's work (code, tests, specs, tools, this machine) goes into `{{HOME}}/.codex/AGENTS.md`, below
  the block that rig writes (the block between `<!-- rig:begin -->` and `<!-- rig:end -->`), never inside it;
- a change to a rule that rig ships (text inside the rig block, or in `{{HOME}}/.agent-rig/generated/CLAUDE.md`) is made
  in the rule chunks of the rig clone, `{{CLONE}}/base/rules/` and `{{CLONE}}/features/*/rules/`, never in the
  generated files: rig rewrites them at the next `rig apply`. Only an agent whose working directory is the rig repository
  edits it. An agent in any other project never edits or commits in the clone, whatever the clone is: it writes the user
  a brief for the rig agent (what to change, why, what for);
- global config (settings, hooks, user CLAUDE.md, global skills) goes into `{{HOME}}/.claude`, never `$CLAUDE_CONFIG_DIR`.

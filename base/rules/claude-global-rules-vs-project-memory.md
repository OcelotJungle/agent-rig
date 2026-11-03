# Global rules vs project memory

Before saving to memory, ask: does it hold beyond this project? Then it is not project memory:
- a new rule for any agent's work (code, tests, specs, tools, this machine) goes into `{{HOME}}/.codex/AGENTS.md`, below
  the block that rig writes (the block between `<!-- rig:begin -->` and `<!-- rig:end -->`), never inside it;

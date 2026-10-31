# Compact instructions

Write the summary for yourself: you continue this exact work right after compaction and remember nothing else. The
system prompt, CLAUDE.md files, memory, invoked skills and recently modified files are reloaded, so do not restate
them; the full transcript stays on disk, so drop bulk and keep precision.

Keep, with exact paths, names, numbers and commands:
1. Current task: its goal, and the user's latest instructions, corrections and preferences, quoted where wording matters.
2. Plan: plan/spec files in use; steps done; the step in progress with its exact state; steps remaining.
3. Your changes: every file created or modified, one line each with its state (builds? tests pass?); do not re-read
   them after compaction unless the next step needs their exact content.
4. Decisions with reasons; approaches tried and rejected, and why.
5. Reference material read (paths) and the key facts from it.
6. Latest build/test run: command, result, failing tests with errors.
7. Open questions to the user, pending approvals, blockers.
8. The exact next action.

Drop raw tool output, file contents on disk, dead ends beyond one line, resolved back-and-forth. Scratch paths are given
as the project's `.tmp`, never a copied absolute temp path.

# Analysis before agents and estimates

Before launching any agent and before naming a time estimate for future work, write `<project>/.tmp/analysis.md` with `## Unknowns` (what is not known yet and could change the work or its time) and `## Class` (for each defect: the principle it breaks and every site that breaks it the same way; or "no defect: <what is being built>"); it stays valid 30 minutes. A hook blocks Agent launches without it, and the reflection flags an estimate without it.

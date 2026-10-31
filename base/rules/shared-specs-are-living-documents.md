# Specs are living documents

A spec describes how a feature or the system works now and is updated as decisions change; never a one-off dated
record. Spec files have no date: `docs/superpowers/specs/<topic>-design.md` (overrides the superpowers default).

Plans are temporary working documents, needed only while the work runs: `docs/superpowers/plans/<topic>.md`, with that
folder in `.gitignore`, never committed, deleted when the work is done (overrides the superpowers default). Neither
specs nor plans carry dates, in the file name or in the text, unless the date is itself the fact.

- Observations from runs go to reports, not specs; design lives in specs, not memory.
- A plan is short, in the user's language, without ready-made code or field-by-field interfaces (~150–250 lines).

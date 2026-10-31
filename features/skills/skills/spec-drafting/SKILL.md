---
name: spec-drafting
description: Use while drafting or updating a spec, design doc or implementation plan with the user, or writing statuses and decisions into project docs.
---

# Spec drafting

- While a spec is drafted, never hand the user the draft to proofread or summarize it at length. Each round: short numbered questions plus at most one status line; close gaps by questions and reading the code.
- When questions stay unanswered, take my stated recommendation and note in the spec which points were settled this way.
- Never write a status or decision (done, decided, dropped) into docs on inference. Before calling a mechanism missing or dropped, verify it in code and look for why (logs, archives); state that it was checked; batch the unverified items into one question.
- Plan step statuses are mine: update a step in the same turn it is done, dropped, superseded or blocked; every plan has a status table. Plans, ADRs and debt lists keep only what is current; history goes to an archive read by link.
- An implementation plan is short and readable, in the user's language: per task what it does (a few bullets), its key tests, a trap note only where something non-obvious was verified in advance. No ready-made code, no full signatures or field-by-field interfaces; roughly 150–250 lines. This overrides writing-plans skill defaults.

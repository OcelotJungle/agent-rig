# Review and engineering method

- A defect, review finding or live-run failure, the first one included, is a class before it is a fix: before any fix,
  find the design part that breeds it, name the principle it breaks and find every site that breaks it the same way
  (audit the whole class yourself, every rule held only by a model or by luck). The fix is the mechanism that makes the
  class impossible, never the cited site alone; fix it in one batch. A fix brief without the class and its full list of
  sites is not sent. A root that is a design choice goes to the user first. Never count rounds or wait for a repeat to
  look for the root, and do not hand the user lists to review.
- A fix is checked by a test that fails on the old code; a review is re-run only after a High-or-worse finding. "Done"
  for a spec is a finite list of checks named up front.
- Fix every finding, minors too, test first; skip only a wrong one, with the reason. The report lists rejected and
  still-open findings with the reason; fixed ones as a count.
- Design every mechanism and close disputes on paper before building; consult a subagent (Opus) on a design question
  with more than one viable option.
- A consultant or reviewer gets the problem, goals and requirements only, never my candidate fix or the user's remarks.
  Then I pick the most engineered simple fix and build until holes close.
- Fix a known visible defect that has a known general fix; do not stop at a proposal.
- A part done only in a test harness, not in production code, stays an open item in every report.
- After a slip, remove its class with a guard in a tool or script; guards in the user's own tooling (hooks, settings,
  global scripts, skills) are proposed in one line and wait for approval.

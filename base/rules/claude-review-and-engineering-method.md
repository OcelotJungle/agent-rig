# Review and engineering method

- A defect, review finding or live-run failure, the first one included, is a class before it is a fix: before any fix,
  find the design part that breeds it, name the principle it breaks and find every site that breaks it the same way
  (audit the whole class yourself, every rule held only by a model or by luck). The fix covers every site in one batch.
  It is first a deletion or a change to an existing part; a new type, layer, mechanism or guard is added only after
  the user says yes to it, named in one line with its size. A fix brief without the class and its full list of
  sites is not sent. A root that is a design choice goes to the user first. Never count rounds or wait for a repeat to
  look for the root, and do not hand the user lists to review.
- A fix is checked by a test that fails on the old code; a review is re-run only after a High-or-worse finding. "Done"
  for a spec is a finite list of checks named up front.
- Fix every finding, minors too, test first; skip only a wrong one, with the reason. The report lists rejected and
  still-open findings with the reason; fixed ones as a count.
- Design every mechanism and close disputes on paper before building; consult a subagent (Opus) on a design question
  with more than one viable option.
- A consultant or reviewer gets the problem, goals and requirements only, never my candidate fix or the user's remarks.
  Then I pick the simplest fix and build until holes close.
- Fix a known visible defect that has a known general fix; do not stop at a proposal.
- A part done only in a test harness, not in production code, stays an open item in every report.

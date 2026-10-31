# Review and engineering method

- Third review round in a row with a new High: no more reviewers; find the design part that breeds the holes and tell
  the user. The same for live runs that each find a new defect: stop fixing one per run; audit the whole class
  yourself (every rule held only by a model or by luck), fix it in one batch, and do not hand the user lists to review. A fix is checked by a test against the stated principles, not by a re-review; "done" for a spec is a finite
  list of checks named up front.
- Fix every finding, minors too, test first; skip only a wrong one, with the reason; the report lists only rejections.
- Design every mechanism and close disputes on paper before building; consult a subagent per mechanism.
- A general rule over a list of cases, invariants in code, not prompt wording. Before each change: is it a principle or a
  patch for the case just seen, and can my check fail?
- A consultant or reviewer gets the problem, goals and requirements only, never my candidate fix or the user's jabs.
  Then I pick the most engineered simple fix and build until holes close.
- Fix a known visible defect that has a known general fix; do not stop at a proposal.
- A part done only in a test harness, not in production code, stays an open item in every report.
- After a slip, remove its class with a guard in a tool or script; guards in the user's own tooling (hooks, settings,
  global scripts, skills) are proposed in one line and wait for approval.

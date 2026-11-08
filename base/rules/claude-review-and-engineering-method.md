# Review and engineering method

- A review or a live run finds a defect, the first one included: before any fix, find the design part that breeds it
  and fix there; a design root goes to the user first. Never count rounds or wait for a repeat to look for the root.
  Audit the whole class yourself (every rule held only by a model or by luck), fix it in one batch, and do not hand
  the user lists to review. A fix is checked by a test against the stated principles, not by a re-review; "done" for a
  spec is a finite list of checks named up front.
- Every review finding is a class before it is a fix: name the principle it breaks and find every site in the code that
  breaks it the same way. The fix is the mechanism that makes the class impossible, never the cited site alone; a fix
  brief without the class and its full list of sites is not sent. Why: the cited site alone leaves the class open, and
  the next review finds the next site.
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

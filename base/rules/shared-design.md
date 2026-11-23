# Design

- Build on how code and specs already handle it; the smallest thing that meets the requirement; no rewrite of existing
  systems for a nicer feature; shared code split by consumer.
- No known defects designed in, no hard part postponed; check assumptions against the real audience and growth. Walk
  data through every later step. Drop ideas that runs refuted.
- Build the final form, not an interim variant (planned spikes exempt), and no code for a case that cannot occur yet.
  A requirement beyond the measured envelope: say so with feasible numbers.
- A general rule over a list of cases, invariants in code, not prompt wording. Before each change: is it a principle or
  a patch for the case just seen, and can the check fail?

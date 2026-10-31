- Code with no caller left in production code goes to a subagent for removal at once, with a before/after type-check,
  and is reported. Only removals that someone may still need (data, assets, dev scripts) wait for the user's approval
  of the exact list.

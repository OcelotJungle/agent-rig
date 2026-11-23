- the final large review before handing work over, one pipeline in two stages with Claude models. First a preliminary
  review by one Sonnet reviewer (`model: "sonnet"`, `effort: "high"`), repeated after fixes while it finds serious
  problems (High severity and above); minor findings are fixed without another round. Then the final stage: one Opus
  reviewer (`model: "opus"`, `effort: "high"`), never a batch of scoped reviewers. Opus runs only at the final stage.
  A fix is checked by a test that fails on the old code.

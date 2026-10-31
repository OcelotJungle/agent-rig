# Ask-driven development

The main working rule, above default autonomy. When unsure what the user means, which way to go, or what a step should
touch, ask clear, plain questions and wait for the answers instead of guessing. Find out yourself whatever the code,
docs or a check can tell you, and don't ask about that. Once the intent is clear, carry the whole job through without
hand-holding, its consequences included (seeds, cleanup, isolation, review findings).

Debatable decisions are the user's. Before you build, write a spec or plan, or hand work to a subagent, list the
decisions the request leaves open. A decision is debatable when a reasonable person could choose otherwise and the
choice changes what the user sees, how a command or feature behaves (conflicts included), what gets lost, kept or
deleted, or what it costs. Ask about every one first, in one message, each with your recommendation, and wait. A
detailed spec from the user does not make its gaps yours to fill; settling one yourself and listing it afterwards as
"решения, которые я принял сам" is the same as not asking. Only choices that change none of the above (naming,
internal structure, a constant within what the spec implies) stay yours; report each with its reason in one line. A
user's question about such a call is not a veto: answer, keep it unless the reason fails.

Never end a proposal with a go-ahead question («Так делаем?», «Начинаю?», «Ок?», «Подходит?», "shall I proceed", any
language). State the proposal and stop. Ask only real questions whose answer is more than yes/no to the proposal: a
choice between options, a missing fact.

- **Asking.** Only what the current work needs; a far-ahead choice waits. A question the user ignored or deferred is
  closed: never press it or log it as "waiting on the user". Options phrased clearly, the reliable one as default; never
  dictate the answer format. Essence first in plain text, then the questions: short labels in a poll, one numbered list

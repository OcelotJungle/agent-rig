Before launching several agents at once, re-read the user's latest word on limits and pick each agent's tier by it;
a running agent is not stopped just to change its tier when the context it already built would be thrown away.
Default to the simplest subagent that can do the job, the lowest tier that fits. Split work into several independent
subagents, each with one small narrow task, rather than one agent with a fat brief: a long-running agent re-reads its
growing context on every step. Why: big-model fan-outs and fat single agents are wasteful; the small
models handle narrow routine work fine.

# volunteer — an executor on free cloud models

The guide is in the agent rules, section "Delegating to volunteers".

## Purpose

Another executor next to `codex`. It does ordinary, routine work on free cloud models,
so as not to spend the Claude and ChatGPT limits. Complex work and review belong to Codex: this way the volunteers'
work always has a checker.

## Scheme

```
Claude → subagent volunteer (Haiku, modeled on agents/codex.md)
       → tools/volunteer-run.py (modeled on codex-run.py: supervisor, wait/reply/attach, cancel, timeouts)
       → opencode run --format json
       → freellmpool (a local OpenAI-compatible proxy, localhost only)
       → free providers
```

- `codex.md` and `codex-run.py` do not change.
- Jobs live in `~/.claude/volunteer-jobs/<JOB>/`, with `state.json` in the format of Codex jobs; the model that actually
  answers is written to `slug`, so that the hub card shows it.
- The hub (`claude-telegram-hub`) does not change for this executor: for it to show volunteer jobs, the hub needs
  an extended `agentType === "codex"` check, regexps, a job directory and an event schema for OpenCode.

## Decisions

| Decision | Why |
|---|---|
| The name `volunteer` | |
| Ordinary work goes to volunteer, complex work and review to Codex | otherwise nobody checks the volunteers' work |
| The gateway is freellmpool, with OpenRouter inside it as a provider | the alternative (Arbiter) has static quotas, Gemini without tools, a paid tail, silent model substitution, and no tests |
| The OpenRouter limit on `:free` depends on the account: 1000 requests a day per account when at least 10 credits have been bought over all time (in code `OPENROUTER_DAY_CAP` = 1000) | the limit is counted over all purchases over all time |
| The gateway is started by `volunteer-run.py` if it does not answer, and is left running | |
| One model for the whole job, switched only on an error or an exhausted quota | switching models between steps is a quality risk |
| When all free models are exhausted the job ends with a reason; Claude reports it and hands the job to Codex | |
| Permissions like Codex: read-only / write, writing only in `cwd`, no commits or pushes | |
| Work is allowed only in folders from the allowlist (`~/.agent-rig/volunteer-projects.json`); other folders, including `~/.claude`, are not in it until the user adds them | the user decides which code goes to free providers |
| The script uses only providers with a key: OpenRouter, Groq, Z.ai, Requesty (the `ALLOWED_PROVIDERS` list in `volunteer-models.py`). Providers without a key (Pollinations, OVHcloud, Kilo, LLM7) are not used, nor is Gemini: its adapter does not support tools. The user sets up the keys of the needed providers | with keyless providers it is unknown who stores the requests |
| OpenCode is installed with autoupdate off (`"autoupdate": false`) | the version the probes were checked on must not change by itself |
| Keys are stored only in the freellmpool config, not in the environment of Claude sessions and not in Telegram | secrets must not reach subagents and the hub |
| The model is not chosen at call time; the card shows the actual model | |
| The card shows the last finished action, not the one in progress (OpenCode `run` reports an action when it finishes); server mode is not used | an extra process for a trifle |
| The script finds the models: free models with tools from the allowed providers + a trial call; a one-day cache. No schedule: the refresh is started by `volunteer-run.py start` itself if the cache is older than a day (in the background, the job runs on the old cache; the first time — synchronously) | no manual list is needed; no schedule is needed and it cannot be forgotten switched off |
| Model order: first a short list of preferred ones (in code `FAVORITES` in `volunteer-models.py`), then the rest found, by speed, Groq last | the preferred ones were chosen from the probe results |
| The full OpenCode agent where the limits allow (it reads the project rules and the shared rules `~/.codex/AGENTS.md` itself, but not `~/.claude/CLAUDE.md` — that holds the orchestrator's rules); a trimmed one only for Groq | the executor needs the rules anyway, let it read them itself |
| Requesty is not in freellmpool 0.13.0: it has to be connected as a custom provider (`providers.toml`), and only models with a verified zero price are taken | paid models must not spend money |
| In the OpenRouter privacy settings (https://openrouter.ai/settings/privacy) the providers that may train on requests of free models must be allowed | otherwise part of the free models is unavailable; code goes there only from the allowlist |
| The model is to blame only if the infrastructure is healthy: after a failure, first a check of the gateway (`proxy_up`), then of the network (TCP to the API hosts of the providers in use). Gateway down — restart and retry the same model without switching (no more than 3 restarts per job, otherwise `gateway keeps dying`); no network — wait with `waiting: "network"`, polling every 15 s, until the hard timeout (`no network since HH:MM`) | otherwise, because of a dead gateway or a dropped internet connection, all models were cycled through and the job failed with "no free models" |
| Separate processes (gateway, supervisor) start with `CREATE_BREAKAWAY_FROM_JOB`; if the Job object forbids breakaway, the launch goes through WMI `Win32_Process.Create` (`volunteer-launch.ps1`), with no silent fallback to a normal launch. The token does not appear on the command line: the gateway starts with the hidden subcommand `proxy-serve` | processes started from a Job object with KILL_ON_JOB_CLOSE died together with the launcher |
| All subprocesses on Windows with `CREATE_NO_WINDOW` (instead of `DETACHED_PROCESS`) | a detached process has no console, and each of its console descendants opened a visible window; a hidden console is inherited |
| "Hang" is 10 minutes without OpenCode events (`IDLE_SECONDS` = the gateway timeout of 540 s + 60 s of margin) | the gateway returns a response with tool calls whole, so while the model thinks there are no events; the gateway itself gives up after 540 s (`_AGENT_UPSTREAM_TIMEOUT` in freellmpool 0.13.0) and returns an error. A 5-minute threshold killed a live request |
| A temporary failure (timeout, 5xx/504, overloaded, 429, hang) sends the model to "cooling down" for 5 minutes; the next one is the first in order that is not cooling down and fits the context. If all are cooling down — wait for the nearest end (`waiting: "models"`, note `all models cooling down, waiting until HH:MM`). Permanent failures (context overflow, 4xx) exclude the model until the end of the job. `switches` counts only real model changes. The job fails only if no model fits the context, or at the hard timeout | "forward without return" cycling failed the job while the models were merely overloaded |
| Models with a window smaller than the current session are skipped; the reply headroom is `REPLY_HEADROOM_TOKENS` = 8000. The session size is an estimate of the bytes of events and prompt / 4 (OpenCode always writes tokens = 0 in events), taking the maximum with the number from the overflow error. Windows come from public lists (`context_length` of OpenRouter, `context_window` of Requesty, the `context` entry in the cache) and a static 8000 for Groq (the TPM limit); window unknown — the model is tried, an overflow counts as permanent | a model with a small window failed on a long session and burned a switch |

## Open questions

None.

## Guide (the current text is in the agent rules, section "Delegating to volunteers")

- `volunteer` is the default executor for routine work: searching and reading code, implementing a ready plan,
  routine edits, tests until green, log analysis. Always in the background. Prompt: `mode:`, `cwd:`, `task:` and a
  self-contained assignment with completion criteria; the model is not chosen.
- `codex` — complex work (a tricky change, many linked files, a subtle bug), review of non-trivial results of
  volunteers and of important changes, a second attempt after a volunteer's failure.
- A project outside the allowlist (`REFUSED:`) — straight to `codex`. The allowlist is in the local file
  `~/.agent-rig/volunteer-projects.json`, format `{"allowed": ["<folder>"]}`; without it every folder is refused.
- A job ends as `done`, `question`, `blocked` or `malformed`. `question` — answer through `reply: <job>`; `blocked` —
  remove the `access:` or `environment:` cause, repeat the task. Environment failures require one retry; unfinished
  work alone is never a blocker. `malformed` — the same task to `codex` on `luna` (`terra` if the task is complex)
  with a description of what was tried. No free models left — one line to the user, the task goes to `codex`.
- Codex unavailable — complex work also goes to a volunteer with a detailed brief, review — to general-purpose.

## Limits

- `volunteer-models.py limits [--json]` — a daily summary for the hub's reference: OpenRouter 1000/day per account (when
  ≥10 credits were bought), Requesty 200/day per account (docs.requesty.ai), Groq by the models from the cache, Z.ai separately without a percentage.
  The reset is at midnight UTC.
- Groq publishes the free plan's limits only in the account dashboard, and they change. For `gpt-oss-120b`,
  `gpt-oss-20b`, `qwen3.8-27b` at the time of the probes these were 30 RPM, 1K RPD, 8K TPM, 200K TPD; the freellmpool catalog matches. Tokens are hit first: at 3–20k tokens
  per agent step, 200K a day is roughly 10–60 requests per model. The summary counts only requests, so
  for Groq it is optimistic.

## Tool behavior (how to check: `volunteer-probes.md`)

- freellmpool 0.13.0: the actual model is in `x_freellmpool.model` and `X-Freellmpool-Model`; `provider/model`
  turns the fallback off; `Retry-After` is not passed to the client (502 on exhaustion); there is no sticky routing;
  `auto`/`agent` with tools give 503 — the script always pins the model and switches it itself on an error.
- OpenCode: the working folder is taken from the env `PWD`; without a hard timeout it hangs on retries; the service request for the title
  is turned off by `agent.title.disable`; in Git Bash `taskkill //F //T //PID`.
- Windows Job objects: Claude Code runs commands inside a Job object with KILL_ON_JOB_CLOSE; a process left in it
  dies when the job closes. `CREATE_BREAKAWAY_FROM_JOB` works only if the Job allows breakaway, otherwise `OSError`.
  A launch through WMI (`Win32_Process.Create`, the process is created by WmiPrvSE) is always outside the Job, but without the inherited environment —
  so the launch specification is passed as a file, and the secrets inside the process itself.

# volunteer-probes: verified facts (freellmpool 0.13.0 + OpenCode 1.19.4)

The mark [src] = derived from the source code, not verified live.

## 1. Config and providers
- OpenCode is installed globally through bun; for volunteers its config needs `"autoupdate": false`.
- The freellmpool config path: `~/.config/freellmpool/config.toml` or `FREELLMPOOL_CONFIG_FILE`. UTF-8 without BOM only (UTF-16 breaks it).
- On Windows `PYTHONUTF8=1` is needed (otherwise `--help` fails with cp1252).
- The 0.13.0 catalog: 22 providers. pollinations, ovh, kilo, llm7 work without a key (the key is optional). The others need a key: groq, openrouter, gemini, zhipu, huggingface, aion, modelscope, morph, vercel, siliconflow, cerebras, nvidia, cloudflare, mistral, cohere, sambanova, ollama. There is no requesty provider in the catalog: a key for it is ignored. It can be connected with a custom catalog `~/.config/freellmpool/providers.toml` (or `$FREELLMPOOL_CONFIG`) with `id`, `adapter="openai"`, `base_url`, `key_env`, `models`; this was not verified.

## 2. Starting the proxy
- `uvx freellmpool proxy --host 127.0.0.1 --port 18080`; a token without editing the toml: env `FREELLMPOOL_PROXY_KEY` (priority: the `--api-key` flag > env > `[settings] proxy_key`) [src; the env works live]. Dashboard `/dashboard`, route state `/v1/status`.
- Stopping: if the proxy was started through uvx, the shell's TaskStop leaves freellmpool.exe and python behind; the tree uvx.exe -> uv.exe -> freellmpool.exe -> python has to be killed by PID.

## 3. /v1/models
- Entries `{id, object, owned_by:"freellmpool", capabilities:{}, verified_features:[]}`. There is neither a context size nor a tools flag.
- Virtual ones: auto, agent, spread, fast, quality, fair. The rest are `provider/model`.
- Tool calling works with a request that pins the model. gemini: 502 "gemini adapter does not support tools" (`freellmpool/client.py:607`, `aio.py:246`).

## 4. Who answered
- Response body: `"model":"<provider>/<model>"` and `"x_freellmpool":{"provider":...,"model":...}`.
- Headers: `X-Freellmpool-Provider`, `X-Freellmpool-Model`, `X-Freellmpool-Attempts`.
- `model:"auto"` and `"agent"` with `tools` -> 503 `no_providers` (probably because of the empty verified_features; the cause is not confirmed). For tools the `provider/model` must be pinned.

## 5. Pin, errors, Retry-After
- Pin formats: `provider/model`, `provider`, a bare model name, `auto` [src proxy.py:1755-1775]. An exact pin turns off the fallback to other providers [src router.py:1185].
- An upstream overload (429) opens a circuit: the next requests to the route instantly get `502 all providers exhausted (...: skipped (persistent circuit open))`. The recovery is long, so an unreliable model cannot be kept as the main one.
- Circuit (route_health.py, router.py ~419): 429 opens the route's circuit at once and provider-wide. Cooldown = the upstream's Retry-After if there is one, otherwise 60 s x 2^(open_count-1), at most 3600 s. The threshold for other errors: 3 in a row. A half-open circuit lets only one probe through at a time. Look at: `/v1/status` (`cooldown_remaining_s`, `circuit_state`).
- A model that does not exist at the provider: the proxy passes through `404 The model ... does not exist` (opencode: error event, exit 1, isRetryable=false).
- Groq free: `413 Request too large ... TPM limit 8000`. The standard opencode request (~81 KB, ~20k tokens) does not fit this limit; opencode goes into a compaction loop and hangs until the timeout.
- Retry-After is not passed to the client; the router itself sleeps if it fits the deadline, otherwise it skips the target [src router.py:1214-1230]. There is no sticky routing [src]. Tools/stream are handled buffered [src].
- A model that is turned off in the proxy catalog (`enabled=false`, `rpd=0`) is not served by the proxy.

## 6. opencode run through the proxy
Config only through `OPENCODE_CONFIG_CONTENT` (`@ai-sdk/openai-compatible`, baseURL `http://127.0.0.1:18080/v1`, apiKey `{env:FLP_TOKEN}`, models with `tool_call:true`, permission read/edit/bash allow, external_directory deny).
- Event types: `step_start`, `tool_use`, `step_finish`, `text`, `error`. sessionID is in EVERY event (top level, `ses_...`).
- Samples (truncated):
  - `{"type":"step_start","timestamp":...,"sessionID":"ses_...","part":{"type":"step-start",...}}`
  - `{"type":"tool_use","sessionID":"ses_...","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"hello.txt","content":"hi"},"output":"Wrote file successfully.",...}}}`
  - `{"type":"step_finish","sessionID":"ses_...","part":{"reason":"tool-calls","type":"step-finish","tokens":{"input":0,"output":0,...},"cost":0}}` (tokens are always 0: usage does not arrive through the proxy)
  - `{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"**hi**",...}}`
  - `{"type":"error","sessionID":"ses_...","error":{"name":"APIError","data":{"message":"HTTP 404: ...","statusCode":404,"isRetryable":false,...}}}`
- A tool refusal (`status:"error"`, for example a write outside the project with `external_directory` deny) is usually worked around by the model with a retry.
- The cwd TRAP: opencode takes the working directory from the env `PWD`, not from the process's real cwd. When started from Git Bash or from python with an inherited `PWD`, files are created in someone else's folder. Set `env["PWD"]` to the working folder (or use `--dir`).
- The hang trap: while a retry or compaction is going on, stdout is empty; a hard timeout and `taskkill /F /T /PID` are needed (`subprocess.run(timeout)` on Windows hangs longer than the timeout because of child processes with pipes). After a model error, exit 1.
- Parallel requests: opencode sends a title request (without tools) about 2 s before the main one, and it runs at the same time; this worsens the limits and the circuit opening. `{"agent":{"title":{"disable":true}}}` removes the title, and the requests become strictly sequential.

## 7. Continuing a session with another model
`-s ses_... -m freellmpool/<provider>/<model> "..."`: the sessionID is the same, the session context carries over between models. Continuing on the same model works too.

## 8. Processes
After a normal exit of `opencode run`, no opencode.exe processes remain. On a kill by timeout, `taskkill /F /T /PID` removes the whole tree.

## 9. Minimal agent
- The standard opencode request: ~81 KB (~20k tokens), 15 tools, a system prompt of about 50k characters, including the global MCP and the picked-up `~/.claude/CLAUDE.md`.
- A minimal agent (its own short prompt, tools read/bash/glob/grep, title off, MCP off) without `OPENCODE_DISABLE_CLAUDE_CODE`: ~34 KB, ~9k tokens, still above the Groq limit.
- With `OPENCODE_DISABLE_CLAUDE_CODE=1` + `--agent mini`: ~12 KB, a system prompt of about 2k characters, ~3k tokens; such a request goes through on Groq too.
- Conclusion: opencode needs a minimal agent (`agent.title.disable=true`, its own short prompt, a trimmed tools list, MCP off, `OPENCODE_DISABLE_CLAUDE_CODE=1`). This removes the parallel requests and cuts the request size roughly sevenfold.
- usage does not arrive through the proxy (always 0 or empty), tokens can only be estimated from the body size.

## Recommendations for the executor
- Pin `provider/model` explicitly; `auto` with tools does not work.
- Not suitable as an executor: gemini (the adapter does not support tools), groq with the standard agent (the TPM limit), models whose upstream often answers 429 and opens a circuit.
- Set `PWD`, a hard timeout with a kill of the tree, catch `error` events and exit != 0.
- Which free models are suitable depends on the moment and on the keys; check each with a short task (create a file, read it, continue the session with `-s`) before putting it on the list.

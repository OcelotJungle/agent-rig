# volunteer-probes: проверенные факты (freellmpool 0.13.0 + OpenCode 1.19.4)

Пометка [src] = выведено из исходников, не проверено вживую.

## 1. Конфиг и провайдеры
- OpenCode ставится глобально через bun; для волонтёров в его конфиге нужен `"autoupdate": false`.
- Путь конфига freellmpool: `~/.config/freellmpool/config.toml` или `FREELLMPOOL_CONFIG_FILE`. Только UTF-8 без BOM (UTF-16 ломает).
- На Windows нужен `PYTHONUTF8=1` (иначе `--help` падает с cp1252).
- Каталог 0.13.0: 22 провайдера. Без ключа работают pollinations, ovh, kilo, llm7 (ключ необязателен). Остальным нужен ключ: groq, openrouter, gemini, zhipu, huggingface, aion, modelscope, morph, vercel, siliconflow, cerebras, nvidia, cloudflare, mistral, cohere, sambanova, ollama. Провайдера requesty в каталоге нет: ключ для него игнорируется. Подключить его можно пользовательским каталогом `~/.config/freellmpool/providers.toml` (или `$FREELLMPOOL_CONFIG`) с `id`, `adapter="openai"`, `base_url`, `key_env`, `models`; это не проверялось.

## 2. Запуск прокси
- `uvx freellmpool proxy --host 127.0.0.1 --port 18080`; токен без правки toml: env `FREELLMPOOL_PROXY_KEY` (приоритет: флаг `--api-key` > env > `[settings] proxy_key`) [src; живьём env работает]. Дашборд `/dashboard`, состояние маршрутов `/v1/status`.
- Остановка: если прокси запущен через uvx, TaskStop оболочки оставляет freellmpool.exe и python; дерево uvx.exe -> uv.exe -> freellmpool.exe -> python надо убивать по PID.

## 3. /v1/models
- Записи `{id, object, owned_by:"freellmpool", capabilities:{}, verified_features:[]}`. Ни контекста, ни признака tools нет.
- Виртуальные: auto, agent, spread, fast, quality, fair. Остальные `provider/model`.
- Tool calling работает при запросе с закреплённой моделью. gemini: 502 "gemini adapter does not support tools" (`freellmpool/client.py:607`, `aio.py:246`).

## 4. Кто ответил
- Тело ответа: `"model":"<provider>/<model>"` и `"x_freellmpool":{"provider":...,"model":...}`.
- Заголовки: `X-Freellmpool-Provider`, `X-Freellmpool-Model`, `X-Freellmpool-Attempts`.
- `model:"auto"` и `"agent"` с `tools` -> 503 `no_providers` (вероятно из-за пустых verified_features; причина не подтверждена). Для tools нужно пинить `provider/model`.

## 5. Пин, ошибки, Retry-After
- Форматы пина: `provider/model`, `provider`, голое имя модели, `auto` [src proxy.py:1755-1775]. Точный пин отключает фолбэк на другие провайдеры [src router.py:1185].
- Перегрузка апстрима (429) открывает circuit: следующие запросы к маршруту мгновенно получают `502 all providers exhausted (...: skipped (persistent circuit open))`. Откат долгий, поэтому ненадёжную модель основной держать нельзя.
- Circuit (route_health.py, router.py ~419): 429 открывает circuit маршрута сразу и provider-wide. Cooldown = Retry-After апстрима, если есть, иначе 60 с x 2^(open_count-1), максимум 3600 с. Порог для прочих ошибок: 3 подряд. У half-open только одна проба за раз. Смотреть: `/v1/status` (`cooldown_remaining_s`, `circuit_state`).
- Несуществующая модель у провайдера: прокси пробрасывает `404 The model ... does not exist` (opencode: error event, exit 1, isRetryable=false).
- Groq free: `413 Request too large ... TPM limit 8000`. Стандартный запрос opencode (~81 КБ, ~20k токенов) под этот лимит не проходит; opencode уходит в цикл компакции и висит до таймаута.
- Retry-After клиенту не передаётся; роутер сам спит, если укладывается в дедлайн, иначе пропускает цель [src router.py:1214-1230]. Sticky-маршрутизации нет [src]. Tools/stream обрабатываются буферно [src].
- Модель, которая в каталоге прокси выключена (`enabled=false`, `rpd=0`), прокси не отдаёт.

## 6. opencode run через прокси
Конфиг только через `OPENCODE_CONFIG_CONTENT` (`@ai-sdk/openai-compatible`, baseURL `http://127.0.0.1:18080/v1`, apiKey `{env:FLP_TOKEN}`, models с `tool_call:true`, permission read/edit/bash allow, external_directory deny).
- Типы событий: `step_start`, `tool_use`, `step_finish`, `text`, `error`. sessionID есть в КАЖДОМ событии (верхний уровень, `ses_...`).
- Образцы (обрезано):
  - `{"type":"step_start","timestamp":...,"sessionID":"ses_...","part":{"type":"step-start",...}}`
  - `{"type":"tool_use","sessionID":"ses_...","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"hello.txt","content":"hi"},"output":"Wrote file successfully.",...}}}`
  - `{"type":"step_finish","sessionID":"ses_...","part":{"reason":"tool-calls","type":"step-finish","tokens":{"input":0,"output":0,...},"cost":0}}` (токены всегда 0: usage через прокси не доезжает)
  - `{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"**hi**",...}}`
  - `{"type":"error","sessionID":"ses_...","error":{"name":"APIError","data":{"message":"HTTP 404: ...","statusCode":404,"isRetryable":false,...}}}`
- Отказ tool (`status:"error"`, например запись вне проекта при `external_directory` deny) модель обычно обходит повторной попыткой.
- ЛОВУШКА cwd: opencode берёт рабочую директорию из env `PWD`, а не из реального cwd процесса. При запуске из Git Bash или питона с унаследованным `PWD` файлы создаются в чужой папке. Задавать `env["PWD"]` рабочей папкой (или `--dir`).
- Ловушка зависания: пока идёт ретрай или компакция, stdout пуст; нужен жёсткий таймаут и `taskkill /F /T /PID` (`subprocess.run(timeout)` на Windows висит дольше таймаута из-за дочерних процессов с трубами). После ошибки модели exit 1.
- Параллельные запросы: opencode шлёт title-запрос (без tools) примерно за 2 с до основного, и он идёт одновременно с ним; это усугубляет лимиты и открытие circuit. `{"agent":{"title":{"disable":true}}}` убирает title, запросы становятся строго последовательными.

## 7. Продолжение сессии другой моделью
`-s ses_... -m freellmpool/<provider>/<model> "..."`: sessionID тот же, контекст сессии переносится между моделями. Продолжение на той же модели тоже работает.

## 8. Процессы
После нормального выхода `opencode run` процессов opencode.exe не остаётся. При kill по таймауту `taskkill /F /T /PID` убирает всё дерево.

## 9. Минимальный агент
- Стандартный запрос opencode: ~81 КБ (~20k токенов), 15 tools, system около 50k символов, включая глобальные MCP и подхваченный `~/.claude/CLAUDE.md`.
- Минимальный агент (свой короткий prompt, tools read/bash/glob/grep, title выключен, MCP выключен) без `OPENCODE_DISABLE_CLAUDE_CODE`: ~34 КБ, ~9k токенов, всё ещё выше лимита Groq.
- С `OPENCODE_DISABLE_CLAUDE_CODE=1` + `--agent mini`: ~12 КБ, system около 2k символов, ~3k токенов; такой запрос проходит и на Groq.
- Вывод: для opencode нужен минимальный агент (`agent.title.disable=true`, свой короткий prompt, урезанный список tools, MCP выключен, `OPENCODE_DISABLE_CLAUDE_CODE=1`). Это убирает параллельные запросы и снижает размер запроса примерно в семь раз.
- usage через прокси не приходит (всегда 0 или пусто), токены можно только оценивать по размеру тела.

## Рекомендации для исполнителя
- Пинить явно `provider/model`; `auto` с tools не работает.
- Не годятся в качестве исполнителя: gemini (адаптер не поддерживает tools), groq со стандартным агентом (лимит TPM), модели, у которых апстрим часто отвечает 429 и открывает circuit.
- Задавать `PWD`, жёсткий таймаут с kill дерева, ловить `error` события и exit != 0.
- Какие бесплатные модели годятся, зависит от момента и от ключей; проверять каждую короткой задачей (создать файл, прочитать его, продолжить сессию `-s`) до включения в список.

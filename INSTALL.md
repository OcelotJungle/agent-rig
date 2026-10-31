# Установка rig на сервер

Этот файл читает ИИ-агент на сервере. Первую часть («Что делает человек») выполняет человек сам: в ней входы и токены.
Токены, пароли и коды входа человек вводит только в терминале или в браузере. В чат агенту их не вставляют.

Целевая система: Ubuntu 24.04 (другие Linux с `apt` подойдут, имена пакетов те же).

Что такое rig: программа `rig` собирает правила, хуки и плагины Claude Code и Codex из набора фич и обновляет их по cron раз в час. Подробности в `README.md`.

## Что делает человек

1. Создай обычного пользователя, не root. Дай ему `sudo`. Если `sudo` спросит пароль, вводи его в терминале.
2. Настрой вход по SSH-ключу для этого пользователя и работай дальше под ним.
3. Установи `curl` и `ca-certificates`. Они нужны установщикам Claude Code и Bun:
   `sudo apt-get update && sudo apt-get install -y curl ca-certificates`
4. Установи Claude Code на канале `stable` и проверь версию:
   `curl -fsSL https://claude.ai/install.sh | bash -s stable && ~/.local/bin/claude --version`
   Этот установщик сам записывает `autoUpdatesChannel: stable` в `~/.claude/settings.json`. Если ключа там нет, `rig install` на сервере запишет `stable` сам, но ключом не владеет и позже его не меняет. Канал по умолчанию (`latest`) может принести нестабильную версию.
5. Войди в Claude Code: запусти `claude` и пройди вход по ссылке в браузере. Выйди из него после входа.
6. Создай Telegram-бота: в Telegram напиши @BotFather, команда `/newbot`. Токен сохрани у себя, агенту его не отправляй.
7. Создай супергруппу в Telegram, включи в ней темы (Topics), добавь бота и сделай его администратором.
8. Узнай свой числовой Telegram ID (например, через бота @userinfobot). Он понадобится на шаге 7.3 (`allowFrom`). Числовой ID самой группы (`groupId`) узнаешь на шаге 7.6: напиши в группе любое сообщение, ID будет в журнале хаба.

Когда всё готово, скажи агенту: «Начинай с шага 1». Токен бота, Telegram ID и ID группы введёшь сам на шаге 7: агент скажет, какую команду выполнить в терминале (токен вводится скрытно, в историю шелла и в чат не попадает), а ты ответишь, что готово. Подтверждение канала в tmux тоже твоё: шаг 7.7 говорит, когда оно нужно и как убрать этот вопрос совсем.

## Что делает агент

Выполняй шаги по порядку, по одному действию. После каждого проверь признак успеха. Если проверка не прошла, смотри раздел «Если шаг не удался» и не иди дальше.

### Шаг 1. Системные пакеты

Команда:

`sudo apt-get update && sudo apt-get install -y git python3 bash cron tmux unzip ca-certificates curl nodejs`

Зачем каждый пакет:

- `git`: rig клонирует и обновляет два репозитория, читает версии, ставит маркетплейсы плагинов. `rig check` проверяет его наличие.
- `python3`: хуки фич `base`, `reflection`, `codex` запускаются через python; `rig check` требует интерпретатор `python3`.
- `bash`: фича `base` проверяет его; `rig check` запускает `base/hooks/project-tmp.sh`.
- `cron`: `rig install` на сервере ставит записи в `crontab` и без него останавливается. `rig check` на Linux проверяет его наличие.
- `tmux`: нужен хабу (сессии Claude Code); `rig check` на Linux проверяет его наличие.
- `unzip`, `curl`, `ca-certificates`: установщик Bun и загрузки по HTTPS.
- `nodejs`: Codex, установленный через Bun, запускается как `#!/usr/bin/env node`; без `node` команда `codex` не работает (`/usr/bin/env: 'node': No such file or directory`). Версия 18 из репозитория Ubuntu 24.04 подходит.

Признак успеха: команда завершилась с кодом 0, а `git --version`, `python3 --version`, `tmux -V` и `node --version` печатают версии, `command -v crontab` находит программу. У `crontab` нет флага `-V`, на `crontab -V` он печатает справку с ошибкой: это нормально.

### Шаг 2. Каталог для программ и PATH

Команды:

`mkdir -p "$HOME/.local/bin"`

`echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"`

`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`

Последняя команда действует только в текущем шелле. Rig записывает PATH в cron в момент установки, поэтому `rig install` (шаг 6) запускай из шелла, где `claude`, `bun` и `~/.local/bin` уже находятся в PATH.

Признак успеха: `command -v claude` печатает путь к `claude`. Если не печатает, Claude Code не установлен или лежит вне PATH: вернись к шагу 4 человека.

### Шаг 3. Bun

Bun нужен до `rig`: `rig` запускается как `bun run …/src/cli.ts`. Установка:

`curl -fsSL https://bun.com/install | bash`

Установщик кладёт Bun в `~/.bun/bin`. Зависимости rig ставить не нужно: у него нет npm-пакетов.

Признак успеха: `bun --version` печатает версию.

### Шаг 4. Клон rig

`git clone https://github.com/OcelotJungle/agent-rig.git "$HOME/.agent-rig/repo"`

Признак успеха: существует файл `~/.agent-rig/repo/src/cli.ts`.

### Шаг 5. Клон хаба

Хаб клонируй до `rig install`: rig подключает плагин `telegram-hub` из этого каталога.

`git clone https://github.com/OcelotJungle/claude-telegram-hub.git "$HOME/.agent-rig/hub"`

Признак успеха: существует каталог `~/.agent-rig/hub/.git`.

### Шаг 6. Установка rig

Команда `rig` ещё не существует, поэтому в первый раз запускай через Bun:

`bun run "$HOME/.agent-rig/repo/src/cli.ts" install`

Что делает команда: применяет фичи, включённые по умолчанию, ставит недостающие программы (Codex через `bun add --global @openai/codex`, rtk из релиза GitHub в `~/.local/bin`), ставит плагины Claude Code, создаёт команду `~/.local/bin/rig` и две записи в crontab. Если в `~/.claude/settings.json` нет ключа `autoUpdatesChannel`, записывает в него `stable`. `rig install` сам `rig check` не запускает.

Если каких-то системных пакетов не хватает, команда печатает строки вида `Установи системный пакет <имя>: <команда>`. Выполни эти команды и запусти `rig install` ещё раз: установка повторяема.

Если нет `crontab`, команда пишет «Не найдена программа crontab. Установи пакет командой: sudo apt-get install cron». Установи пакет и запусти установку снова. К этому моменту команда `rig` уже создана.

Признак успеха: последняя строка вывода «Установка rig на сервере завершена.», код выхода 0. Проверь также `command -v rig` (должен найтись `~/.local/bin/rig`) и `crontab -l`: в нём две строки с метками `# agent-rig-update-hourly` и `# agent-rig-update-pending`.

### Шаг 7. Настройка хаба и служба systemd

Порядок важен: сначала файлы с токеном и конфигом, потом служба. Токен бота и Telegram ID вводит человек, в терминале. Ты их не просишь, не печатаешь и не читаешь файл `.env` обратно. Все файлы хаба лежат в `~/.claude/channels/telegram-hub/`. Команды берутся из README хаба (`~/.agent-rig/hub/README.md`), только путь клона здесь `~/.agent-rig/hub`, а не `~/claude-telegram-hub`.

**7.1. Каталог.** Выполни сам: `mkdir -p "$HOME/.claude/channels/telegram-hub"`. Зависимости хаба вручную ставить не нужно: служба перед каждым запуском сама выполняет `bun install --frozen-lockfile`.

**7.2. Токен (делает человек).** Скажи человеку: «Выполни в терминале эту команду. Она спросит токен, который ты получил от @BotFather; при вводе он не виден и не попадает в историю шелла. Потом напиши мне, что готово». Команда:

`( umask 077; read -rs -p "Токен бота: " T; printf 'TELEGRAM_BOT_TOKEN=%s\n' "$T" > "$HOME/.claude/channels/telegram-hub/.env" )`

Формат файла по README хаба: одна строка `TELEGRAM_BOT_TOKEN=<токен>` в `~/.claude/channels/telegram-hub/.env`. README не требует особых прав на файл; `umask 077` в команде лишь оставляет его читаемым только владельцу. Признак успеха: `test -s "$HOME/.claude/channels/telegram-hub/.env"` (файл есть и не пустой). Содержимое не читай.

**7.3. Telegram ID (делает человек).** Скажи человеку выполнить и сообщить, что готово:

`python3 -c 'import json,os;p=os.path.expanduser("~/.claude/channels/telegram-hub/config.json");json.dump({"allowFrom":[input("Telegram ID: ")]},open(p,"w"),indent=2)'`

Так создаётся `config.json` с ключом `allowFrom` (писать боту смогут только эти ID). Предупреди человека: попасть в `allowFrom` значит получить shell на сервере (`/bash` выполняет любую команду). Признак успеха: `test -s "$HOME/.claude/channels/telegram-hub/config.json"`.

**7.4. Запуск сессий из темы (делаешь ты).** Добавь в `config.json` секцию `launch`. Это обычный Claude; хаб сам подставляет `{session}`, `{cwd}` и `{mode}`. Команда вносит правку, не печатая файл:

`python3 -c 'import json,os;p=os.path.expanduser("~/.claude/channels/telegram-hub/config.json");c=json.load(open(p));c["launch"]={"command":["tmux","new-session","-d","-s","claude-{session}","-c","{cwd}","--","claude","--dangerously-load-development-channels","plugin:telegram-hub@telegram-hub","--resume","{session}","{mode}"],"timeoutSec":90};json.dump(c,open(p,"w"),indent=2)'`

Часть имени плагина после `@` (`telegram-hub`) должна совпадать с `name` в `~/.agent-rig/hub/.claude-plugin/marketplace.json`. Проверка: `grep -m1 '"name"' ~/.agent-rig/hub/.claude-plugin/marketplace.json` печатает `"name": "telegram-hub"`. Если имя другое, подставь его в команду вместо `telegram-hub`.

**7.5. Служба.** Из каталога хаба:

`cd "$HOME/.agent-rig/hub" && bash scripts/install-hub-service.sh`

Скрипт сам включает linger (`loginctl enable-linger`), ждёт до 30 секунд пользовательскую шину systemd, пишет файл `telegram-hub.service`, включает и запускает службу и создаёт `~/.claude/channels/telegram-hub/service-managed`. В юните уже прописан PATH с `~/.local/bin` и `~/.bun/bin`, поэтому `bun`, `claude` и `rig` хабу доступны; `tmux` берётся из `/usr/bin`. Если скрипт печатает `the user systemd bus did not appear in 30s`, установи `sudo apt-get install -y dbus-user-session`, перелогинься по SSH и запусти скрипт снова. Если политика сервера не даёт включить linger, администратор выполняет `sudo loginctl enable-linger "$(id -un)"`; проверка: `loginctl show-user "$USER" -p Linger` печатает `Linger=yes`.

Признаки успеха: `systemctl --user is-active telegram-hub.service` печатает `active`, а в `~/.claude/channels/telegram-hub/hub.log` есть строка `polling Telegram as @имя_бота` (`grep -q "polling Telegram as" ~/.claude/channels/telegram-hub/hub.log`). Если вместо неё `no TELEGRAM_BOT_TOKEN` или `bot token rejected`, токен введён неверно: попроси человека повторить 7.2 и выполни `systemctl --user restart telegram-hub.service`. Если `getMe failed (Unable to connect...)`, с сервера не открывается `api.telegram.org`. Если `getUpdates 409 Conflict`, тем же ботом пользуется кто-то ещё, обычно официальный плагин telegram. Диагностика: `journalctl --user -u telegram-hub.service -n 50`.

**7.6. groupId (делает человек).** Попроси человека написать любое сообщение в супергруппе. Тогда в `hub.log` появится строка `ignored update from chat -100… (supergroup "…")`. Покажи человеку команду `grep "ignored update from chat" ~/.claude/channels/telegram-hub/hub.log | tail -1`; число с минусом после `chat` и есть `groupId`. Человек вносит его сам:

`python3 -c 'import json,os;p=os.path.expanduser("~/.claude/channels/telegram-hub/config.json");c=json.load(open(p));c["groupId"]=input("groupId: ");json.dump(c,open(p,"w"),indent=2)'`

Хаб перечитывает `config.json` на каждом сообщении, перезапускать службу не нужно. Если в логе строк `ignored update` нет совсем, Telegram не отдаёт боту сообщения группы: бот должен быть администратором группы (либо в @BotFather `/setprivacy` → бот → `Disable`, потом удалить бота из группы и добавить заново). Если в логе `delivery to session … is blocked`, у бота нет прав писать в группу или в `config.json` не тот `groupId`.

**7.7. Подтверждение канала (делает человек).** С флагом `--dangerously-load-development-channels` Claude Code может спросить подтверждение канала прямо в tmux. Спрашивает ли он только при первом запуске или при каждом, на Linux не проверено. Предупреди об этом человека: считай, что вопрос может появляться у каждой новой сессии.

Хаб запускает сессию в отсоединённом tmux, поэтому на вопрос там некому ответить, и пока ответа нет, сессия к хабу не подключается. Хаб сообщает об этом сам:
- если сессия не подключилась за `timeoutSec` (в шаге 7.4 это 90 секунд), тема пишет, что сессия, возможно, ждёт подтверждения в tmux, и называет команду подключения;
- если такая tmux-сессия уже жива, тема сразу просит подключиться к ней.

Человек подключается командой из темы и отвечает на вопрос сам:

`tmux attach -t claude-<id сессии>`

Вопрос можно убрать совсем, но это настройка всей машины: файл действует на всех пользователей и все запуски Claude Code на сервере и правится только с правами root. Спроси человека, нужно ли это. Если да, он выполняет две команды сам. Первая создаёт каталог, вторая отказывается работать, если файл уже есть (тогда человек дописывает две настройки в него вручную):

`sudo mkdir -p /etc/claude-code`

`sudo test ! -e /etc/claude-code/managed-settings.json && printf '%s\n' '{"channelsEnabled":true,"allowedChannelPlugins":[{"plugin":"telegram-hub","marketplace":"telegram-hub"}]}' | sudo tee /etc/claude-code/managed-settings.json > /dev/null`

После этого замени в `launch` флаг `--dangerously-load-development-channels` на `--channels`. Сделай это сам, команда не печатает файл:

`python3 -c 'import json,os;p=os.path.expanduser("~/.claude/channels/telegram-hub/config.json");c=json.load(open(p));c["launch"]["command"]=["--channels" if a=="--dangerously-load-development-channels" else a for a in c["launch"]["command"]];json.dump(c,open(p,"w"),indent=2)'`

Значение `marketplace` в файле должно совпадать с именем из проверки в шаге 7.4. Признак успеха: `grep -c -- '"--channels"' ~/.claude/channels/telegram-hub/config.json` печатает `1`, а новая сессия подключается к хабу без подключения к tmux.

Итоговый признак успеха шага: `systemctl --user is-active telegram-hub.service` печатает `active`.

### Шаг 8. Проверка

`rig check`

Запускай только после шага 7: пока службы `telegram-hub` нет, `rig check` печатает «Служба telegram-hub не запущена.» и завершается кодом 1. Это не ошибка установки rig, а недостающий шаг 7.

Что проверяет: блок rig в `~/.codex/AGENTS.md`, файл `~/.agent-rig/generated/CLAUDE.md`, обе строки импорта в `~/.claude/CLAUDE.md`, разбор `~/.claude/settings.json`, наличие python и программ включённых фич (в том числе `git`, а на Linux `cron` и `tmux`), запуск каждого хука с тестовым событием (код выхода должен быть 0) и работу службы `telegram-hub`, если фича `telegram` включена.

Признак успеха: последняя строка «Проверки rig пройдены.» и код выхода 0.

### Шаг 9. Состояние

`rig status`

Признак успеха: есть строка `Режим: server`, у `agent-rig:` и `hub:` стоят хеши коммитов, а не «неизвестно», а у фич статус `включена` или `выключена`. Строки `Ошибка …` в конце означают ошибки из `~/.agent-rig/events.jsonl`, записанные после последнего успешного обновления; более старые остаются только в файле.

### Шаг 10. Вход в Codex (делает человек)

Агент просит человека выполнить в терминале одну команду. Вход делает человек, ссылку и код агент не обрабатывает:

`codex login --device-auth`

Команда печатает адрес `https://auth.openai.com/codex/device` и код для входа в браузере. Нужен `node` (шаг 1). Если у тебя другая версия Codex и флаг не принимается, выполни `codex login --help` и выбери вариант входа без локального браузера.

Признак успеха: `codex login status` сообщает, что вход выполнен, код выхода 0. Без входа он печатает «Not logged in» и завершается кодом 1.

## Если шаг не удался

Системный пакет отсутствует. Проявляется строкой `Установи системный пакет <имя>: <команда>` при `rig install` или `rig feature <имя> enable`, а в `rig check` строкой «Не найден системный пакет <имя>. Выполни: <команда>». Выполни указанную команду и повтори шаг.

Программа не найдена. `rig check` пишет «Не найдена программа <имя>; выполни rig install.». Запусти `rig install` ещё раз.

Все проблемы `rig check` печатает списком по одной в строке, не только первую. Исправь все, запусти `rig check` заново.

Хук завершился с ошибкой. Строка «Хук <фича>/<событие> завершился с кодом …». Проверь, что `python3` и `bash` доступны в PATH.

«Служба telegram-hub не запущена.» Это ожидаемо, пока не сделан шаг 7 (`rig install` проверку не запускает, службу ставит только шаг 7). Если шаг сделан, смотри `systemctl --user status telegram-hub.service`, `journalctl --user -u telegram-hub.service -n 50` и `~/.claude/channels/telegram-hub/hub.log`; разбор строк журнала (`no TELEGRAM_BOT_TOKEN`, `bot token rejected` и другие) дан в шаге 7.5.

Ошибка rig. Любая ошибка печатается как «Ошибка rig: …», код выхода 1.

Где лог и события:

- журнал cron-обновлений: `~/.agent-rig/update.log`;
- события rig (обновления, откаты, смена фич, ошибки): `~/.agent-rig/events.jsonl`;
- состояние: `~/.agent-rig/state.json`.

Обновление пропускается, если в одном из клонов есть локальные изменения или локальные коммиты, либо клон не на `main` (`git -C ~/.agent-rig/repo status`, то же для `~/.agent-rig/hub`); клон при этом не трогается. Если хаб после обновления не сообщил о готовности, rig откатывает оба клона через 5-10 минут после его перезапуска (предел 5 минут, проверка идёт по cron раз в 5 минут). После неудачной проверки rig откатывает оба клона на прошлую пару коммитов и запоминает неудачную пару, чтобы не повторять её.

## Установка закончена, если

1. `rig check` печатает «Проверки rig пройдены.» с кодом выхода 0.
2. `rig status` показывает `Режим: server` и известные коммиты у `agent-rig` и `hub`.
3. `crontab -l` содержит записи `# agent-rig-update-hourly` и `# agent-rig-update-pending`.
4. `systemctl --user is-active telegram-hub.service` печатает `active`.
5. Человек выполнил вход в Codex (шаг 10).

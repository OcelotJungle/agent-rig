- Промпт: строки `model:`, `effort:`, `mode: write` или `mode: read-only`, `approved: no`, `cwd: <абсолютный путь>`,
  затем `task:` и самодостаточное задание с критериями готовности. Продолжить сессию: `reply: <job>` + `task:`;
  подключиться после падения воркера: `attach: <job>`. Остановить: `{{PYTHON}} -I "{{CLONE}}/features/codex/tools/codex-run.py" cancel <job>`;
  список: `… list`.

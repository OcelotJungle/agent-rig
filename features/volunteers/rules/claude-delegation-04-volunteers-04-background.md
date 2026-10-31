- `volunteer` всегда в фоне; `description` — только суть задачи. Промпт: `mode: write` или `mode: read-only`,
  `cwd: <абсолютный путь>`, затем `task:` и самодостаточное задание с критериями готовности; модель не выбирается.
  Продолжить: `reply: <job>` + `task:`; подключиться: `attach: <job>`; остановить:
  `{{PYTHON}} -I "{{CLONE}}/features/volunteers/tools/volunteer-run.py" cancel <job>`.

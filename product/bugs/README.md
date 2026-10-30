# Баги PR Reviewer

Ведёт qa. Один баг — один файл. Код правит только dev; продуктовые вопросы («так задумано, но не нравится») — к PM, визуальные (вёрстка, цвета, тексты) — с designer.

## Нумерация

`BUG-NNN-короткое-имя.md`: номер — следующий за самым большим в папке, три цифры с ведущими нулями; имя — 2–4 слова латиницей через дефис (`BUG-001-badge-stale-after-resolve.md`). Номера не переиспользуются, даже если баг отклонён.

## Статусы

`новый` → `передан dev` → `исправлен (ждёт проверки)` → `закрыт` / `возвращён` (снова к dev с комментарием) / `не баг` (задуманное поведение, передано PM) / `не воспроизводится`.

Статус меняет qa. История смены — в разделе «История» в конце отчёта.

## Серьёзность

- **S1 — критично**: публикует неверное в Bitbucket, теряет или портит данные (`state.json`, память, бэклог, ветка PR), сервис встал.
- **S2 — серьёзно**: функция не работает или врёт (неверные бейджи, статистика, уведомления), обходного пути нет.
- **S3 — средне**: работает неправильно, но есть обход или последствия малы.
- **S4 — мелочь**: текст, вёрстка, косметика.

## Реестр

| № | Суть | Сер. | Статус |
|---|---|---|---|
| [BUG-001](BUG-001-own-threads-recheck-same-head.md) | Повторная платная проверка своих тредов на той же голове | S3 | передан dev |
| [BUG-002](BUG-002-broken-memory-paid-learn-loop.md) | Битая память — платный запуск модели памяти каждый проход | S3 | передан dev |
| [BUG-003](BUG-003-arch-show-stale-after-failed-rerun.md) | `arch show` молча показывает старый отчёт после ошибки | S4 | передан dev |
| [BUG-004](BUG-004-memory-agent-rejected-by-schema.md) | `memory.agent` запрещён схемой конфига | S3 | передан dev |
| [BUG-005](BUG-005-stop-leaves-queued-requests.md) | «Прервать» оставляет заявки в очереди | S3 | передан dev |
| [BUG-006](BUG-006-stop-delayed-during-sync-steps.md) | «Прервать» не срабатывает на синхронных шагах | S3 | передан dev |
| [BUG-007](BUG-007-aborted-qa-plan-shown-as-run-failed.md) | Прерванный план — «Прогон не удался» | S4 | передан dev |
| [BUG-008](BUG-008-codex-cursor-limits-stale.md) | Лимиты Codex и Cursor не обновляются | S3 | передан dev |
| [BUG-009](BUG-009-codex-short-window-labeled-week.md) | Короткое окно Codex подписано как неделя | S4 | передан dev |
| [BUG-010](BUG-010-outdated-ui-and-prompt-texts.md) | Устаревшие тексты в окне и промпте памяти | S4 | передан dev |
| [BUG-011](BUG-011-token-issue-command-claude-only.md) | `claude setup-token` для любой модели кроме Cursor | S4 | передан dev |
| [BUG-012](BUG-012-log-expanded-entry-jumps.md) | В журнале раскрытая запись перескакивает | S4 | передан dev |
| [BUG-013](BUG-013-stats-cost-per-addressed-understated.md) | Цена за исправленное занижена в `stats` | S4 | передан dev |
| [BUG-014](BUG-014-remerge-loses-lesson-usage.md) | Повторная склейка теряет срабатывания правил | S4 | передан dev |

## Шаблон

```markdown
# BUG-NNN: <суть одной строкой>

- **Статус:** новый
- **Серьёзность:** S1 | S2 | S3 | S4
- **Компонент:** CLI (`src/…`) | окно (`menubar/…`) | launchd | конфиг
- **Заведён:** ГГГГ-ММ-ДД, qa
- **Источник:** сообщение пользователя / найдено при проверке

## Описание

Что не так, в одном-двух абзацах. Почему это баг, а не задуманное поведение (ссылка на README или код).

## Окружение

- Приложение: дата сборки `~/Applications/PR Reviewer.app/Contents/MacOS/PRReviewer`
- Сервис: пауза да/нет, `bin/pr-reviewer status`
- Репозиторий, PR, модель — если относится
- macOS, Node (`node -v`)

## Шаги воспроизведения

1. …
2. …

## Фактический результат

…

## Ожидаемый результат

…

## Логи и доказательства

Выдержки из `~/Library/Logs/pr-reviewer/worker.log`, файлов состояния, вывод команд, скриншоты (файлы рядом: `BUG-NNN-*.png`).

## Предполагаемое место в коде

- `src/…:строка` — почему здесь

## История

- ГГГГ-ММ-ДД — заведён (qa)
```

## Как воспроизводить безопасно

Сервис живой: launchd будит `run --scheduled` раз в минуту и публикует в Bitbucket. Без явного разрешения пользователя qa не запускает ничего, что публикует комментарии, меняет `config.json`, ветки PR или установленные launchd-агенты и приложение.

**Только чтение — можно:**

- файлы: `~/Library/Application Support/pr-reviewer/` (`state.json`, `status.json`, `*.jsonl`, `prs/`, `queue/`, `arch/`, `qa/`, `memory/`, `backlog.json`), лог `~/Library/Logs/pr-reviewer/worker.log`, `config.json`, клоны в `~/.pr-reviewer/` (только `git log/show/diff`);
- команды: `status`, `stats`, `backlog list|export`, `arch show|list`, `qa show|list`, `memory list|history`, `memory review <slug> --show`, `ignore list`, `help`;
- `launchctl print gui/$(id -u)/com.avoronin.pr-reviewer` — состояние агента.

**Пишут в служебные файлы, но не наружу — можно, если нужно для воспроизведения:** `sync` (только GET к Bitbucket, перезаписывает `prs/`), `limits` (`limits.json`), `agent models cursor` (`cursor-models.json`).

**Изолированная копия данных.** И CLI, и окно берут каталог данных из `HOME`, поэтому баги состояния можно гонять на копии: скопировать `~/Library/Application Support/pr-reviewer` в `<scratch>/home/Library/Application Support/` и запускать `HOME=<scratch>/home bin/pr-reviewer …`. Не изолируются: `config.json` (лежит рядом с кодом), Keychain и Bitbucket — команды с записью в них и так запускать нельзя.

**Только с разрешения пользователя:**

- `run` без `--dry-run`, `run-now`, `review`, `fix`, `arch`, `qa plan|run|save`, `memory learn|review|apply|restore`, `backlog learn|triage|filed|drop|reopen|close-stale` — публикуют, тратят лимиты моделей или меняют данные;
- `run --dry-run`: в Bitbucket не пишет, но запускает модели (тратит лимиты), берёт `worker.pid` (фоновый проход в это время пропускается), делает `git fetch` в клонах и может переписать `config.json` (`pruneMissingSources` убирает отсутствующие `source`);
- `repo list|add|…`, `pause|resume`, `interval`, `branches`, `agent set`, `token`, `ignore add|remove` — меняют `config.json` или паузу сервиса (`repo list` тоже может переписать конфиг через `pruneMissingSources`);
- `stop`, `fix stop`, `arch stop`, `qa stop` — прерывают чужую работу;
- `install.sh`, `uninstall.sh`, `launchctl bootout|bootstrap|kickstart`, пересборка приложения.

**Проверка исправления в окне.** Установленное приложение собирается `install.sh` из `menubar/*.swift` и не обновляется само: если правка dev в Swift, перед перепроверкой сверить дату сборки бинаря с датой правки и попросить пользователя переустановить (или получить его разрешение на `./install.sh`).

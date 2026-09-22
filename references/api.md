# Redmine REST API — что нужно знать при доработке скрипта

Аутентификация — заголовок `X-Redmine-API-Key: <ключ>`. Ключ даёт ровно те права, что есть у его владельца; отказ `403` — про человека, а не про способ вызова.

## Эндпоинты, которые использует CLI

| Задача | Метод и путь | Примечания |
|---|---|---|
| Кто я | `GET /users/current.json` | Даёт числовой `id` — им фильтруются time_entries |
| Виды деятельности | `GET /enumerations/time_entry_activities.json` | Набор свой у каждого инстанса |
| Статусы | `GET /issue_statuses.json` | |
| Проекты | `GET /projects.json` | `project_id` принимает и число, и `identifier` |
| Задача | `GET /issues/:id.json?include=journals,relations` | `journals` доступны только для одной задачи, не для списка |
| Список задач | `GET /issues.json` | фильтры ниже |
| Поиск | `GET /search.json?q=...&issues=1` | или `/projects/:id/search.json` |
| Изменение задачи | `PUT /issues/:id.json` `{issue:{status_id,done_ratio,notes,assigned_to_id,due_date}}` | отвечает `204` без тела |
| Списание часов | `POST /time_entries.json` `{time_entry:{issue_id|project_id,hours,spent_on,activity_id,comments}}` | `201` + созданная запись |
| Список списаний | `GET /time_entries.json?user_id=&from=&to=` | |
| Правка/удаление | `PUT|DELETE /time_entries/:id.json` | `204` без тела |

## Фильтры задач

- `assigned_to_id=me` (или числовой id), `author_id=me`, `watcher_id=me`.
- `status_id=open|closed|*` либо конкретный id.
- Операторы в значениях: `updated_on=>=2026-09-01T00:00:00Z`, `due_date=<=2026-10-01`, `subject=~текст`.
- `sort=updated_on:desc`, `due_date:asc`.
- Пагинация: `limit` (максимум 100) + `offset`; в ответе `total_count`.

## Ловушки

1. **`include=journals` не работает для списка.** Чтобы увидеть комментарии, нужен запрос по каждой задаче отдельно — CLI делает это с ограничением в 5 параллельных запросов (`mapLimit`).
2. **`journals` содержат и комментарии, и изменения полей.** Комментарий — непустой `notes`; изменение — элементы `details` (`{property, name, old_value, new_value}`). Назначение на себя распознаётся как `name === "assigned_to_id" && new_value === <мой id>`.
3. **`private_notes: true`** — приватный комментарий, виден не всем; при пересказе в чат это стоит учитывать.
4. **`user_id=me` в `/time_entries.json`** поддерживается не всеми версиями — CLI подставляет числовой id из `users/current.json`.
5. **`activity_id` обязателен**, если в настройках Redmine у вида деятельности нет значения по умолчанию. Отсюда `defaultActivity` в конфиге.
6. **`spent_on` — только дата** (`YYYY-MM-DD`), без времени. Часы — десятичное число (`1.5`), Redmine округляет до сотых.
7. **Списание за другого** (`user_id` в теле) требует права *Log spent time for another user*; по умолчанию CLI этого не делает.
8. **`404` на любом запросе** — обычно не «нет объекта», а выключенный REST API в настройках инстанса.
9. **Часовые пояса.** `created_on`/`updated_on` приходят в UTC (`...Z`), а `spent_on` — локальная дата инстанса. Сравнивать их напрямую нельзя: CLI держит границу «что нового» в ISO-UTC, а даты списаний — в локальном формате.
10. **Веса ответа.** `include=journals` на задаче с длинной историей возвращает сотни килобайт; в сводках печатаются только события новее отметки.

## Файлы состояния

- `~/.redmine/config.json` — профили инстансов (URL, ключ, вид деятельности по умолчанию, норма часов, алиасы проектов).
- `~/.redmine/cache.json` — кэш справочников, TTL 24 часа, ключи вида `<инстанс>:activities`.
- `~/.redmine/state.json` — `{"<инстанс>": {"lastSeen": "<ISO>"}}`, отметка «просмотрено» для `inbox --mark`.

## Проверка типов

Скрипт пишется под `strict` + `noUncheckedIndexedAccess`, без зависимостей. Проверка:

```bash
mkdir -p /tmp/tscheck && cd /tmp/tscheck && cp ~/.claude/skills/redmine-time/scripts/redmine.ts .
bun add -d typescript bun-types
./node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --target esnext --module esnext --moduleResolution bundler --types bun-types --skipLibCheck redmine.ts
```

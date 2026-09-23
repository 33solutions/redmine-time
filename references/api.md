# Redmine REST API — что нужно знать при доработке скрипта

Аутентификация — заголовок `X-Redmine-API-Key: <ключ>`. Ключ даёт ровно те права, что есть у его владельца; отказ `403` — про человека, а не про способ вызова.

## Эндпоинты, которые использует CLI

| Задача | Метод и путь | Примечания |
|---|---|---|
| Кто я | `GET /users/current.json` | Даёт числовой `id` — им фильтруются time_entries |
| Виды деятельности | `GET /enumerations/time_entry_activities.json` | Набор свой у каждого инстанса |
| Статусы | `GET /issue_statuses.json` | |
| Проекты | `GET /projects.json` | `project_id` принимает и число, и `identifier` |
| Создать проект | `POST /projects.json` `{project:{name, identifier, parent_id, is_public, inherit_members, …}}` | `201`; создателя-не-администратора Redmine сразу делает участником с ролью из настройки «роль создателя проекта» (`new_project_user_role_id`); в проекте, созданном администратором, участников нет, кроме унаследованных при `inherit_members` |
| Задача | `GET /issues/:id.json?include=journals,relations` | `journals` доступны только для одной задачи, не для списка |
| Список задач | `GET /issues.json` | фильтры ниже |
| Поиск | `GET /search.json?q=...&issues=1` | или `/projects/:id/search.json` |
| Изменение задачи | `PUT /issues/:id.json` `{issue:{status_id,done_ratio,notes,assigned_to_id,due_date}}` | отвечает `204` без тела |
| Списание часов | `POST /time_entries.json` `{time_entry:{issue_id|project_id,hours,spent_on,activity_id,comments}}` | `201` + созданная запись |
| Список списаний | `GET /time_entries.json?user_id=&from=&to=` | |
| Правка/удаление | `PUT|DELETE /time_entries/:id.json` | `204` без тела |
| Участники проекта | `GET /projects/:id/memberships.json` | постранично (`limit` ≤ 100, `offset`, `total_count`); элемент — `{id, project, user|group, roles:[{id, name, inherited?}]}` |
| Одно членство | `GET /memberships/:id.json` | `{membership:{…}}` того же вида |
| Добавить участника | `POST /projects/:id/memberships.json` `{membership:{user_id, role_ids:[…]}}` | `user_id` — пользователь **или группа**; `201` + членство |
| Сменить роли | `PUT /memberships/:id.json` `{membership:{role_ids:[…]}}` | заменяет собственные роли целиком, унаследованные не трогает; `204` без тела |
| Убрать участника | `DELETE /memberships/:id.json` | `204`; при любой унаследованной роли — `422` без текста |
| Роли | `GET /roles.json` → `GET /roles/:id.json` | список отдаётся любому ключу, но только `id` и `name`; права (`permissions`), `issues_visibility`, `time_entries_visibility`, `assignable` — только в карточке роли |
| Пользователи | `GET /users.json?name=` · `GET /users/:id.json` | справочник — только администратору (`403`); карточка — если пользователь «виден» ключу, иначе `404` |

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
11. **Роли, которые ключу не разрешено назначать, отбрасываются молча.** У права «Управление участниками» есть ограничение «только эти роли»: `POST` и `PUT` оставляют из `role_ids` только разрешённые (а неразрешённые, уже назначенные, не снимают) и отвечают успехом. Если не легла ни одна — `422` «Роль не может быть пустым». Поэтому после записи CLI перечитывает членство и сверяет роли с запрошенными.
12. **Унаследованные роли** (`inherited: true`) приходят от группы, в которой состоит пользователь, или от родительского проекта при наследовании участников. `PUT` их не трогает, `DELETE` при наличии хотя бы одной отвечает `422` без тела. Одна и та же роль приходит по разу от каждой группы — в выводе её надо схлопывать.
13. **Одно членство на участника в проекте.** Повторный `POST` — `422` «уже существует». Пользователь, состоящий в проекте только через группу, членство уже имеет: собственные роли ему задают `PUT`.
14. **Людей по имени ищем среди участников видимых проектов.** `/users.json` — только администратору; карточка `/users/:id.json` без прав администратора часто закрыта (`404`). Справочник людей CLI держит только в памяти на один запуск и на диск не пишет.

## Файлы состояния

- `~/.redmine/config.json` — профили инстансов (URL, ключ, вид деятельности по умолчанию, норма часов, алиасы проектов).
- `~/.redmine/cache.json` — кэш справочников, TTL 24 часа, ключи вида `<инстанс>:activities`, `<инстанс>:roles` (роли вместе с правами).
- `~/.redmine/state.json` — `{"<инстанс>": {"lastSeen": "<ISO>"}}`, отметка «просмотрено» для `inbox --mark`.

## Проверка типов

Скрипт пишется под `strict` + `noUncheckedIndexedAccess`, без зависимостей. Проверка:

```bash
mkdir -p /tmp/tscheck && cd /tmp/tscheck && cp ~/.claude/skills/redmine-time/scripts/redmine.ts .
bun add -d typescript bun-types
./node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --target esnext --module esnext --moduleResolution bundler --types bun-types --skipLibCheck redmine.ts
```

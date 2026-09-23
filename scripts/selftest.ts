#!/usr/bin/env bun
/**
 * Самопроверка скилла без обращения к Redmine: разбор ввода и правила проверки текстов.
 * Запуск: bun scripts/selftest.ts — код возврата 1, если хоть один случай не прошёл.
 */

import { parseHours, parseDate, parsePeriod, plain } from "./redmine.ts";
import { scanText, guard } from "./guard.ts";
import { buildSessions, buildGroups, plural, draftDescription, type Commit } from "./harvest.ts";
import { categorize, monthsSince } from "./redmine.ts";
import { translit, slugIdentifier, identifierProblem } from "./redmine.ts";
import { parseFieldSpec, assignProjectFields, type ProjectField } from "./redmine.ts";
import { dayTotals, loadWarnings, reconcileHours } from "./redmine.ts";
import {
  parseRelationType,
  invertRelationType,
  asRelationType,
  delayApplies,
  describeRelation,
  explainRelationRejection,
  parseIssueRef,
  findCrossInstanceRefs,
  formatXref,
  xrefLabel,
} from "./redmine.ts";
import {
  parseArgs,
  readAddMember,
  readUpdateMember,
  readRemoveMember,
  describeRole,
  resolveRoles,
  matchPeople,
  pickPerson,
  accountSeen,
  findMembership,
  ownRoles,
  inheritedRoles,
  describeMemberRoles,
  addMemberRequest,
  updateMemberRequest,
  removeMemberRequest,
  explainMembershipRejection,
  explainMemberForbidden,
  checkMemberRoles,
  roleCheckText,
  projectTitle,
  addMemberPreview,
  updateMemberPreview,
  removeMemberPreview,
  CLIENT_NOTICE,
  SEPARATE_CONFIRMATION,
  type RoleInfo,
  type PersonCandidate,
  type Membership,
  type MemberProject,
  type Principal,
} from "./redmine.ts";
import { planBaseDir, planTextPath } from "./redmine.ts";
import { posix, win32 } from "node:path";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}: ожидалось ${e}, получено ${a}`);
}

function checkThrows(name: string, fn: () => unknown): void {
  try {
    fn();
    failures.push(`${name}: ожидалась ошибка, её не было`);
  } catch {
    passed++;
  }
}

// ── часы ──────────────────────────────────────────────────────────────
check("часы: целое", parseHours("2"), 2);
check("часы: дробное через точку", parseHours("2.5"), 2.5);
check("часы: дробное через запятую", parseHours("2,5"), 2.5);
check("часы: 1h30", parseHours("1h30"), 1.5);
check("часы: 1:30", parseHours("1:30"), 1.5);
check("часы: 90m", parseHours("90m"), 1.5);
check("часы: по-русски", parseHours("1 ч 30 мин"), 1.5);
check("часы: только минуты", parseHours("45м"), 0.75);
checkThrows("часы: мусор", () => parseHours("abc"));
checkThrows("часы: ноль", () => parseHours("0"));

// ── даты ──────────────────────────────────────────────────────────────
const today = new Date();
const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (days: number): string => {
  const c = new Date(today);
  c.setDate(c.getDate() + days);
  return iso(c);
};

check("дата: today", parseDate("today"), iso(today));
check("дата: сегодня", parseDate("сегодня"), iso(today));
check("дата: yesterday", parseDate("yesterday"), shift(-1));
check("дата: -3", parseDate("-3"), shift(-3));
check("дата: +7", parseDate("+7"), shift(7));
check("дата: ISO", parseDate("2026-09-01"), "2026-09-01");
check("дата: DD.MM.YYYY", parseDate("18.09.2025"), "2025-09-18");
check("дата: DD.MM.YY", parseDate("18.09.25"), "2025-09-18");
checkThrows("дата: мусор", () => parseDate("позавчера утром"));

// ── периоды ───────────────────────────────────────────────────────────
check("период: месяц по номеру", parsePeriod("2026-09"), ["2026-09-01", "2026-09-30"]);
check("период: февраль високосного", parsePeriod("2024-02"), ["2024-02-01", "2024-02-29"]);
check("период: диапазон", parsePeriod("2026-09-01..2026-09-15"), ["2026-09-01", "2026-09-15"]);
check("период: один день", parsePeriod("2026-09-07"), ["2026-09-07", "2026-09-07"]);
check("период: диапазон месяцев", parsePeriod("2026-07..2026-09"), ["2026-07-01", "2026-09-30"]);
check("период: дата и месяц", parsePeriod("2026-07-15..2026-09"), ["2026-07-15", "2026-09-30"]);
check("период: месяц и дата", parsePeriod("2026-07..15.09.2026"), ["2026-07-01", "2026-09-15"]);
check("период: месяцы через год", parsePeriod("2025-12..2026-02"), ["2025-12-01", "2026-02-28"]);
checkThrows("период: тринадцатый месяц", () => parsePeriod("2026-13"));
checkThrows("период: нулевой месяц в диапазоне", () => parsePeriod("2026-00..2026-03"));

// ── очистка разметки ──────────────────────────────────────────────────
check("html: абзацы", plain("<p>Первый</p><p>Второй</p>"), "Первый\nВторой");
check("html: перенос строки", plain("Строка<br />вторая"), "Строка\nвторая");
check("html: сущности", plain("Ответ &mdash; &laquo;да&raquo;&nbsp;!"), "Ответ — «да» !");
check("html: списки", plain("<ul><li>раз</li><li>два</li></ul>"), "• раз\n• два");

// ── проверка текстов: должно блокировать ──────────────────────────────
const mustBlock: [string, string][] = [
  ["пароль в тексте", "Пароль от админки: Qwerty12345"],
  ["пароль с уточнением", "Логин и пароль для обмена: svc_exchange / Zx9!kLm2025"],
  ["токен GitHub", "Токен: ghp_AbCdEfGh1234567890XyZwVuTsRq"],
  ["ключ модели", "используем sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
  ["строка подключения", "mongodb://admin:P@ssw0rd123@db.example.com:27017/prod"],
  ["строка подключения 1С", 'Srvr="srv1";Ref="base";Usr="admin";Pwd="Secret123"'],
  ["приватный ключ", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"],
  ["JWT", "Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
  ["карта", "Оплата с карты 4111 1111 1111 1111"],
  ["СНИЛС", "СНИЛС сотрудника 112-233-445 95"],
  ["паспорт", "Паспорт 4515 123456 приложен"],
  ["внутренний IP для клиента", "Сервер обмена 192.168.10.7 недоступен"],
  ["самооговор", "Это наша вина, мы забыли включить регламентное задание"],
  ["обещание без условий", "Гарантирую, что к пятнице всё точно будет готово"],
  ["оценка людей", "Их программист криво выгрузил данные"],
  ["внутренняя экономика", "Себестоимость этих работ выше, чем мы выставили"],
];
for (const [name, text] of mustBlock) {
  const findings = scanText(text, { audience: "client" });
  const blocked = findings.some((f) => f.severity === "block");
  if (blocked) passed++;
  else failures.push(`проверка должна была остановить отправку — ${name}: "${text.slice(0, 60)}"`);
}

// ── проверка текстов: не должно блокировать ───────────────────────────
const mustPass: [string, string][] = [
  ["ссылка на хранилище", "Ключ доступа: см. менеджер секретов"],
  ["плейсхолдер в скобках", "Токен доступа: <выдаётся администратором>"],
  ["маска", "Пароль: ***"],
  ["ожидание выдачи", "Пароль от учётной записи обмена: запрошен у администратора"],
  ["обычный отчёт", "Реализован обмен: выгрузка заказов раз в 15 минут, приём статусов по вебхуку."],
  ["условный срок", "При доступе к контуру до 24.09 этап 2 закрывается 26.09."],
  ["числа без смысла карты", "Оформлено 4218 позиций номенклатуры за 2026 год"],
  ["публичный домен", "Документация на https://redmine.org/projects/redmine/wiki/Rest_api"],
  ["указание, где взять ключ", "Ключ доступа к API: Моя учётная запись → Ключ доступа к API"],
  ["ссылка на инструкцию", "Пароль: выдаётся администратором при первом входе"],
];
for (const [name, text] of mustPass) {
  const findings = scanText(text, { audience: "client" });
  const blocked = findings.filter((f) => f.severity === "block");
  if (blocked.length === 0) passed++;
  else failures.push(`ложное срабатывание — ${name}: ${blocked.map((f) => f.title).join(", ")}`);
}

// ── тексты об инцидентах: юридическая чистота ─────────────────────────
const incidentBlock: [string, string][] = [
  ["уведомление надзорного органа", "Уведомление надзорного органа подготовлено юристом"],
  ["регулятор", "Регулятора уведомили в тот же день"],
  ["GDPR", "Требования GDPR к срокам уведомления"],
  ["регламентный срок", "Регламентный срок — 72 часа с момента обнаружения"],
  ["срок подачи", "Срок подачи отчёта прошёл"],
  ["срок истёк", "Срок истёк ещё вчера"],
  ["истёк срок", "Истёк срок направления сведений"],
  ["персональные данные и утечка", "Утечка персональных данных покупателей"],
  ["персональные данные и инцидент", "Персональные данные затронуты инцидентом"],
  ["обязаны уведомить", "Мы обязаны уведомить об этом в течение суток"],
  ["должны были", "Мы должны были обновить компонент раньше"],
  ["по нашей вине", "Сбой произошёл по нашей вине"],
  ["по вине подрядчика", "По вине подрядчика сервис был недоступен"],
  ["наша ошибка", "Наша ошибка в конфигурации обмена"],
  ["мы не заметили", "Мы не заметили обновление безопасности"],
  ["мы упустили", "Мы упустили этот момент при настройке"],
  ["недосмотр", "Недосмотр при настройке резервного копирования"],
  ["халатность", "Халатное отношение к обновлениям"],
  ["подрядчик виноват", "Подрядчик виноват в простое"],
  ["прежние подрядчики", "Прежние подрядчики не настроили резервные копии"],
  ["прежний интегратор", "Прежний интегратор криво написал обмен"],
  ["некомпетентность", "Некомпетентность прежней команды очевидна"],
  ["номер уязвимости", "Закрыта CVE-2024-12345 в библиотеке"],
  ["эксплойт", "Использован эксплойт для загрузки файла"],
  ["инъекция", "SQL-инъекция в форме поиска"],
  ["веб-шелл", "Найден веб-шелл в каталоге загрузок"],
  ["бэкдор", "Обнаружен бэкдор в модуле оплаты"],
  ["обход авторизации", "Применён обход авторизации в личном кабинете"],
  ["самовосстанавливающаяся закладка", "Закладка, восстанавливающая себя после удаления файла"],
  ["форма записи адреса", "Через форму записи адреса удалось обойти проверку"],
  ["XSS", "Атака типа XSS в комментариях"],
  ["RCE", "Уязвимость RCE в библиотеке обработки изображений"],
  ["payload", "На сервер отправлен payload с командой"],
  ["данные не утекли", "Данные покупателей не утекли"],
  ["утечки не было", "Утечки данных не было"],
  ["данные не пострадали", "Данные не пострадали"],
  ["никто не получил доступ", "Никто не получил доступ к базе"],
];
for (const [name, text] of incidentBlock) {
  const findings = scanText(text, { audience: "client" });
  if (findings.some((f) => f.severity === "block")) passed++;
  else failures.push(`инцидент: проверка должна была остановить отправку — ${name}: "${text}"`);
}

// Узость правил: обычный текст про доставку, показатели и функции сайта проходит.
const incidentPass: [string, string][] = [
  ["доставка", "Ускорили доставку заказов до двух дней"],
  ["вставка", "Вставка блока рекомендаций на страницу товара"],
  ["заставка", "Заставка при загрузке приложения обновлена"],
  ["уведомление о регистрации", "Уведомление о регистрации приходит на почту покупателю"],
  ["стоимость обращения", "Стоимость обращения снизилась на 12%"],
  ["source не RCE", "Источник данных — файл source.csv"],
  ["resource не XSS", "Обновили resource-файлы интерфейса"],
  ["срок сдачи", "Срок сдачи этапа — 26.09"],
  ["организация не орган", "Организация складского учёта изменена"],
  ["органайзер не орган", "Настроена выгрузка органайзера задач"],
  ["наблюдение вместо утверждения", "Признаков доступа к данным покупателей не обнаружено"],
  ["наблюдение вместо вывода", "После обновления проблема не воспроизводится"],
  ["персональные данные без инцидента", "Персональные данные обрабатываются в карточке контрагента"],
  ["форма адреса без обхода", "Форма записи адреса доставки исправлена"],
  ["проверка прав", "Проверка прав пользователей работает штатно"],
];
for (const [name, text] of incidentPass) {
  const blocked = scanText(text, { audience: "client" }).filter((f) => f.severity === "block");
  if (blocked.length === 0) passed++;
  else failures.push(`инцидент: ложное срабатывание — ${name}: ${blocked.map((f) => `${f.title} (${f.excerpt})`).join(", ")}`);
}

check(
  "инцидент: внутри компании — только предупреждение",
  scanText("Сбой произошёл по нашей вине, регулятора уведомили", { audience: "internal" }).some(
    (f) => f.severity === "block",
  ),
  false,
);
check(
  "инцидент: внутри компании находка всё равно есть",
  scanText("Сбой произошёл по нашей вине, регулятора уведомили", { audience: "internal" }).length > 0,
  true,
);
check(
  "инцидент: подсказка объясняет, как переформулировать",
  scanText("Данные покупателей не утекли", { audience: "client" })
    .filter((f) => f.rule === "assertion-not-observation")
    .some((f) => f.hint.includes("признаков доступа")),
  true,
);

// ── аудитория меняет строгость ────────────────────────────────────────
const internalText = "Сервер приложений 10.0.0.5, каталог C:\\Users\\andrey\\projects";
check(
  "внутренний адрес: для заказчика — запрет",
  scanText(internalText, { audience: "client" }).some((f) => f.severity === "block"),
  true,
);
check(
  "внутренний адрес: внутри компании — только предупреждение",
  scanText(internalText, { audience: "internal" }).some((f) => f.severity === "block"),
  false,
);

// ── секреты не попадают в отчёт целиком ───────────────────────────────
const secret = "ghp_AbCdEfGh1234567890XyZwVuTsRq";
const report = guard({ комментарий: `Токен ${secret}` }, { audience: "client" }).report;
check("секрет в отчёте замаскирован", report.includes(secret), false);
check("отчёт остановил отправку", guard({ x: `Токен ${secret}` }).blocked, true);

// ── сбор сделанного по истории git ────────────────────────────────────
const commit = (date: string, subject: string, files: string[], issues: number[] = []): Commit => ({
  hash: `${date}-${subject}`,
  short: date.slice(11, 16),
  date,
  author: "Тест",
  email: "test@example.com",
  subject,
  body: "",
  files,
  insertions: 10,
  deletions: 2,
  issues,
});

const dayCommits: Commit[] = [
  commit("2026-09-21T09:00:00+03:00", "feat(core): протокол обмена", ["scripts/core.ts"]),
  commit("2026-09-21T10:30:00+03:00", "fix(core): разбор сообщений", ["scripts/core.ts"]),
  // разрыв больше двух часов — новая сессия
  commit("2026-09-21T15:00:00+03:00", "docs: инструкция по запуску #1234", ["docs/readme.md"], [1234]),
];

const sessions = buildSessions(dayCommits, 90, 30, 0.5);
check("сессии: разрыв делит работу", sessions.length, 2);
check("сессии: длительность первой", sessions[0]?.hours, 2);
check("сессии: одиночный коммит по минимуму", sessions[1]?.hours, 0.5);

const groups = buildGroups(sessions);
check("группы: разделены по теме", groups.length, 2);
check(
  "группы: задача распознана по номеру",
  groups.find((g) => g.issue === 1234) !== undefined,
  true,
);
check(
  "группы: работа без задачи попала в отдельную",
  groups.filter((g) => g.issue === null).length,
  1,
);
check("группы: сумма часов сохранена", Math.round(groups.reduce((s, g) => s + g.hours, 0) * 4) / 4, 2.5);

check("склонение: 1", plural(1, ["коммит", "коммита", "коммитов"]), "1 коммит");
check("склонение: 3", plural(3, ["коммит", "коммита", "коммитов"]), "3 коммита");
check("склонение: 11", plural(11, ["коммит", "коммита", "коммитов"]), "11 коммитов");
check("склонение: 22", plural(22, ["коммит", "коммита", "коммитов"]), "22 коммита");

const withoutIssue = groups.find((g) => g.issue === null);
if (withoutIssue) {
  const html = draftDescription(withoutIssue, "html");
  check("черновик: это HTML", html.startsWith("<p>"), true);
  check("черновик: перечисляет работы", html.includes("<li>"), true);
  const textile = draftDescription(withoutIssue, "textile");
  check("черновик: textile без тегов", textile.includes("<p>"), false);
} else {
  failures.push("черновик: не нашлась группа без задачи");
}

// ── разбор зависших задач ─────────────────────────────────────────────
const NOW = new Date("2026-09-22T00:00:00Z");
const issue = (status: string, updated: string) => ({ status: { name: status }, updated_on: updated });

check("категория: выполнена, но не закрыта", categorize(issue("Выполнена", "2021-09-30"), NOW, 6), "done-not-closed");
check("категория: принята", categorize(issue("Принята", "2026-09-01"), NOW, 6), "done-not-closed");
check("категория: Resolved", categorize(issue("Resolved", "2024-12-15"), NOW, 6), "done-not-closed");
check("категория: отложена", categorize(issue("Отложена", "2022-06-24"), NOW, 6), "on-hold");
check("категория: новая и забытая", categorize(issue("Новая", "2024-11-27"), NOW, 6), "no-movement");
check("категория: новая и свежая", categorize(issue("Новая", "2026-09-01"), NOW, 6), "active");
check("категория: в работе на границе", categorize(issue("В работе", "2026-03-20"), NOW, 6), "no-movement");
check("категория: порог сдвигается", categorize(issue("В работе", "2026-03-20"), NOW, 12), "active");
check("возраст в месяцах", monthsSince("2026-03-22", NOW), 6);

// ── идентификатор проекта ─────────────────────────────────────────────
check("транслит: шипящие", translit("Щука, чай и ёж"), "schuka, chay i ezh");
check("транслит: мягкий и твёрдый знаки исчезают", translit("Объявление"), "obyavlenie");
check("транслит: латиница не трогается", translit("Eurobrands UNF"), "eurobrands unf");

check("идентификатор: из русского названия", slugIdentifier("Пример: сопровождение УНФ"), "primer-soprovozhdenie-unf");
check("идентификатор: дефисы не задваиваются", slugIdentifier("Обмен — сайт / 1С"), "obmen-sayt-1s");
check("идентификатор: края без дефисов", slugIdentifier("  «Вармора»  "), "varmora");
check("идентификатор: длина обрезается", slugIdentifier("а".repeat(120)).length, 100);
check("идентификатор: хвостовой дефис после обрезки", slugIdentifier("х".repeat(99) + " слово").endsWith("-"), false);

check("идентификатор: название из цифр и слова", slugIdentifier("33 Решения"), "33-resheniya");

check("проверка: обычный", identifierProblem("primer-unf_2"), null);
check("проверка: пустой", identifierProblem("") !== null, true);
// Правило Redmine: цифра в начале допустима, запрещён только идентификатор из одних цифр.
check("проверка: начинается с цифры — допустимо", identifierProblem("33-resheniya"), null);
check("проверка: цифра и буквы без дефиса", identifierProblem("1c-department"), null);
check("проверка: одни цифры отвергаются", identifierProblem("33") !== null, true);
check("проверка: текст отказа про одни цифры", (identifierProblem("2026") ?? "").includes("из одних цифр"), true);
check("проверка: верхний регистр", identifierProblem("Primer") !== null, true);
check("проверка: пробел", identifierProblem("primer unf") !== null, true);
check("проверка: кириллица", identifierProblem("проект") !== null, true);
check("проверка: слишком длинный", identifierProblem("a".repeat(101)) !== null, true);

// ── пользовательские поля проекта ─────────────────────────────────────
const projectFieldsFixture: ProjectField[] = [
  { id: 12, name: "Проектная система расчетов", format: "bool", required: true, allowed: [], seen: ["0", "1"] },
  {
    id: 23,
    name: "Статус",
    format: "list",
    required: true,
    allowed: ["Проект", "Контроль", "Мониторинг"],
    seen: ["Проект", "Контроль"],
  },
  { id: 31, name: "Куратор", allowed: [], seen: [] },
];

check("поле: разбор имени и значения", parseFieldSpec("Статус=Проект"), { key: "Статус", value: "Проект" });
check("поле: значение с запятой и знаком равенства", parseFieldSpec("Куратор=Иванов, отдел=продажи"), {
  key: "Куратор",
  value: "Иванов, отдел=продажи",
});
check("поле: форма с номером", parseFieldSpec("23=Контроль"), { key: "23", value: "Контроль" });
checkThrows("поле: без знака равенства", () => parseFieldSpec("Статус"));
checkThrows("поле: без имени", () => parseFieldSpec("=Проект"));

check("поле: имя разворачивается в номер", assignProjectFields(projectFieldsFixture, [{ key: "Статус", value: "Контроль" }]), [
  { id: 23, name: "Статус", value: "Контроль", note: "" },
]);
check(
  "поле: регистр значения приводится к справочному",
  assignProjectFields(projectFieldsFixture, [{ key: "статус", value: "мониторинг" }])[0]?.value,
  "Мониторинг",
);
check(
  "поле: логическое принимает «да»",
  assignProjectFields(projectFieldsFixture, [{ key: "12", value: "да" }])[0]?.value,
  "1",
);
checkThrows("поле: значение вне списка", () =>
  assignProjectFields(projectFieldsFixture, [{ key: "Статус", value: "Приостановлен" }]),
);
checkThrows("поле: неизвестное имя", () =>
  assignProjectFields(projectFieldsFixture, [{ key: "Ответственный", value: "Иванов" }]),
);
checkThrows("поле: неизвестный номер", () => assignProjectFields(projectFieldsFixture, [{ key: "99", value: "Иванов" }]));
check(
  "поле: свободное значение без справочника",
  assignProjectFields(projectFieldsFixture, [{ key: "Куратор", value: "Иванов" }])[0]?.value,
  "Иванов",
);
check(
  "поле: номер без справочника принимается как есть",
  assignProjectFields([], [{ key: "12", value: "1" }])[0]?.name,
  "поле #12",
);
checkThrows("поле: имя без справочника распознать нечем", () =>
  assignProjectFields([], [{ key: "Статус", value: "Проект" }]),
);

// ── ретроспективное заполнение ────────────────────────────────────────
// Одна запись на период — огрубление: 27,3 часа «за 3 сентября» на деле были пятью днями.
const lump = [{ date: "2026-09-03", hours: 27.3 }];
const spread = [
  { date: "2026-09-03", hours: 13.1 },
  { date: "2026-09-04", hours: 9.5 },
  { date: "2026-09-05", hours: 0.8 },
  { date: "2026-09-08", hours: 3.6 },
  { date: "2026-09-09", hours: 2.5 },
];

check("разнос: дней после разноса", dayTotals(spread).size, 5);
const sum = (values: number[]): number => Math.round(values.reduce((s, x) => s + x, 0) * 100) / 100;
check("разнос: сумма не поехала", sum([...dayTotals(spread).values()]), 29.5);
check("разнос: две записи одного дня складываются", [
  ...dayTotals([
    { date: "2026-09-03", hours: 4 },
    { date: "2026-09-03", hours: 2.5 },
    { date: "2026-09-04", hours: 1 },
  ]).entries(),
], [
  ["2026-09-03", 6.5],
  ["2026-09-04", 1],
]);
check("разнос: дни идут по возрастанию", [...dayTotals([{ date: "2026-09-09", hours: 1 }, { date: "2026-09-03", hours: 1 }]).keys()], [
  "2026-09-03",
  "2026-09-09",
]);

check("правдоподобие: глыба за один день", loadWarnings(lump, { today: "2026-09-22" }).length, 1);
check(
  "правдоподобие: текст про предел",
  loadWarnings(lump, { today: "2026-09-22" })[0]?.includes("больше 12"),
  true,
);
// После разноса остаётся одна пометка — день на 13,1 часа: длинный, но это уже вопрос к человеку.
check("правдоподобие: после разноса остаётся один длинный день", loadWarnings(spread, { today: "2026-09-22" }).length, 1);
check(
  "правдоподобие: нормальные дни молчат",
  loadWarnings(spread.slice(1), { today: "2026-09-22" }).length,
  0,
);
check("правдоподобие: ровно 12 часов — не повод", loadWarnings([{ date: "2026-09-03", hours: 12 }], { today: "2026-09-22" }).length, 0);
check("правдоподобие: свой предел", loadWarnings([{ date: "2026-09-03", hours: 9 }], { today: "2026-09-22", limit: 8 }).length, 1);
check(
  "правдоподобие: дата в будущем",
  loadWarnings([{ date: "2026-09-30", hours: 2 }], { today: "2026-09-22" })[0]?.includes("в будущем"),
  true,
);
check(
  "правдоподобие: день по частям всё равно длинный",
  loadWarnings(
    [
      { date: "2026-09-03", hours: 7 },
      { date: "2026-09-03", hours: 6 },
    ],
    { today: "2026-09-22" },
  ).length,
  1,
);

// Сверка «до и после»: Redmine теряет сотые, поэтому допуск растёт с числом записей.
check("сверка: сошлось", reconcileHours(10, 39.5, 29.5, 5).ok, true);
check("сверка: округление Redmine не считается расхождением", reconcileHours(0, 1.98, 1.99, 1).ok, true);
check("сверка: пропавшая запись видна", reconcileHours(10, 36, 29.5, 5).ok, false);
check("сверка: размер расхождения назван", reconcileHours(10, 36, 29.5, 5).diff, -3.5);
check("сверка: допуск не бесконечный", reconcileHours(0, 29.4, 29.5, 3).ok, false);


// ── связи между задачами ──────────────────────────────────────────────
check("тип связи: канонический", parseRelationType("blocks"), "blocks");
check("тип связи: регистр не важен", parseRelationType("  BLOCKS "), "blocks");
check("тип связи: подчёркивание как разделитель", parseRelationType("copied_to"), "copied_to");
check("тип связи: тот же тип через пробел", parseRelationType("copied from"), "copied_from");
check("тип связи: русское «связана»", parseRelationType("связана"), "relates");
check("тип связи: русское «блокирует»", parseRelationType("блокирует"), "blocks");
check("тип связи: русское «заблокирована»", parseRelationType("Заблокирована"), "blocked");
check("тип связи: русское «предшествует»", parseRelationType("предшествует"), "precedes");
check("тип связи: русское «следует»", parseRelationType("следует"), "follows");
check("тип связи: «следует за» — тот же тип", parseRelationType("следует за"), "follows");
check("тип связи: русское «дублирует»", parseRelationType("дублирует"), "duplicates");
check("тип связи: «дублируется» — обратный тип", parseRelationType("дублируется"), "duplicated");
check("тип связи: «ё» не мешает", parseRelationType("связана"), parseRelationType("связана"));
checkThrows("тип связи: выдумка", () => parseRelationType("зависит"));
checkThrows("тип связи: пустая строка", () => parseRelationType("  "));

// Тип хранится от лица первой задачи: со стороны второй он разворачивается.
check("разворот: blocks", invertRelationType("blocks"), "blocked");
check("разворот: precedes", invertRelationType("precedes"), "follows");
check("разворот: duplicates", invertRelationType("duplicates"), "duplicated");
check("разворот: copied_to", invertRelationType("copied_to"), "copied_from");
check("разворот: relates симметрична", invertRelationType("relates"), "relates");
for (const type of ["relates", "duplicates", "duplicated", "blocks", "blocked", "precedes", "follows", "copied_to", "copied_from"] as const) {
  check(`разворот дважды возвращает исходный тип: ${type}`, invertRelationType(invertRelationType(type)), type);
}

check("ответ Redmine: известный тип", asRelationType("precedes"), "precedes");
check("ответ Redmine: незнакомый тип не ломает разбор", asRelationType("teleports"), null);

check("отсрочка: имеет смысл для precedes", delayApplies("precedes"), true);
check("отсрочка: имеет смысл для follows", delayApplies("follows"), true);
check("отсрочка: бессмысленна для blocks", delayApplies("blocks"), false);
check("отсрочка: бессмысленна для relates", delayApplies("relates"), false);

// Предпросмотр объясняет последствие, а не называет код типа.
check(
  "смысл связи: блокировка названа словами",
  describeRelation("blocks", 25185, 25190),
  "#25185 блокирует #25190: пока #25185 не закрыта, #25190 выполнять нельзя — Redmine не даст перевести её в закрывающий статус.",
);
check(
  "смысл связи: порядок без отсрочки — следующий день",
  describeRelation("precedes", 1, 2).includes("на следующий день после окончания #1"),
  true,
);
check(
  "смысл связи: отсрочка попадает в текст",
  describeRelation("precedes", 1, 2, 3).includes("через 3 дн. после окончания #1"),
  true,
);
check(
  "смысл связи: отсрочка 0 — это не отсрочка",
  describeRelation("precedes", 1, 2, 0).includes("на следующий день"),
  true,
);
check(
  "смысл связи: дубль предупреждает о закрытии второй задачи",
  describeRelation("duplicates", 1, 2).includes("закроется вместе с ней"),
  true,
);

// Отказ 422 разворачивается в объяснение, а не в код ответа.
check(
  "отказ: связь с самой собой",
  explainRelationRejection(["Issue cannot be linked to itself"], { from: 5, to: 5, type: "relates" }).includes(
    "саму с собой",
  ),
  true,
);
check(
  "отказ: цикл",
  explainRelationRejection(["This relation would create a circular dependency"], {
    from: 1,
    to: 2,
    type: "precedes",
  }).includes("замкнула бы круг"),
  true,
);
check(
  "отказ: связь уже есть",
  explainRelationRejection(["Relation has already been taken"], { from: 1, to: 2, type: "blocks" }).includes(
    "уже есть",
  ),
  true,
);
check(
  "отказ: подзадача",
  explainRelationRejection(["An issue cannot be linked to one of its subtasks"], {
    from: 1,
    to: 2,
    type: "blocks",
  }).includes("иерархия"),
  true,
);
check(
  "отказ: незнакомая причина не теряется",
  explainRelationRejection(["Something odd"], { from: 1, to: 2, type: "relates" }).includes("Something odd"),
  true,
);
check(
  "отказ: кода ответа в тексте нет",
  explainRelationRejection(["Something odd"], { from: 1, to: 2, type: "relates" }).includes("422"),
  false,
);

// ── ссылки на задачи и второй инстанс ─────────────────────────────────
const known = [
  { name: "company", base: "https://redmine.example.com/" },
  { name: "ru", base: "https://tracker.example.ru/redmine/" },
];

check("ссылка: голый номер", parseIssueRef("1234", known), { id: 1234, raw: "1234" });
check("ссылка: с решёткой", parseIssueRef("#1234", known), { id: 1234, raw: "#1234" });
check("ссылка: профиль перед номером", parseIssueRef("ru:25185", known), {
  id: 25185,
  instance: "ru",
  raw: "ru:25185",
});
check("ссылка: профиль и решётка", parseIssueRef("company:#42", known), {
  id: 42,
  instance: "company",
  raw: "company:#42",
});
check("ссылка: профиль по началу имени", parseIssueRef("comp:42", known).instance, "company");
check("ссылка: адрес известного инстанса", parseIssueRef("https://tracker.example.ru/redmine/issues/25185", known), {
  id: 25185,
  instance: "ru",
  raw: "https://tracker.example.ru/redmine/issues/25185",
});
check(
  "ссылка: адрес с якорем комментария",
  parseIssueRef("https://redmine.example.com/issues/777#note-3", known).instance,
  "company",
);
check(
  "ссылка: чужой хост опознан как чужой",
  parseIssueRef("https://redmine.someone-else.org/issues/1", known).foreignHost,
  "redmine.someone-else.org",
);
check(
  "ссылка: у чужого адреса нет профиля",
  parseIssueRef("https://redmine.someone-else.org/issues/1", known).instance,
  undefined,
);
checkThrows("ссылка: неизвестный профиль", () => parseIssueRef("prod:1", known));
checkThrows("ссылка: адрес без номера задачи", () => parseIssueRef("https://redmine.example.com/projects/core", known));
checkThrows("ссылка: не ссылка вовсе", () => parseIssueRef("вчерашняя задача", known));
checkThrows("ссылка: пустая строка", () => parseIssueRef("   ", known));

// Ссылка на второй инстанс не должна потеряться в тексте описания или комментария.
const others = [{ name: "ru", base: "https://tracker.example.ru/redmine/" }];
check(
  "перекрёстные ссылки: находятся в html",
  findCrossInstanceRefs(
    '<p>Внедрение: <a href="https://tracker.example.ru/redmine/issues/25185">33 Решения #25185</a></p>',
    others,
  ),
  [{ instance: "ru", id: 25185, url: "https://tracker.example.ru/redmine/issues/25185" }],
);
check(
  "перекрёстные ссылки: повтор считается один раз",
  findCrossInstanceRefs(
    "https://tracker.example.ru/redmine/issues/25185 и ещё раз https://tracker.example.ru/redmine/issues/25185#note-2",
    others,
  ).length,
  1,
);
check(
  "перекрёстные ссылки: свой инстанс сюда не попадает",
  findCrossInstanceRefs("https://redmine.example.com/issues/42", others),
  [],
);
check(
  "перекрёстные ссылки: адрес проекта — не задача",
  findCrossInstanceRefs("https://tracker.example.ru/redmine/projects/core", others),
  [],
);
check("перекрёстные ссылки: нечего искать без профилей", findCrossInstanceRefs("https://любой/issues/1", []), []);
check(
  "перекрёстные ссылки: точка в конце предложения не ломает разбор",
  findCrossInstanceRefs("Подробности в https://tracker.example.ru/redmine/issues/7.", others)[0]?.id,
  7,
);

// Строка перекрёстной ссылки: номер без адреса на другом инстансе указывает на чужую задачу.
const xref = {
  url: "https://tracker.example.ru/redmine/issues/25185",
  id: 25185,
  project: "33 Решения",
  subject: "Панель контроля менеджеров: оперативное ядро платформы",
};
check(
  "xref: подпись с названием проекта",
  xrefLabel(xref.project, xref.id, xref.subject),
  "33 Решения #25185 — Панель контроля менеджеров: оперативное ядро платформы",
);
check(
  "xref: html",
  formatXref(xref),
  '<a href="https://tracker.example.ru/redmine/issues/25185">33 Решения #25185 — Панель контроля менеджеров: оперативное ядро платформы</a>',
);
check(
  "xref: markdown",
  formatXref(xref, "markdown"),
  "[33 Решения #25185 — Панель контроля менеджеров: оперативное ядро платформы](https://tracker.example.ru/redmine/issues/25185)",
);
check(
  "xref: textile",
  formatXref(xref, "textile"),
  '"33 Решения #25185 — Панель контроля менеджеров: оперативное ядро платформы":https://tracker.example.ru/redmine/issues/25185',
);
check(
  "xref: разметка темы не ломает ссылку",
  formatXref({ ...xref, subject: 'Обмен <b>«ЮЛ & ИП»</b>' }),
  '<a href="https://tracker.example.ru/redmine/issues/25185">33 Решения #25185 — Обмен &lt;b&gt;«ЮЛ &amp; ИП»&lt;/b&gt;</a>',
);
check("xref: адрес в строке есть всегда", formatXref(xref).includes(xref.url), true);

// ── план дерева: каталог описаний ─────────────────────────────────────
// Регулярка «отрезать после последнего слэша» на голом plan.json ничего не отрезала,
// и описания искались как plan.json\parent.html.
check("план: голое имя файла — текущий каталог", planBaseDir("plan.json", undefined), ".");
check("план: голое имя файла (posix)", planBaseDir("plan.json", undefined, posix), ".");
check("план: голое имя файла (win32)", planBaseDir("plan.json", undefined, win32), ".");
check("план: относительный каталог", planBaseDir("./dir/plan.json", undefined, posix), "./dir");
check("план: относительный каталог (win32)", planBaseDir("./dir/plan.json", undefined, win32), "./dir");
check("план: абсолютный путь Windows", planBaseDir("C:\\x\\plan.json", undefined, win32), "C:\\x");
check("план: --base важнее каталога файла", planBaseDir("./dir/plan.json", "/tmp/texts", posix), "/tmp/texts");
check("план: из stdin каталога нет", planBaseDir(undefined, undefined), undefined);
check("описание: план без каталога", planTextPath(".", "parent.html", posix), "parent.html");
check("описание: план без каталога (win32)", planTextPath(".", "parent.html", win32), "parent.html");
check("описание: из каталога плана", planTextPath("./dir", "child-1.html", posix), "dir/child-1.html");
check("описание: из каталога плана Windows", planTextPath("C:\\x", "parent.html", win32), "C:\\x\\parent.html");
check("описание: абсолютный путь Windows не трогается", planTextPath("C:\\x", "D:\\texts\\p.html", win32), "D:\\texts\\p.html");
check("описание: абсолютный путь posix не трогается", planTextPath("/plans", "/tmp/p.html", posix), "/tmp/p.html");
check("описание: без каталога плана — как есть", planTextPath(undefined, "parent.html"), "parent.html");
// Прежняя проверка считала абсолютным любой путь с двоеточием.
check("описание: двоеточие не делает путь абсолютным", planTextPath("/plans", "этап:1.html", posix), "/plans/этап:1.html");

// ── участники проекта ─────────────────────────────────────────────────
function errorText(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Разбор аргументов.
check(
  "add-member: проект, пользователь и повторяемая роль",
  readAddMember(parseArgs(["add-member", "3097", "--user", "Фёдор Иванов", "--role", "Разработчик", "--role", "Клиент"])),
  { project: "3097", user: "Фёдор Иванов", roles: ["Разработчик", "Клиент"] },
);
check(
  "add-member: роли списком через запятую",
  readAddMember(parseArgs(["add-member", "primer", "--user", "me", "--role", "Разработчик,Клиент"])).roles,
  ["Разработчик", "Клиент"],
);
check(
  "add-member: проект флагом",
  readAddMember(parseArgs(["add-member", "--project", "primer", "--user", "27", "--role", "4"])).project,
  "primer",
);
check(
  "add-member: общие флаги не мешают",
  readAddMember(parseArgs(["add-member", "3097", "--user", "me", "--role", "3", "--instance", "ru", "--yes"])),
  { project: "3097", user: "me", roles: ["3"] },
);
checkThrows("add-member: без проекта", () => readAddMember(parseArgs(["add-member", "--user", "me", "--role", "3"])));
checkThrows("add-member: без пользователя", () => readAddMember(parseArgs(["add-member", "3097", "--role", "3"])));
checkThrows("add-member: --user без значения", () =>
  readAddMember(parseArgs(["add-member", "3097", "--user", "--role", "3"])),
);
checkThrows("add-member: без роли", () => readAddMember(parseArgs(["add-member", "3097", "--user", "me"])));
check(
  "add-member: имя без кавычек — остановка с подсказкой",
  errorText(() =>
    readAddMember(parseArgs(["add-member", "3097", "--user", "Фёдор", "Иванов", "--role", "Разработчик"])),
  ).includes("в кавычки"),
  true,
);
check(
  "update-member: номер членства с решёткой",
  readUpdateMember(parseArgs(["update-member", "#812", "--role", "Менеджер"])),
  { membershipId: 812, roles: ["Менеджер"] },
);
checkThrows("update-member: без ролей", () => readUpdateMember(parseArgs(["update-member", "812"])));
checkThrows("update-member: номер не число", () => readUpdateMember(parseArgs(["update-member", "abc", "--role", "3"])));
checkThrows("update-member: ноль", () => readUpdateMember(parseArgs(["update-member", "0", "--role", "3"])));
check("remove-member: номер членства", readRemoveMember(parseArgs(["remove-member", "812", "--yes"])), { membershipId: 812 });
checkThrows("remove-member: без номера", () => readRemoveMember(parseArgs(["remove-member"])));
checkThrows("remove-member: два номера разом", () => readRemoveMember(parseArgs(["remove-member", "812", "813"])));

// Роли словами.
const rolesFixture: RoleInfo[] = [
  {
    id: 3,
    name: "Менеджер",
    assignable: true,
    issues_visibility: "all",
    time_entries_visibility: "all",
    permissions: [
      "view_issues",
      "add_issues",
      "edit_issues",
      "add_issue_notes",
      "delete_issues",
      "view_time_entries",
      "log_time",
      "edit_time_entries",
      "manage_members",
      "edit_project",
    ],
  },
  {
    id: 4,
    name: "Разработчик",
    assignable: true,
    issues_visibility: "default",
    time_entries_visibility: "all",
    permissions: ["view_issues", "add_issues", "edit_issues", "add_issue_notes", "view_time_entries", "log_time", "view_wiki_pages"],
  },
  {
    id: 6,
    name: "Клиент",
    assignable: false,
    issues_visibility: "own",
    time_entries_visibility: "own",
    permissions: ["view_issues", "add_issues", "add_issue_notes", "view_time_entries"],
  },
  { id: 8, name: "Бот чата", assignable: true, permissions: [] },
  { id: 9, name: "Старая роль", permissions: null },
];
const [manager, developer, client, bot, legacy] = rolesFixture as [RoleInfo, RoleInfo, RoleInfo, RoleInfo, RoleInfo];

check("роль: менеджер видит все задачи", describeRole(manager).startsWith("задачи: видит все;"), true);
check("роль: менеджер управляет участниками", describeRole(manager).includes("управляет участниками"), true);
check("роль: менеджер может быть исполнителем", describeRole(manager).includes("может быть исполнителем задач"), true);
check("роль: приватные задачи скрыты", describeRole(developer).includes("видит все, кроме приватных"), true);
check("роль: доступ к вики назван", describeRole(developer).includes("также: вики"), true);
check(
  "роль: клиент видит только свои задачи",
  describeRole(client).includes("видит только созданные им или назначенные на него"),
  true,
);
check("роль: клиент видит только свои списания", describeRole(client).includes("видит только свои списания"), true);
check("роль: клиент не исполнитель", describeRole(client).includes("исполнителем задач быть не может"), true);
check("роль: клиент не редактирует чужое", describeRole(client).includes("редактирует"), false);
check("роль без прав: задач не видит", describeRole(bot).includes("задач не видит"), true);
check("роль без прав: трудозатрат не видит", describeRole(bot).includes("трудозатрат не видит"), true);
check("роль: права не прочитаны — сказано прямо", describeRole(legacy).includes("не прочитаны"), true);

check("роли: по имени без учёта регистра", resolveRoles(rolesFixture, ["менеджер"]).map((r) => r.id), [3]);
check("роли: по номеру", resolveRoles(rolesFixture, ["4"]).map((r) => r.id), [4]);
check("роли: по однозначному началу", resolveRoles(rolesFixture, ["Разраб"]).map((r) => r.id), [4]);
check("роли: повтор не дублируется", resolveRoles(rolesFixture, ["Менеджер", "Клиент", "менеджер"]).map((r) => r.id), [3, 6]);
checkThrows("роли: пустой список", () => resolveRoles(rolesFixture, []));
checkThrows("роли: неизвестный номер", () => resolveRoles(rolesFixture, ["99"]));
const unknownRole = errorText(() => resolveRoles(rolesFixture, ["Бухгалтер"]));
check("роли: неизвестная названа", unknownRole.includes("Бухгалтер"), true);
check("роли: перечислены доступные", unknownRole.includes("Менеджер, Разработчик, Клиент"), true);
check("роли: подсказка про справочник", unknownRole.includes("redmine.ts roles"), true);

// Поиск человека по имени.
const people: PersonCandidate[] = [
  { id: 27, name: "Фёдор Иванов", kind: "user", projects: ["Альфа", "Бета"] },
  { id: 31, name: "Иван Петров", kind: "user", projects: ["Альфа"] },
  { id: 32, name: "Иван Петров", kind: "user", projects: ["Гамма"] },
  { id: 40, name: "Иван Петрович Сидоров", kind: "user", projects: ["Бета"] },
  { id: 9, name: "Разработка 1С", kind: "group", projects: ["Альфа"] },
];
const oneId = (needle: string): number | null => {
  const m = matchPeople(people, needle);
  return m.kind === "one" ? m.person.id : null;
};
check("имя: полное", oneId("Фёдор Иванов"), 27);
check("имя: порядок слов и «ё» не важны", oneId("иванов федор"), 27);
check("имя: одна фамилия", oneId("Иванов"), 27);
check("имя: начала слов", oneId("Фёд Иван"), 27);
check("имя: группа находится", oneId("Разработка"), 9);
check("имя: полное совпадение важнее частичного", oneId("Сидоров"), 40);
const namesakes = matchPeople(people, "Иван Петров");
check(
  "имя: однофамильцы — неоднозначность, а не выбор",
  namesakes.kind === "many" ? namesakes.candidates.map((c) => c.id) : [],
  [31, 32],
);
const noOne = matchPeople(people, "Федр");
check("имя: опечатка — не найден", noOne.kind, "none");
check("имя: опечатка — похожие предложены", noOne.kind === "none" ? noOne.similar.map((c) => c.id) : [], [27]);

const closedDirectory = { projects: 12, directory: "closed" as const, serverHits: [] };
const ambiguous = errorText(() => pickPerson(people, "Иван Петров", closedDirectory));
check("выбор: кандидаты с номерами", ambiguous.includes("id=31") && ambiguous.includes("id=32"), true);
check("выбор: кандидаты с проектами", ambiguous.includes("проекты: Альфа") && ambiguous.includes("проекты: Гамма"), true);
check("выбор: подсказка про номер", ambiguous.includes("--user <id>"), true);
const missing = errorText(() => pickPerson(people, "Федр", closedDirectory));
check("выбор: сказано, где искали", missing.includes("среди участников 12 видимых проектов"), true);
check("выбор: похожий кандидат в списке", missing.includes("Фёдор Иванов (id=27)"), true);
check("выбор: объяснено, почему не найти вне проектов", missing.includes("только администратору"), true);
check(
  "выбор: справочник администратора упомянут",
  errorText(() => pickPerson(people, "Пётр Нетов", { projects: 12, directory: "admin", serverHits: [] })).includes(
    "в справочнике пользователей",
  ),
  true,
);
const byLogin: PersonCandidate = { id: 77, name: "Пётр Логинов", kind: "user", projects: [] };
check(
  "выбор: совпадение по логину из справочника",
  pickPerson([...people, byLogin], "plogin", { projects: 12, directory: "admin", serverHits: [byLogin] }).id,
  77,
);
check("выбор: единственный кандидат выбирается", pickPerson(people, "Иванов", closedDirectory).id, 27);

check(
  "учётная запись: заведена и входили",
  accountSeen({ created_on: "2024-01-10T08:00:00Z", last_login_on: "2026-09-01T10:00:00Z" }),
  "заведён 2024-01-10, последний вход 2026-09-01",
);
check(
  "учётная запись: не входил ни разу",
  accountSeen({ created_on: "2024-01-10T08:00:00Z", last_login_on: null }),
  "заведён 2024-01-10, не входил ни разу",
);
check("учётная запись: дату входа не показали — не выдумываем", accountSeen({ created_on: "2024-01-10T08:00:00Z" }), "заведён 2024-01-10");
check("учётная запись: ничего не известно", accountSeen({}), undefined);

// Членства.
const membershipFixture: Membership = {
  id: 812,
  project: { id: 3097, name: "Пример" },
  user: { id: 27, name: "Фёдор Иванов" },
  roles: [
    { id: 4, name: "Разработчик" },
    { id: 5, name: "Наблюдатель", inherited: true },
    { id: 5, name: "Наблюдатель", inherited: true },
  ],
};
const groupMembership: Membership = {
  id: 700,
  project: { id: 3097, name: "Пример" },
  group: { id: 9, name: "Разработка 1С" },
  roles: [{ id: 5, name: "Наблюдатель" }],
};
check("членство: найдено по пользователю", findMembership([groupMembership, membershipFixture], 27)?.id, 812);
check("членство: найдено по группе", findMembership([groupMembership, membershipFixture], 9)?.id, 700);
check("членство: чужого нет", findMembership([groupMembership, membershipFixture], 999), undefined);
check("членство: собственные роли", ownRoles(membershipFixture).map((r) => r.id), [4]);
check("членство: унаследованные роли", inheritedRoles(membershipFixture).length, 2);
check(
  "членство: унаследованная роль от двух групп показана один раз",
  describeMemberRoles(membershipFixture.roles),
  "Разработчик + унасл.: Наблюдатель",
);
check("членство: только унаследованные", describeMemberRoles([{ id: 5, name: "Наблюдатель", inherited: true }]), "унасл.: Наблюдатель");
check("членство: без ролей", describeMemberRoles([]), "—");

// Тела запросов.
check("запрос: добавление", addMemberRequest(3097, 27, [4, 6, 4]), {
  method: "POST",
  path: "projects/3097/memberships.json",
  body: { membership: { user_id: 27, role_ids: [4, 6] } },
});
checkThrows("запрос: добавление без ролей", () => addMemberRequest(3097, 27, []));
checkThrows("запрос: добавление без пользователя", () => addMemberRequest(3097, 0, [4]));
checkThrows("запрос: дробный номер роли", () => addMemberRequest(3097, 27, [4.5]));
check("запрос: смена ролей", updateMemberRequest(812, [3]), {
  method: "PUT",
  path: "memberships/812.json",
  body: { membership: { role_ids: [3] } },
});
checkThrows("запрос: смена ролей на пустой набор", () => updateMemberRequest(812, []));
check("запрос: удаление без тела", removeMemberRequest(812), { method: "DELETE", path: "memberships/812.json" });
checkThrows("запрос: удаление без номера", () => removeMemberRequest(-1));

// Отказы словами, без кода ответа.
const rejectCtx = { action: "add" as const, project: "«Пример» (primer, id=3097)", who: "Фёдор Иванов (id=27)" };
const taken = explainMembershipRejection(["User has already been taken"], rejectCtx);
check("отказ членства: уже участник", taken.includes("уже участник") && taken.includes("update-member"), true);
check(
  "отказ членства: уже участник по-русски",
  explainMembershipRejection(["Пользователь уже существует"], rejectCtx).includes("уже участник"),
  true,
);
check(
  "отказ членства: роли отброшены",
  explainMembershipRejection(["Роль не может быть пустым"], rejectCtx).includes("только эти роли"),
  true,
);
check(
  "отказ членства: роли отброшены (англ.)",
  explainMembershipRejection(["Role cannot be blank"], rejectCtx).includes("только эти роли"),
  true,
);
check(
  "отказ членства: нет такого пользователя",
  explainMembershipRejection(["User cannot be blank"], rejectCtx).includes("нет или он заблокирован"),
  true,
);
check(
  "отказ членства: удаление унаследованного",
  explainMembershipRejection([], { ...rejectCtx, action: "remove" }).includes("унаследованные"),
  true,
);
check(
  "отказ членства: незнакомая причина не теряется",
  explainMembershipRejection(["Something odd"], rejectCtx).includes("Something odd"),
  true,
);
check(
  "отказ членства: кода ответа в тексте нет",
  [
    explainMembershipRejection(["User has already been taken"], rejectCtx),
    explainMembershipRejection([], { ...rejectCtx, action: "remove" }),
    explainMemberForbidden("add", rejectCtx.project),
    explainMemberForbidden("list", rejectCtx.project),
  ].some((text) => /\b(403|404|422)\b/.test(text)),
  false,
);
const forbidden = explainMemberForbidden("add", rejectCtx.project);
check("403: названо право", forbidden.includes("«Управление участниками»"), true);
check("403: сказано, кто выдаёт", forbidden.includes("администратор Redmine или менеджер"), true);
check("403 на чтение: право просмотра", explainMemberForbidden("list", rejectCtx.project).includes("«Просмотр участников»"), true);

// Сверка после записи.
check("сверка ролей: совпало, унаследованные не мешают", checkMemberRoles(membershipFixture, [developer]).ok, true);
const dropped = checkMemberRoles(membershipFixture, [developer, manager]);
check("сверка ролей: молча отброшенная роль видна", dropped.ok, false);
check("сверка ролей: названо, какая не легла", dropped.missing.map((r) => r.name), ["Менеджер"]);
const leftover = checkMemberRoles(membershipFixture, [manager]);
check("сверка ролей: неснятая роль видна", leftover.extra.map((r) => r.name), ["Разработчик"]);
check("сверка ролей: участника нет", checkMemberRoles(undefined, [developer]).absent, true);
check("сверка ролей: текст при совпадении", roleCheckText(checkMemberRoles(membershipFixture, [developer]), "А").includes("совпадают"), true);
const droppedText = roleCheckText(dropped, "Фёдор Иванов (id=27)");
check("сверка ролей: расхождение названо", droppedText.includes("РАСХОЖДЕНИЕ") && droppedText.includes("не легли роли Менеджер"), true);
check("сверка ролей: причина объяснена", droppedText.includes("только эти роли"), true);
check("сверка ролей: отсутствие названо", roleCheckText(checkMemberRoles(undefined, [developer]), "А").includes("нет"), true);

// Предпросмотры.
const memberProject: MemberProject = {
  id: 3097,
  name: "Пример",
  identifier: "primer",
  url: "https://redmine.example.com/projects/primer",
  isPublic: false,
};
const ivanov: Principal = { id: 27, name: "Фёдор Иванов", kind: "user", projects: ["Альфа"], self: false };
check("проект: название, идентификатор и номер", projectTitle(memberProject), "«Пример» (primer, id=3097)");

const addText = addMemberPreview({ instance: "company", project: memberProject, principal: ivanov, roles: [developer], memberCount: 7 });
check("предпросмотр добавления: проект", addText.includes("«Пример» (primer, id=3097)"), true);
check("предпросмотр добавления: закрытость проекта", addText.includes("закрытый"), true);
check("предпросмотр добавления: пользователь с номером", addText.includes("Фёдор Иванов (id=27)"), true);
check("предпросмотр добавления: где уже состоит", addText.includes("уже состоит в: Альфа"), true);
check("предпросмотр добавления: роль словами", addText.includes(`Разработчик (id=4): ${describeRole(developer)}`), true);
check("предпросмотр добавления: видимость и уведомления", addText.includes(CLIENT_NOTICE), true);
check(
  "предпросмотр добавления: формулировка про клиентский проект",
  addText.includes("видит задачи проекта в объёме своей роли и получает уведомления"),
  true,
);
check("предпросмотр добавления: число участников", addText.includes("сейчас 7, станет 8"), true);
check("предпросмотр добавления: нужное право", addText.includes("«Управление участниками»"), true);
check(
  "предпросмотр добавления: группа",
  addMemberPreview({
    instance: "company",
    project: memberProject,
    principal: { id: 9, name: "Разработка 1С", kind: "group", projects: [], self: false },
    roles: [developer],
    memberCount: 7,
  }).includes("роли получат все её участники"),
  true,
);
const unknownName = addMemberPreview({
  instance: "company",
  project: memberProject,
  principal: { id: 27, name: null, kind: "unknown", projects: [], self: false, note: "имя узнать не удалось" },
  roles: [developer],
  memberCount: 7,
});
check("предпросмотр добавления: номер без имени", unknownName.includes("пользователь id=27") && unknownName.includes("имя узнать не удалось"), true);
check(
  "предпросмотр добавления: публичный проект",
  addMemberPreview({ instance: "company", project: { ...memberProject, isPublic: true }, principal: ivanov, roles: [developer], memberCount: 7 }).includes(
    "Проект публичный",
  ),
  true,
);
check(
  "предпросмотр добавления: себя",
  addMemberPreview({ instance: "company", project: memberProject, principal: { ...ivanov, self: true }, roles: [developer], memberCount: 7 }).includes(
    "это вы",
  ),
  true,
);

const lineOf = (text: string, head: string): string => text.split("\n").find((l) => l.startsWith(head)) ?? "";
const updateText = updateMemberPreview({
  instance: "company",
  project: memberProject,
  principal: ivanov,
  membership: membershipFixture,
  roles: [manager],
  selfLosesManage: false,
});
check("предпросмотр ролей: номер членства", updateText.includes("членство 812"), true);
check("предпросмотр ролей: что добавляется", lineOf(updateText, "Добавляются").includes("Менеджер"), true);
check("предпросмотр ролей: что снимается", lineOf(updateText, "Снимаются").includes("Разработчик"), true);
check("предпросмотр ролей: унаследованные остаются", lineOf(updateText, "Станут").includes("унаследованные: Наблюдатель"), true);
check("предпросмотр ролей: почему не снимаются", updateText.includes("этой командой они не снимаются"), true);
check("предпросмотр ролей: новая роль словами", updateText.includes(describeRole(manager)), true);
check("предпросмотр ролей: новые права — предупреждение о видимости", updateText.includes(CLIENT_NOTICE), true);
check("предпросмотр ролей: снятие действует сразу", updateText.includes("перестаёт действовать сразу"), true);
const narrowing = updateMemberPreview({
  instance: "company",
  project: memberProject,
  principal: ivanov,
  membership: { ...membershipFixture, roles: [{ id: 4, name: "Разработчик" }, { id: 3, name: "Менеджер" }] },
  roles: [developer],
  selfLosesManage: true,
});
check("предпросмотр ролей: только сужение — без предупреждения о видимости", narrowing.includes(CLIENT_NOTICE), false);
check("предпросмотр ролей: потеря управления собой", narrowing.includes("вернуть её себе сами не сможете"), true);

const removeText = removeMemberPreview({
  instance: "company",
  project: memberProject,
  principal: ivanov,
  membership: { ...membershipFixture, roles: [{ id: 4, name: "Разработчик" }] },
  openIssues: 3,
});
check("предпросмотр удаления: отдельное подтверждение", removeText.includes(SEPARATE_CONFIRMATION), true);
check("предпросмотр удаления: слово «отдельное подтверждение»", removeText.includes("отдельное подтверждение"), true);
check("предпросмотр удаления: проект и участник", removeText.includes("«Пример» (primer, id=3097)") && removeText.includes("Фёдор Иванов (id=27)"), true);
check("предпросмотр удаления: роли", lineOf(removeText, "Роли").includes("Разработчик"), true);
check("предпросмотр удаления: открытые задачи", removeText.includes("3 — останутся назначенными"), true);
check("предпросмотр удаления: что остаётся", removeText.includes("Списанные часы"), true);
check(
  "предпросмотр удаления: себя",
  removeMemberPreview({
    instance: "company",
    project: memberProject,
    principal: { ...ivanov, self: true },
    membership: membershipFixture,
    openIssues: 0,
  }).includes("это ваше собственное членство"),
  true,
);
check(
  "предпросмотр удаления: группа",
  removeMemberPreview({
    instance: "company",
    project: memberProject,
    principal: { id: 9, name: "Разработка 1С", kind: "group", projects: [], self: false },
    membership: groupMembership,
    openIssues: null,
  }).includes("потеряют доступ вместе с ней"),
  true,
);
check(
  "предпросмотр удаления: у группы задач не считаем",
  removeMemberPreview({
    instance: "company",
    project: memberProject,
    principal: { id: 9, name: "Разработка 1С", kind: "group", projects: [], self: false },
    membership: groupMembership,
    openIssues: null,
  }).includes("Открытые задачи"),
  false,
);

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Проверок пройдено: ${passed}`);
if (failures.length > 0) {
  console.error(`\nНе прошло: ${failures.length}`);
  for (const f of failures) console.error(`  — ${f}`);
  process.exit(1);
}
console.log("Самопроверка пройдена.");

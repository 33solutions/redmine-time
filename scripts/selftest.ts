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

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Проверок пройдено: ${passed}`);
if (failures.length > 0) {
  console.error(`\nНе прошло: ${failures.length}`);
  for (const f of failures) console.error(`  — ${f}`);
  process.exit(1);
}
console.log("Самопроверка пройдена.");

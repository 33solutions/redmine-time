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

check("проверка: обычный", identifierProblem("primer-unf_2"), null);
check("проверка: пустой", identifierProblem("") !== null, true);
check("проверка: начинается с цифры", identifierProblem("33-resheniya") !== null, true);
check("проверка: верхний регистр", identifierProblem("Primer") !== null, true);
check("проверка: пробел", identifierProblem("primer unf") !== null, true);
check("проверка: кириллица", identifierProblem("проект") !== null, true);
check("проверка: слишком длинный", identifierProblem("a".repeat(101)) !== null, true);

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Проверок пройдено: ${passed}`);
if (failures.length > 0) {
  console.error(`\nНе прошло: ${failures.length}`);
  for (const f of failures) console.error(`  — ${f}`);
  process.exit(1);
}
console.log("Самопроверка пройдена.");

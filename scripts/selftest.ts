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
import { explainTimeEntryRejection } from "./redmine.ts";
import { isHumanRecord, isQueuedHumanRecord, recordText, cleanText, buildBlocks, summarize, type HumanMessage } from "./sessions.ts";
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
import { planBaseDir, planTextPath, safeCurrentUser } from "./redmine.ts";
import {
  wikiTitle,
  wikiPath,
  wikiPageUrl,
  readWikiRead,
  readWikiHistory,
  readWikiUpdate,
  wikiUpdateRequest,
  normalizeWikiText,
  diffUnits,
  textDiff,
  diffSummary,
  formatDiff,
  markupWarning,
  wikiAudience,
  describeWikiAccess,
  wikiUpdatePreview,
  wikiBaseMismatch,
  checkWikiWrite,
  explainWikiRejection,
  wikiTree,
  wikiHistoryRows,
  readProjectStatusArgs,
  projectStatusRequest,
  projectStatusPreview,
  projectStatusUiPath,
  explainProjectStatusRejection,
  checkProjectStatus,
  projectDescendants,
  describeProjectStatus,
  rightsFromRoles,
  rightsText,
  CLOSE_PERMISSION,
  PROJECT_STATUS,
  type WikiPage,
  type WikiUpdateContext,
  type ProjectStatusContext,
} from "./redmine.ts";
import {
  readWikiDelete,
  wikiDeleteRequest,
  wikiDeletePreview,
  checkWikiDeleted,
  WIKI_DELETE_CONFIRMATION,
  readVersions,
  readCreateVersion,
  createVersionRequest,
  createVersionPreview,
  versionStatus,
  versionSharing,
  versionStatusName,
  describeVersionStatus,
  describeVersionSharing,
  matchVersion,
  versionClears,
  versionPatchValue,
  checkIssueVersion,
  sortVersions,
  versionDueHint,
  versionCountText,
  versionRows,
  explainVersionRejection,
  checkVersionCreated,
  MANAGE_VERSIONS_PERMISSION,
  VERSION_NAME_SOFT,
  type Version,
  type VersionCount,
  type WikiDeleteContext,
  type CreateVersionContext,
} from "./redmine.ts";
import {
  readAttach,
  parseLink,
  showLink,
  dispositionFilename,
  cleanFileName,
  redmineFileName,
  linkFileName,
  fileType,
  formatBytes,
  explainLinkStatus,
  redactLinks,
  downloadLink,
  linkInText,
  mergeRights,
  describeAttachAudience,
  attachPreview,
  uploadId,
  explainAttachRejection,
  checkAttachWrite,
  ATTACH_AUDIENCE_WARNING,
  ATTACH_PERMISSIONS,
  LINK_LIMITS,
  type Fetcher,
  type AttachContext,
  type IssueAttachment,
  type AttachJournal,
} from "./redmine.ts";
import { join, posix, win32 } from "node:path";
import { mkdir, mkdtemp, readdir, rm as removePath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

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

// ── wiki: название и адрес страницы ───────────────────────────────────
// Название приводится к виду Redmine (Wiki.titleize) до запроса: иначе предпросмотр обещал бы одну страницу, а запись шла в другую.
check("wiki: пробелы → подчёркивания", wikiTitle("Как подать заявку"), "Как_подать_заявку");
check("wiki: первая буква заглавная", wikiTitle("как_подать"), "Как_подать");
check("wiki: знаки , . / ? ; | : удаляются", wikiTitle("Итоги: 2026/09, v1.2?"), "Итоги_202609_v12");
check(
  "wiki: название из адреса страницы",
  wikiTitle("https://redmine.example.ru/projects/x/wiki/%D0%9F%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%BA%D0%B0"),
  "Поддержка",
);
checkThrows("wiki: пустое название", () => wikiTitle(" ./ "));
check("wiki: путь страницы кодируется", wikiPath("public_information", "Как_подать"), `projects/public_information/wiki/${encodeURIComponent("Как_подать")}.json`);
check("wiki: путь версии", wikiPath("p", "Wiki", 3), "projects/p/wiki/Wiki/3.json");
check("wiki: адрес для человека читаемый", wikiPageUrl("https://r.example/", "p", "Как_подать"), "https://r.example/projects/p/wiki/Как_подать");
check("wiki: адрес списка страниц", wikiPageUrl("https://r.example/", "p"), "https://r.example/projects/p/wiki");

// ── wiki: разбор аргументов ───────────────────────────────────────────
check("wiki: только проект", readWikiRead(parseArgs(["wiki", "public_information"])), { project: "public_information" });
check(
  "wiki: страница, версия, файл",
  readWikiRead(parseArgs(["wiki", "p", "Поддержка", "--version", "5", "--out", "a.html"])),
  { project: "p", page: "Поддержка", version: 5, out: "a.html" },
);
check("wiki: проект флагом, страница словом", readWikiRead(parseArgs(["wiki", "--project", "p", "Поддержка"])).page, "Поддержка");
checkThrows("wiki: версия без страницы", () => readWikiRead(parseArgs(["wiki", "p", "--version", "2"])));
checkThrows("wiki: версия не число", () => readWikiRead(parseArgs(["wiki", "p", "X", "--version", "два"])));
checkThrows("wiki: версия 0", () => readWikiRead(parseArgs(["wiki", "p", "X", "--version", "0"])));
checkThrows("wiki: название из нескольких слов без кавычек", () => readWikiRead(parseArgs(["wiki", "p", "Как", "подать"])));
check("wiki-history: по умолчанию 20 версий", readWikiHistory(parseArgs(["wiki-history", "p", "X"])).limit, 20);
check("wiki-history: -n", readWikiHistory(parseArgs(["wiki-history", "p", "X", "-n", "5"])).limit, 5);
checkThrows("wiki-history: без страницы", () => readWikiHistory(parseArgs(["wiki-history", "p"])));
check(
  "wiki-update: разбор",
  readWikiUpdate(
    parseArgs(["wiki-update", "p", "X", "--text-file", "a.html", "--comment", "Порядок подачи", "--yes", "--base-version", "7"]),
  ),
  { project: "p", page: "X", textFile: "a.html", comment: "Порядок подачи", baseVersion: 7 },
);
check(
  "wiki-update: --base-version 0 — страницы не было",
  readWikiUpdate(parseArgs(["wiki-update", "p", "X", "--text-file", "a", "--base-version", "0"])).baseVersion,
  0,
);
checkThrows("wiki-update: без файла", () => readWikiUpdate(parseArgs(["wiki-update", "p", "X"])));
checkThrows("wiki-update: текст строкой не принимается", () => readWikiUpdate(parseArgs(["wiki-update", "p", "X", "--text", "<p>x</p>"])));
checkThrows(
  "wiki-update: --base-version не число",
  () => readWikiUpdate(parseArgs(["wiki-update", "p", "X", "--text-file", "a", "--base-version", "последняя"])),
);
checkThrows("wiki-update: без страницы", () => readWikiUpdate(parseArgs(["wiki-update", "p", "--text-file", "a"])));

// ── wiki: запрос записи ───────────────────────────────────────────────
const putPage = wikiUpdateRequest("public_information", "Как_подать", "<p>Текст</p>", "  Порядок подачи  ", 7);
check("wiki-update: метод и путь", [putPage.method, putPage.path], ["PUT", wikiPath("public_information", "Как_подать")]);
check("wiki-update: тело — текст, комментарий, версия", putPage.body, {
  wiki_page: { text: "<p>Текст</p>", comments: "Порядок подачи", version: 7 },
});
check("wiki-update: новая страница — без версии", wikiUpdateRequest("p", "Новая", "<p>x</p>", undefined, null).body, {
  wiki_page: { text: "<p>x</p>" },
});
checkThrows("wiki-update: пустой текст", () => wikiUpdateRequest("p", "X", "  \n ", undefined, 1));
checkThrows("wiki-update: комментарий длиннее 1024 знаков", () => wikiUpdateRequest("p", "X", "<p>x</p>", "я".repeat(1025), 1));
checkThrows("wiki-update: версия 0 у существующей страницы", () => wikiUpdateRequest("p", "X", "<p>x</p>", undefined, 0));

// ── сравнение текстов ─────────────────────────────────────────────────
const wikiBefore = "<h1>Заявка</h1>\n<p>Старый абзац</p>\n<p>Общий абзац</p>\n";
const wikiAfter = "<h1>Заявка</h1>\n<p>Новый абзац</p>\n<p>Общий абзац</p>\n<p>Добавлено</p>\n";
const wikiDiff = textDiff(wikiBefore, wikiAfter);
check("сравнение: строк убрано и добавлено", [wikiDiff.removedLines, wikiDiff.addedLines], [1, 2]);
check(
  "сравнение: знаков убрано и добавлено",
  [wikiDiff.removedChars, wikiDiff.addedChars],
  ["<p>Старый абзац</p>".length, "<p>Новый абзац</p>".length + "<p>Добавлено</p>".length],
);
check("сравнение: объём до и после", [wikiDiff.beforeChars, wikiDiff.afterChars], [wikiBefore.length, wikiAfter.length]);
check("сравнение: \\r\\n правкой не считается", textDiff("a\r\nb", "a\nb").removedLines, 0);
check("сравнение: хвостовые пробелы не важны", normalizeWikiText("a\r\nb \n\n"), "a\nb");
check("сравнение: одинаковые тексты", formatDiff(textDiff("x\ny", "x\ny")), "(строки совпадают)");
// Страница, сохранённая визуальным редактором, бывает одной строкой: без разреза правка абзаца выглядела бы заменой всего.
check("сравнение: длинная строка HTML режется по абзацам", diffUnits(`<p>${"а".repeat(200)}</p><p>${"б".repeat(200)}</p>`).length, 2);
const wikiDiffText = formatDiff(wikiDiff);
check("сравнение: убранная строка со знаком «-»", wikiDiffText.includes("- <p>Старый абзац</p>"), true);
check("сравнение: добавленная строка со знаком «+»", wikiDiffText.includes("+ <p>Добавлено</p>"), true);
const fifty = Array.from({ length: 50 }, (_, i) => `строка ${i}`).join("\n");
check(
  "сравнение: неизменное свёрнуто",
  formatDiff(textDiff(fifty, fifty.replace("строка 25", "строка двадцать пять"))).includes("… без изменений: 24 строки"),
  true,
);
check("сравнение: сводка словами", diffSummary(wikiDiff).startsWith("убрано строк 1"), true);
check(
  "сравнение: длинное сравнение обрезается, текст — нет",
  formatDiff(textDiff("", Array.from({ length: 200 }, (_, i) => `n${i}`).join("\n")), 10).includes("новый текст целиком ниже"),
  true,
);

// ── разметка, аудитория, доступ ───────────────────────────────────────
check("разметка: html без тегов — предупреждение", markupWarning("html", "Просто текст") !== null, true);
check("разметка: html с тегами — без замечаний", markupWarning("html", "<p>Текст</p>"), null);
check("разметка: textile с HTML — предупреждение", (markupWarning("textile", "<p>Текст</p>") ?? "").includes("теги"), true);
check("разметка: не задана — подсказка detect-markup", (markupWarning(undefined, "<p>x</p>") ?? "").includes("detect-markup"), true);
check("аудитория: публичный проект — строгая проверка", wikiAudience(true, "internal").audience, "client");
check("аудитория: публичный — сказано, что internal не применён", (wikiAudience(true, "internal").note ?? "").includes("не применён"), true);
check("аудитория: закрытый проект — по флагу", wikiAudience(false, "internal").audience, "internal");
check("аудитория: по умолчанию — заказчик", wikiAudience(false, undefined), { audience: "client", note: null });
check("доступ: публичный — видят все с учётной записью", describeWikiAccess(true).includes("все пользователи с учётной записью"), true);

// ── предпросмотр правки страницы ──────────────────────────────────────
const pageV7: WikiPage = {
  title: "Как_подать",
  parent: { title: "Поддержка" },
  version: 7,
  text: wikiBefore,
  author: { id: 5, name: "Светлана Кудрина" },
  comments: "",
  created_on: "2021-10-29T15:41:41Z",
  updated_on: "2026-09-01T09:00:00Z",
};
const wikiCtx: WikiUpdateContext = {
  instance: "ru",
  project: { id: 3078, name: "Общая информация", identifier: "public_information", isPublic: true },
  title: "Как_подать",
  requested: "Как_подать",
  url: "https://r.example/projects/public_information/wiki/Как_подать",
  current: pageV7,
  text: wikiAfter,
  comment: "Новый порядок",
  markup: "html",
  audience: "client",
  audienceNote: null,
  warnings: 0,
  rights: { state: "yes", roles: ["Менеджер"] },
};
const wikiPreviewText = wikiUpdatePreview(wikiCtx);
check("предпросмотр wiki: проект", wikiPreviewText.includes("«Общая информация» (public_information, id=3078)"), true);
check(
  "предпросмотр wiki: текущая версия и автор",
  lineOf(wikiPreviewText, "Сейчас").includes("версия 7") && lineOf(wikiPreviewText, "Сейчас").includes("Светлана Кудрина"),
  true,
);
check("предпросмотр wiki: станет версия 8", lineOf(wikiPreviewText, "Станет").includes("версия 8"), true);
check("предпросмотр wiki: публичный проект назван", lineOf(wikiPreviewText, "Доступ").includes("ПУБЛИЧНЫЙ"), true);
check("предпросмотр wiki: новый текст целиком", wikiPreviewText.includes(wikiAfter.trimEnd()), true);
check("предпросмотр wiki: сравнение с текущей", wikiPreviewText.includes("ИЗМЕНЕНИЯ ОТНОСИТЕЛЬНО ВЕРСИИ 7: убрано строк 1"), true);
check("предпросмотр wiki: откат возможен", wikiPreviewText.includes("Откатить к данной версии"), true);
check("предпросмотр wiki: защита от одновременной правки", wikiPreviewText.includes("Redmine откажет (409)"), true);
check("предпросмотр wiki: комментарий к версии", lineOf(wikiPreviewText, "Комментарий").includes("Новый порядок"), true);
check("предпросмотр wiki: права", lineOf(wikiPreviewText, "Права").includes("«Менеджер»"), true);
const newPageText = wikiUpdatePreview({
  ...wikiCtx,
  current: null,
  title: "Новая_страница",
  requested: "новая страница",
  project: { ...wikiCtx.project, isPublic: false },
});
check("предпросмотр wiki: новая страница названа", newPageText.includes("будет создана новая страница «Новая_страница»"), true);
check(
  "предпросмотр wiki: название приведено к виду Redmine",
  lineOf(newPageText, "Название").includes("«новая страница» → «Новая_страница»"),
  true,
);
check("предпросмотр wiki: у новой страницы нет сравнения", newPageText.includes("ИЗМЕНЕНИЯ"), false);
check("предпросмотр wiki: закрытый проект", lineOf(newPageText, "Доступ").includes("участники проекта"), true);
check(
  "предпросмотр wiki: страница найдена в другом регистре",
  lineOf(wikiUpdatePreview({ ...wikiCtx, requested: "как_ПОДАТЬ" }), "Название").includes("найдена под названием «Как_подать»"),
  true,
);
check("предпросмотр wiki: предупреждение о разметке", wikiUpdatePreview({ ...wikiCtx, text: "без тегов" }).includes("нет ни одного HTML-тега"), true);

// ── версия страницы между предпросмотром и записью ────────────────────
check("версия: совпадает — можно писать", wikiBaseMismatch(7, pageV7, "wiki-update"), null);
check("версия: новой страницы всё ещё нет — можно писать", wikiBaseMismatch(0, null, "wiki-update"), null);
check("версия: страницу изменили", (wikiBaseMismatch(6, pageV7, "wiki-update") ?? "").includes("сейчас версия 7"), true);
check("версия: подсказка с новой версией", (wikiBaseMismatch(6, pageV7, "wiki-update") ?? "").includes("--base-version 7"), true);
check("версия: страницу успели создать", (wikiBaseMismatch(0, pageV7, "wiki-update") ?? "").includes("страницы не было"), true);
check("версия: страницу удалили", (wikiBaseMismatch(7, null, "wiki-update") ?? "").includes("удалили"), true);

// ── сверка после записи страницы ──────────────────────────────────────
const writtenPage: WikiPage = { ...pageV7, version: 8, text: wikiAfter.replace(/\n/g, "\r\n"), comments: "Новый порядок" };
check(
  "сверка wiki: версия выросла, текст и комментарий совпали",
  checkWikiWrite(writtenPage, { text: wikiAfter, comment: "Новый порядок", previousVersion: 7 }).ok,
  true,
);
check(
  "сверка wiki: новой версии нет",
  checkWikiWrite(pageV7, { text: wikiAfter, comment: undefined, previousVersion: 7 }).text.includes("новой версии нет"),
  true,
);
check(
  "сверка wiki: текст другой",
  checkWikiWrite({ ...writtenPage, text: "<p>иное</p>" }, { text: wikiAfter, comment: undefined, previousVersion: 7 }).text.includes(
    "текст на странице отличается",
  ),
  true,
);
check(
  "сверка wiki: страница уже была — записано поверх",
  checkWikiWrite({ ...writtenPage, version: 3 }, { text: wikiAfter, comment: undefined, previousVersion: null }).text.includes(
    "страница уже существовала",
  ),
  true,
);
check(
  "сверка wiki: страница создана",
  checkWikiWrite({ ...writtenPage, version: 1 }, { text: wikiAfter, comment: undefined, previousVersion: null }).text.includes("страница создана"),
  true,
);
check("сверка wiki: страница не читается", checkWikiWrite(null, { text: wikiAfter, comment: undefined, previousVersion: 7 }).ok, false);

// ── отказы по wiki ────────────────────────────────────────────────────
const wikiRefusal = { project: "«Общая информация» (public_information, id=3078)", page: "Как_подать", version: 7 };
const wikiExplained = (status: number, details: string[], action: "list" | "read" | "version" | "update"): string =>
  explainWikiRejection(status, details, { action, ...wikiRefusal }) ?? "";
check("отказ wiki 409: чужая правка цела", wikiExplained(409, [], "update").includes("чужая правка цела"), true);
check("отказ wiki 422: пустой текст", wikiExplained(422, ["Текст не может быть пустым"], "update").includes("текст страницы пуст"), true);
check(
  "отказ wiki 422: длинный комментарий",
  wikiExplained(422, ["Комментарий слишком длинный (не может быть больше 1024 символа)"], "update").includes("длиннее 1024"),
  true,
);
check("отказ wiki 403: запись — право редактирования", wikiExplained(403, [], "update").includes("«Редактирование wiki-страниц»"), true);
check("отказ wiki 403: запись — защищённая страница", wikiExplained(403, [], "update").includes("«Блокирование wiki-страниц»"), true);
check("отказ wiki 403: версии — право истории", wikiExplained(403, [], "version").includes("«Просмотр истории Wiki»"), true);
check("отказ wiki 403: список — модуль или право", wikiExplained(403, [], "list").includes("модуль «Wiki»"), true);
check("отказ wiki 404: нет wiki", wikiExplained(404, [], "list").includes("нет wiki"), true);
check("отказ wiki 404: нет версии", wikiExplained(404, [], "version").includes("Версии 7"), true);
check("отказ wiki: прочее не объясняется", explainWikiRejection(500, [], { action: "update", ...wikiRefusal }), null);

// ── дерево страниц и история версий ───────────────────────────────────
const wikiIndexFixture = [
  { title: "Главная", version: 5 },
  { title: "Как_подать", parent: { title: "Поддержка" }, version: 1 },
  { title: "Поддержка", parent: { title: "Главная" }, version: 6 },
  { title: "Сирота", parent: { title: "Удалённая" }, version: 1 },
];
check(
  "дерево wiki: родитель → дочерние, страница без видимого родителя — в корне",
  wikiTree(wikiIndexFixture).map((x) => `${x.depth}:${x.page.title}`),
  ["0:Главная", "1:Поддержка", "2:Как_подать", "0:Сирота"],
);
const historyRows = wikiHistoryRows([
  { version: 3, page: { ...pageV7, version: 3, text: "abcdef", comments: "правка" }, state: "ok" },
  { version: 2, page: null, state: "missing" },
  { version: 1, page: { ...pageV7, version: 1, text: "abcd", comments: "" }, state: "ok" },
]);
check("история wiki: изменение объёма к предыдущей видимой версии", historyRows[0]?.[3], "6 (+2)");
check("история wiki: удалённая версия", historyRows[1]?.[4], "(версия удалена)");
check("история wiki: у первой версии изменения нет", historyRows[2]?.[3], "4");

// ── закрытие и открытие проекта ───────────────────────────────────────
check("закрытие: разбор", readProjectStatusArgs(parseArgs(["close-project", "ai-testing", "--yes"])), { project: "ai-testing" });
checkThrows("закрытие: без проекта", () => readProjectStatusArgs(parseArgs(["close-project"])));
checkThrows("закрытие: название из двух слов без кавычек", () => readProjectStatusArgs(parseArgs(["close-project", "Lead", "agent"])));
check("закрытие: запрос", projectStatusRequest(9, "close"), { method: "PUT", path: "projects/9/close.json" });
check("открытие: запрос", projectStatusRequest(9, "reopen"), { method: "PUT", path: "projects/9/reopen.json" });
checkThrows("закрытие: номер проекта должен быть положительным", () => projectStatusRequest(0, "close"));
check("статусы проекта словами", [1, 5, 9].map((s) => describeProjectStatus(s)), ["открыт (действующий)", "закрыт — только чтение", "в архиве"]);
check("статус «закрыт» — код 5", PROJECT_STATUS.closed, 5);

// Redmine закрывает self_and_descendants: подпроект второго уровня закроется так же, как дочерний.
const projectTreeFixture = [
  { id: 1, name: "Корень" },
  { id: 2, name: "Дочерний", parent: { id: 1 } },
  { id: 3, name: "Внук", parent: { id: 2 } },
  { id: 4, name: "Чужой" },
  { id: 5, name: "Второй дочерний", parent: { id: 1 } },
];
check("подпроекты: всё дерево, а не только дети", projectDescendants(projectTreeFixture, 1).map((p) => p.id), [2, 5, 3]);
check("подпроекты: у листа их нет", projectDescendants(projectTreeFixture, 3), []);

const closer: RoleInfo = { id: 3, name: "Менеджер", permissions: ["close_project", "edit_wiki_pages"] };
const editor: RoleInfo = { id: 4, name: "Исполнитель", permissions: ["edit_wiki_pages"] };
const rights = (roles: RoleInfo[] | null, permission: string, isPublic: boolean, requiresMember: boolean, admin = false) =>
  rightsFromRoles({ admin, roles, permission, isPublic, requiresMember });
check("права: администратор", rights(null, "close_project", false, true, true).state, "admin");
check("права: роль даёт право", rights([closer, editor], "close_project", false, true), { state: "yes", roles: ["Менеджер"] });
check("права: роли права не дают", rights([editor], "close_project", false, true).state, "no");
check("права: права роли не видны", rights([{ id: 7, name: "Особая", permissions: null }], "close_project", false, true).state, "unknown");
check("права: не участник — закрыть нельзя", rights(null, "close_project", true, true).state, "no");
check("права: не участник публичного — wiki решает роль «Не участник»", rights(null, "edit_wiki_pages", true, false).state, "unknown");
check("права словами: отказ назван заранее", rightsText({ state: "no", roles: ["Исполнитель"] }, CLOSE_PERMISSION).includes("Redmine откажет"), true);

const statusCtx: ProjectStatusContext = {
  instance: "company",
  action: "close",
  project: { id: 1, name: "Корень", identifier: "koren", url: "https://r.example/projects/koren", status: 1 },
  affected: [
    { name: "Дочерний", identifier: "doch" },
    { name: "Внук", identifier: "vnuk" },
  ],
  unchanged: [{ name: "Старый", identifier: "stary" }],
  closedParent: null,
  rights: { state: "yes", roles: ["Менеджер"] },
};
const closeText = projectStatusPreview(statusCtx);
check("предпросмотр закрытия: подпроекты закроются", lineOf(closeText, "Подпроекты").includes("закроются вместе с ним (2)"), true);
check("предпросмотр закрытия: уже закрытые останутся", lineOf(closeText, "Уже закрыты").includes("останутся закрытыми"), true);
check("предпросмотр закрытия: только чтение", closeText.includes("только для чтения"), true);
check("предпросмотр закрытия: задачи не создаются и не меняются", closeText.includes("задачи нельзя создавать, менять"), true);
check("предпросмотр закрытия: время не списывается", closeText.includes("списывать время нельзя"), true);
check("предпросмотр закрытия: невидимые подпроекты тоже", closeText.includes("невидимые владельцу ключа"), true);
check("предпросмотр закрытия: как открыть обратно", closeText.includes("reopen-project koren --instance company"), true);
check("предпросмотр закрытия: нужное право", closeText.includes(CLOSE_PERMISSION), true);
check("предпросмотр закрытия: путь в интерфейсе", closeText.includes(projectStatusUiPath("close")), true);
check(
  "предпросмотр закрытия: без подпроектов",
  lineOf(projectStatusPreview({ ...statusCtx, affected: [], unchanged: [] }), "Подпроекты").includes("нет"),
  true,
);
const reopenText = projectStatusPreview({
  ...statusCtx,
  action: "reopen",
  project: { ...statusCtx.project, status: 5 },
  unchanged: [],
  closedParent: { name: "Родитель", identifier: "rod" },
});
check("предпросмотр открытия: подпроекты откроются", lineOf(reopenText, "Подпроекты").includes("откроются вместе с ним (2)"), true);
check("предпросмотр открытия: и закрытые отдельно раньше", reopenText.includes("отдельно раньше"), true);
check("предпросмотр открытия: закрытый родитель останется закрытым", lineOf(reopenText, "Родитель").includes("останется закрытым"), true);

check("отказ закрытия 403: право и роль", (explainProjectStatusRejection("close", 403, "«Корень»") ?? "").includes("«Менеджер»"), true);
check("отказ закрытия 404: только интерфейс", (explainProjectStatusRejection("close", 404, "«Корень»") ?? "").includes("«Сделать закрытым»"), true);
check("отказ закрытия 404: ничего не изменено", (explainProjectStatusRejection("close", 404, "«Корень»") ?? "").includes("Ничего не изменено"), true);
check("отказ открытия 404: кнопка открытия", (explainProjectStatusRejection("reopen", 404, "«Корень»") ?? "").includes("«Сделать открытым»"), true);
check("отказ закрытия: прочее не объясняется", explainProjectStatusRejection("close", 500, "«Корень»"), null);

check("сверка закрытия: всё закрыто", checkProjectStatus("close", 5, [{ name: "Дочерний", status: 5 }]).ok, true);
check("сверка закрытия: подпроект открыт — расхождение", checkProjectStatus("close", 5, [{ name: "Дочерний", status: 1 }]).text.includes("РАСХОЖДЕНИЕ"), true);
check("сверка открытия: проект всё ещё закрыт", checkProjectStatus("reopen", 5, []).ok, false);
check(
  "сверка: не удалось перечитать — сказано, но не расхождение",
  checkProjectStatus("close", 5, [{ name: "Дочерний", status: null }]),
  { ok: true, text: "Сверка: статус проекта — закрыт — только чтение; подпроекты закрыты: 0 из 1 (не удалось перечитать: «Дочерний»)." },
);

// ── удаление страницы wiki ────────────────────────────────────────────
check("wiki-delete: разбор", readWikiDelete(parseArgs(["wiki-delete", "p", "Сверка_документа", "--yes"])), {
  project: "p",
  page: "Сверка_документа",
});
check(
  "wiki-delete: проект флагом, страница словом",
  readWikiDelete(parseArgs(["wiki-delete", "--project", "p", "Сверка"])).page,
  "Сверка",
);
checkThrows("wiki-delete: без страницы", () => readWikiDelete(parseArgs(["wiki-delete", "p"])));
checkThrows("wiki-delete: без проекта", () => readWikiDelete(parseArgs(["wiki-delete"])));
checkThrows("wiki-delete: название из двух слов без кавычек", () => readWikiDelete(parseArgs(["wiki-delete", "p", "Как", "подать"])));

const deleteReq = wikiDeleteRequest("oneclick33", "Сверка_документа_с_кодом_28092026");
check("wiki-delete: метод DELETE и путь страницы", [deleteReq.method, deleteReq.path], [
  "DELETE",
  wikiPath("oneclick33", "Сверка_документа_с_кодом_28092026"),
]);
check("wiki-delete: удаление идёт без тела запроса", Object.keys(deleteReq), ["method", "path"]);
checkThrows("wiki-delete: пустое название", () => wikiDeleteRequest("p", "   "));

// Точки Redmine из названия выбрасывает молча: «…28.09.2026» хранится как «…28092026».
check("wiki-delete: точки из названия Redmine выбрасывает", wikiTitle("Сверка_документа_с_кодом_28.09.2026"), "Сверка_документа_с_кодом_28092026");

const deletePage: WikiPage = {
  title: "Сверка_документа_с_кодом_28092026",
  version: 3,
  text: "<p>Испорченный заголовок</p>",
  author: { id: 5, name: "Светлана Кудрина" },
  comments: "",
  updated_on: "2026-09-28T09:00:00Z",
  attachments: [{ id: 41, filename: "сверка.xlsx", filesize: 2048 }],
};
const deleteCtx: WikiDeleteContext = {
  instance: "company",
  project: { id: 42, name: "OneClick33", identifier: "oneclick33", isPublic: false },
  requested: "Сверка_документа_с_кодом_28.09.2026",
  page: deletePage,
  url: "https://r.example/projects/oneclick33/wiki/Сверка_документа_с_кодом_28092026",
  versions: 3,
  children: ["Приложение_А", "Приложение_Б"],
  attachments: deletePage.attachments ?? null,
  rights: { state: "yes", roles: ["Менеджер"] },
};
const deleteText = wikiDeletePreview(deleteCtx);
check("предпросмотр удаления: все версии уйдут", lineOf(deleteText, "Уйдёт целиком").includes("версий 3"), true);
check("предпросмотр удаления: вложения названы", lineOf(deleteText, "Вложения").includes("сверка.xlsx"), true);
check(
  "предпросмотр удаления: дочерние не удаляются, а поднимаются на верхний уровень",
  lineOf(deleteText, "Дочерние страницы").includes("НЕ удаляются, станут страницами верхнего уровня"),
  true,
);
check("предпросмотр удаления: приведённое название видно", lineOf(deleteText, "Название").includes("так её хранит Redmine"), true);
check("предпросмотр удаления: текст страницы целиком", deleteText.includes("<p>Испорченный заголовок</p>"), true);
check("предпросмотр удаления: как сохранить текст до удаления", deleteText.includes("--out <файл>"), true);
check("предпросмотр удаления: отдельное подтверждение", deleteText.includes(WIKI_DELETE_CONFIRMATION), true);
check("предпросмотр удаления: откатить нечем", deleteText.includes("откатить нечем"), true);
check("предпросмотр удаления: нужное право", deleteText.includes("«Удаление wiki-страниц»"), true);
check(
  "предпросмотр удаления: без дочерних и вложений",
  lineOf(wikiDeletePreview({ ...deleteCtx, children: [], attachments: [] }), "Дочерние страницы").includes("нет"),
  true,
);
check(
  "предпросмотр удаления: вложения не прочитались — сказано прямо",
  lineOf(wikiDeletePreview({ ...deleteCtx, attachments: null }), "Вложения").includes("прочитать не удалось"),
  true,
);

check(
  "сверка удаления: страницы нет, дочерние поднялись",
  checkWikiDeleted("Сверка", null, [{ title: "Приложение_А", parent: null, exists: true }]),
  {
    ok: true,
    text: "Сверка: страницы «Сверка» в wiki больше нет. Дочерние страницы (1) остались и стали страницами верхнего уровня: «Приложение_А».",
  },
);
check("сверка удаления: без дочерних", checkWikiDeleted("Сверка", null, []), {
  ok: true,
  text: "Сверка: страницы «Сверка» в wiki больше нет.",
});
check(
  "сверка удаления: страница на месте — расхождение",
  checkWikiDeleted("Сверка", { ...deletePage, title: "Сверка" }, []).ok,
  false,
);
check(
  "сверка удаления: дочерняя всё ещё за удалённой — расхождение",
  checkWikiDeleted("Сверка", null, [{ title: "Приложение_А", parent: "Сверка", exists: true }]).text.includes("РАСХОЖДЕНИЕ"),
  true,
);
// Предпросмотр обещает, что дочерние страницы уцелеют: если они исчезли, обещание было неверным.
check(
  "сверка удаления: дочерняя исчезла вместе с родителем — расхождение",
  checkWikiDeleted("Сверка", null, [{ title: "Приложение_А", parent: null, exists: false }]).text.includes("исчезли вместе с родителем"),
  true,
);

const delete403 = explainWikiRejection(403, [], { action: "delete", project: "«OneClick33»", page: "Сверка" }) ?? "";
check("отказ удаления 403: нужно право удаления", delete403.includes("«Удаление wiki-страниц»"), true);
check("отказ удаления 403: право отдельное от правки", delete403.includes("отдельное от «Редактирование wiki-страниц»"), true);
check("отказ удаления 403: страница не изменилась", delete403.includes("Страница не изменилась"), true);
check(
  "отказ удаления 404: ничего не удалено",
  (explainWikiRejection(404, [], { action: "delete", project: "«OneClick33»", page: "Сверка" }) ?? "").includes("Ничего не удалено"),
  true,
);
check(
  "отказ правки 403 не подменён удалением",
  (explainWikiRejection(403, [], { action: "update", project: "«P»", page: "X" }) ?? "").includes("«Редактирование wiki-страниц»"),
  true,
);

// ── вехи (версии) проекта ─────────────────────────────────────────────
check("versions: разбор", readVersions(parseArgs(["versions", "oneclick33"])), { project: "oneclick33" });
check("versions: проект флагом", readVersions(parseArgs(["versions", "--project", "oneclick33"])), { project: "oneclick33" });
checkThrows("versions: без проекта", () => readVersions(parseArgs(["versions"])));
checkThrows("versions: название из двух слов без кавычек", () => readVersions(parseArgs(["versions", "Lead", "agent"])));

check(
  "create-version: полный разбор",
  readCreateVersion(
    parseArgs([
      "create-version", "oneclick33",
      "--name", "1. Обмен с 1С",
      "--due", "2026-12-31",
      "--description", "Двусторонний обмен номенклатурой",
      "--status", "locked",
      "--sharing", "descendants",
      "--yes",
    ]),
  ),
  {
    project: "oneclick33",
    name: "1. Обмен с 1С",
    due: "2026-12-31",
    description: "Двусторонний обмен номенклатурой",
    status: "locked",
    sharing: "descendants",
  },
);
check("create-version: по умолчанию веха открыта и не разделяется", readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0"])), {
  project: "p",
  name: "1.0",
  status: "open",
  sharing: "none",
});
check(
  "create-version: срок из DD.MM.YYYY приводится к ISO",
  readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--due", "31.12.2026"])).due,
  "2026-12-31",
);
check(
  "create-version: описание файлом",
  readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--description-file", "veha.md"])).descriptionFile,
  "veha.md",
);
checkThrows("create-version: без имени", () => readCreateVersion(parseArgs(["create-version", "p"])));
checkThrows("create-version: имя пустой строкой", () => readCreateVersion(parseArgs(["create-version", "p", "--name", "   "])));
checkThrows("create-version: без проекта", () => readCreateVersion(parseArgs(["create-version", "--name", "1.0"])));
checkThrows(
  "create-version: --description и --description-file вместе",
  () => readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--description", "х", "--description-file", "f"])),
);
checkThrows("create-version: --due без значения", () => readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--due"])));
checkThrows("create-version: --status без значения", () => readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--status"])));
checkThrows("create-version: неизвестный статус", () => readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--status", "черновик"])));
checkThrows("create-version: неизвестное разделение", () => readCreateVersion(parseArgs(["create-version", "p", "--name", "1.0", "--sharing", "всем"])));
checkThrows("create-version: лишние слова", () => readCreateVersion(parseArgs(["create-version", "Lead", "agent", "--name", "1.0"])));

check("статус вехи: русский синоним", [versionStatus("Закрыта"), versionStatus("заблокирована")], ["closed", "locked"]);
check("статус вехи: по умолчанию открыта", versionStatus(undefined), "open");
check("разделение вехи: русский синоним", [versionSharing("дерево"), versionSharing("подпроекты")], ["tree", "descendants"]);
check("статус вехи словами", versionStatusName("locked"), "заблокирована");
check("статус вехи с последствиями", describeVersionStatus("locked").includes("новые задачи к ней не привязать"), true);
check("разделение вехи словами", describeVersionSharing("hierarchy").includes("родител"), true);
check("статус вехи: неизвестное значение не выдумывается", versionStatusName("frozen"), "frozen");

// ── вехи: тело запроса ────────────────────────────────────────────────
const versionReq = createVersionRequest("oneclick33", {
  name: "  1. Обмен с 1С  ",
  due: "2026-12-31",
  description: "  Двусторонний обмен  ",
  status: "open",
  sharing: "none",
});
check("create-version: метод и путь", [versionReq.method, versionReq.path], ["POST", "projects/oneclick33/versions.json"]);
check("create-version: тело запроса", versionReq.body, {
  version: { name: "1. Обмен с 1С", status: "open", sharing: "none", due_date: "2026-12-31", description: "Двусторонний обмен" },
});
check(
  "create-version: без срока и описания их нет в теле",
  createVersionRequest(7, { name: "1.0", due: undefined, description: undefined, status: "open", sharing: "none" }).body,
  { version: { name: "1.0", status: "open", sharing: "none" } },
);
check(
  "create-version: описание из одних пробелов не уходит",
  createVersionRequest("p", { name: "1.0", due: undefined, description: "   ", status: "open", sharing: "none" }).body.version,
  { name: "1.0", status: "open", sharing: "none" },
);
checkThrows(
  "create-version: пустое имя",
  () => createVersionRequest("p", { name: "  ", due: undefined, description: undefined, status: "open", sharing: "none" }),
);
checkThrows(
  "create-version: имя длиннее 255 знаков",
  () => createVersionRequest("p", { name: "в".repeat(256), due: undefined, description: undefined, status: "open", sharing: "none" }),
);
checkThrows(
  "create-version: описание длиннее 255 знаков",
  () => createVersionRequest("p", { name: "1.0", due: undefined, description: "я".repeat(256), status: "open", sharing: "none" }),
);
checkThrows(
  "create-version: срок не датой",
  () => createVersionRequest("p", { name: "1.0", due: "31.12.2026", description: undefined, status: "open", sharing: "none" }),
);

// ── вехи: поиск и привязка задачи ─────────────────────────────────────
const versionsFixture: Version[] = [
  { id: 11, name: "1. Обмен с 1С", status: "open", due_date: "2026-10-31", description: "Номенклатура и цены", sharing: "none" },
  { id: 12, name: "2. Личный кабинет", status: "open", due_date: null, description: null, sharing: "descendants" },
  { id: 13, name: "3. Обмен заказами", status: "locked", due_date: "2026-09-20", sharing: "none" },
];
check("веха: по номеру", matchVersion(versionsFixture, "12").name, "2. Личный кабинет");
check("веха: по точному имени", matchVersion(versionsFixture, "1. Обмен с 1С").id, 11);
check("веха: по части имени", matchVersion(versionsFixture, "Личный").id, 12);
check("веха: регистр не важен", matchVersion(versionsFixture, "3. обмен заказами").id, 13);
checkThrows("веха: часть имени подходит двум", () => matchVersion(versionsFixture, "Обмен"));
checkThrows("веха: имени нет", () => matchVersion(versionsFixture, "Витрина"));
// Чужой номер не подставляется молча: иначе Redmine получил бы веху другого проекта.
checkThrows("веха: неизвестный номер не подставляется", () => matchVersion(versionsFixture, "99"));
checkThrows("веха: у проекта вех нет", () => matchVersion([], "1.0"));

check("веха: none снимает", [versionClears("none"), versionClears("нет"), versionClears("снять")], [true, true, true]);
check("веха: имя вехи за снятие не принимается", versionClears("1. Обмен с 1С"), false);
check("привязка: none даёт пустую строку", versionPatchValue("none", versionsFixture), {
  id: "",
  label: "снять — задача останется без вехи",
});
check("привязка: имя даёт номер вехи", versionPatchValue("Личный", versionsFixture).id, 12);
check("привязка: в предпросмотре видно срок", versionPatchValue("1. Обмен", versionsFixture).label.includes("срок 2026-10-31"), true);
check("привязка: срок не задан — так и сказано", versionPatchValue("Личный", versionsFixture).label.includes("срок не задан"), true);
check("привязка: заблокированная веха названа заблокированной", versionPatchValue("13", versionsFixture).label.includes("заблокирована"), true);

check("сверка привязки: веха та же", checkIssueVersion({ id: 11, name: "1. Обмен с 1С" }, 11).startsWith("Сверка:"), true);
check("сверка привязки: веха снята", checkIssueVersion(null, ""), "Сверка: веха с задачи снята.");
check("сверка привязки: снять не удалось", checkIssueVersion({ id: 11, name: "1. Обмен" }, "").includes("РАСХОЖДЕНИЕ"), true);
// Redmine отвечает успехом и на веху, которую не принял: без сверки привязка терялась бы молча.
check("сверка привязки: вехи нет — расхождение", checkIssueVersion(undefined, 11).includes("РАСХОЖДЕНИЕ"), true);
check("сверка привязки: веха другая — расхождение", checkIssueVersion({ id: 12, name: "2. ЛК" }, 11).includes("РАСХОЖДЕНИЕ"), true);

// ── вехи: список ──────────────────────────────────────────────────────
check("вехи: сортировка по сроку, без срока — в конец", sortVersions(versionsFixture).map((v) => v.id), [13, 11, 12]);
check("срок вехи: сегодня", versionDueHint("2026-09-29", "2026-09-29"), "2026-09-29 (сегодня)");
check("срок вехи: просрочен", versionDueHint("2026-09-20", "2026-09-29"), "2026-09-20 (просрочен на 9 дней)");
check("срок вехи: впереди", versionDueHint("2026-10-01", "2026-09-29"), "2026-10-01 (через 2 дня)");
check("срок вехи: не задан", versionDueHint(null, "2026-09-29"), "не задан");
check("задачи вехи: нет", versionCountText({ total: 0, open: 0 }), "нет");
check("задачи вехи: сколько всего и сколько открыто", versionCountText({ total: 9, open: 4 }), "9 (открыто 4)");
check("задачи вехи: не прочитано — не ноль", versionCountText(null), "не прочитано");

const versionCounts = new Map<number, VersionCount>([
  [11, { total: 9, open: 4 }],
  [12, null],
]);
const vRows = versionRows(versionsFixture, versionCounts, "2026-09-29");
check("список вех: первая строка — с ближайшим сроком", vRows[0]?.[0], "3. Обмен заказами");
check("список вех: статус и просроченный срок", [vRows[0]?.[1], vRows[0]?.[2]], ["заблокирована", "2026-09-20 (просрочен на 9 дней)"]);
check("список вех: задачи и описание", [vRows[1]?.[3], vRows[1]?.[4]], ["9 (открыто 4)", "Номенклатура и цены"]);
check("список вех: неизвестное число задач и пустое описание", [vRows[2]?.[3], vRows[2]?.[4]], ["не прочитано", "—"]);

// ── вехи: предпросмотр создания ───────────────────────────────────────
const versionCtx: CreateVersionContext = {
  instance: "company",
  project: { id: 42, name: "OneClick33", identifier: "oneclick33", isPublic: false },
  url: "https://r.example/projects/oneclick33/roadmap",
  name: "4. Витрина каталога",
  due: "2026-11-30",
  description: "Каталог и корзина на витрине",
  status: "open",
  sharing: "none",
  existing: versionsFixture,
  audience: "client",
  warnings: 0,
  rights: { state: "yes", roles: ["Менеджер"] },
};
const versionText = createVersionPreview(versionCtx);
check("предпросмотр вехи: имя и что номер выдаст Redmine", lineOf(versionText, "Веха").includes("номер выдаст Redmine"), true);
check("предпросмотр вехи: срок", lineOf(versionText, "Срок").includes("2026-11-30"), true);
check("предпросмотр вехи: статус с последствиями", lineOf(versionText, "Статус").includes("задачи к ней привязываются"), true);
check("предпросмотр вехи: разделение", lineOf(versionText, "Разделение").includes("только задачи этого проекта"), true);
check("предпросмотр вехи: уже заведённые вехи перечислены", lineOf(versionText, "Уже в проекте").includes("«1. Обмен с 1С»"), true);
check("предпросмотр вехи: нужное право", versionText.includes(MANAGE_VERSIONS_PERMISSION), true);
check("предпросмотр вехи: имя уникально внутри проекта", versionText.includes("уникально внутри проекта"), true);
check("предпросмотр вехи: как привязать задачу", versionText.includes('update-issue <id> --version "4. Витрина каталога"'), true);
check("предпросмотр вехи: правка и удаление только в интерфейсе", versionText.includes("настройки проекта → «Версии»"), true);
check("предпросмотр вехи: закрытый проект — кто увидит", versionText.includes("Проект закрытый"), true);
check(
  "предпросмотр вехи: публичный проект — видно всем",
  createVersionPreview({ ...versionCtx, project: { ...versionCtx.project, isPublic: true } }).includes("видны всем пользователям"),
  true,
);
check(
  "предпросмотр вехи: первая веха проекта",
  lineOf(createVersionPreview({ ...versionCtx, existing: [] }), "Уже в проекте").includes("вех нет"),
  true,
);
check(
  "предпросмотр вехи: похожая веха названа двойником",
  createVersionPreview({ ...versionCtx, name: "1. Обмен с 1С" }).includes("не двойник"),
  true,
);
check(
  "предпросмотр вехи: длинное имя — предупреждение, а не запрет",
  createVersionPreview({ ...versionCtx, name: "в".repeat(VERSION_NAME_SOFT + 1) }).includes("инстанс может отказать"),
  true,
);
check(
  "предпросмотр вехи: предупреждения проверки текста посчитаны",
  lineOf(createVersionPreview({ ...versionCtx, warnings: 2 }), "Проверка").includes("предупреждений 2"),
  true,
);
check(
  "предпросмотр вехи: внутренняя аудитория названа",
  lineOf(createVersionPreview({ ...versionCtx, audience: "internal" }), "Проверка").includes("внутренняя"),
  true,
);
check("предпросмотр вехи: без срока сказано, зачем он", lineOf(createVersionPreview({ ...versionCtx, due: undefined }), "Срок").includes("не задан"), true);

// ── вехи: отказы и сверка ─────────────────────────────────────────────
const v403 = explainVersionRejection(403, [], { action: "create", project: "«OneClick33»", name: "4. Витрина" }) ?? "";
check("отказ вехи 403: нужное право", v403.includes(MANAGE_VERSIONS_PERMISSION), true);
check("отказ вехи 403: ничего не создано", v403.includes("Ничего не создано"), true);
check("отказ вехи 403: путь в интерфейсе", v403.includes("«Новая версия»"), true);
check(
  "отказ списка вех 403: право просмотра задач",
  (explainVersionRejection(403, [], { action: "list", project: "«P»" }) ?? "").includes("«Просмотр задач»"),
  true,
);
check(
  "отказ вехи 422: имя занято",
  (explainVersionRejection(422, ["Name has already been taken"], { action: "create", project: "«P»", name: "1.0" }) ?? "").includes("уже есть"),
  true,
);
check(
  "отказ вехи 422: срок не дата",
  (explainVersionRejection(422, ["Date is invalid"], { action: "create", project: "«P»" }) ?? "").includes("ГГГГ-ММ-ДД"),
  true,
);
check(
  "отказ вехи 422: ответ Redmine приведён как есть",
  (explainVersionRejection(422, ["Something odd"], { action: "create", project: "«P»" }) ?? "").includes("Something odd"),
  true,
);
check(
  "отказ вехи 404: проект недоступен",
  (explainVersionRejection(404, [], { action: "create", project: "«P»", name: "1.0" }) ?? "").includes("Ничего не создано"),
  true,
);
check("отказ вехи: прочее не объясняется", explainVersionRejection(500, [], { action: "create", project: "«P»" }), null);

const wanted = { name: "4. Витрина каталога", due: "2026-11-30", description: "Каталог", status: "open", sharing: "none" } as const;
const createdVersion: Version = {
  id: 14,
  name: "4. Витрина каталога",
  due_date: "2026-11-30",
  description: "Каталог",
  status: "open",
  sharing: "none",
};
check("сверка вехи: поля совпали", checkVersionCreated(createdVersion, { ...wanted }).ok, true);
check("сверка вехи: веха не читается", checkVersionCreated(null, { ...wanted }).ok, false);
check(
  "сверка вехи: срок на инстансе другой",
  checkVersionCreated({ ...createdVersion, due_date: "2026-12-01" }, { ...wanted }).text.includes("срок «2026-12-01»"),
  true,
);
check(
  "сверка вехи: срок пропал",
  checkVersionCreated({ ...createdVersion, due_date: null }, { ...wanted }).text.includes("отправлялся «2026-11-30»"),
  true,
);
check("сверка вехи: имя другое", checkVersionCreated({ ...createdVersion, name: "4 Витрина" }, { ...wanted }).ok, false);
check(
  "сверка вехи: статус другой",
  checkVersionCreated({ ...createdVersion, status: "locked" }, { ...wanted }).text.includes("статус «заблокирована»"),
  true,
);
check("сверка вехи: описание другое", checkVersionCreated({ ...createdVersion, description: "Иное" }, { ...wanted }).ok, false);
// Старый инстанс может не отдать статус и разделение: отсутствие поля — не расхождение.
check("сверка вехи: инстанс не отдал статус — не расхождение", checkVersionCreated({ id: 14, name: "4. Витрина каталога", due_date: "2026-11-30", description: "Каталог" }, { ...wanted }).ok, true);

// ── ключ API не уходит в вывод ────────────────────────────────────────
{
  // Ответ Redmine на users/current.json несёт ключ владельца: он не должен дожить до вывода.
  const raw = JSON.parse(
    '{"id":5,"login":"ivanov","firstname":"Иван","lastname":"Иванов","mail":"i@example.com","admin":false,"api_key":"0123456789abcdef0123456789abcdef01234567","last_login_on":"2026-09-23T10:00:00Z"}',
  ) as Parameters<typeof safeCurrentUser>[0];
  const safe = safeCurrentUser(raw);
  check("whoami: ключа API нет в объекте пользователя", Object.keys(safe).includes("api_key"), false);
  check("whoami: ключа API нет в выводе --json", JSON.stringify(safe).includes("0123456789abcdef"), false);
  check("whoami: известные поля сохранены", safe, { id: 5, login: "ivanov", firstname: "Иван", lastname: "Иванов", mail: "i@example.com", admin: false });
}

// ── замер присутствия по сессиям ──────────────────────────────────────
{
  const human = {
    type: "user", promptSource: "sdk", isMeta: false, isSidechain: false,
    entrypoint: "claude-desktop", timestamp: "2026-09-24T10:00:00.000Z", uuid: "a",
    message: { role: "user", content: "сделай отчёт" },
  };
  check("сессии: обычная реплика человека принимается", isHumanRecord(human), true);

  // Каждая проверка ниже отсекает конкретную ошибку, замеренную на живом каталоге.
  check("сессии: результат инструмента отвергается", isHumanRecord({ ...human, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }), false);
  check("сессии: реплика подагента отвергается", isHumanRecord({ ...human, isSidechain: true }), false);
  check("сессии: песочница local-agent отвергается", isHumanRecord({ ...human, entrypoint: "local-agent" }), false);
  check("сессии: служебная вставка отвергается", isHumanRecord({ ...human, isMeta: true }), false);
  check("сессии: системный источник отвергается", isHumanRecord({ ...human, promptSource: "system" }), false);
  check("сессии: запись без времени отвергается", isHumanRecord({ ...human, timestamp: undefined }), false);
  // turnOrigin появился только в 2.1.280: сравнение «=== human» выбросило бы две трети истории.
  check("сессии: без turnOrigin принимается", isHumanRecord({ ...human, turnOrigin: undefined }), true);
  check("сессии: turnOrigin human принимается", isHumanRecord({ ...human, turnOrigin: "human" }), true);
  check("сессии: turnOrigin peer отвергается", isHumanRecord({ ...human, turnOrigin: "peer" }), false);

  // Отложенное сообщение: человек набрал его, пока ассистент работал. Приходит записью
  // типа attachment и вторым разом обычной записью НЕ появляется — замерено на живом
  // транскрипте: 150 таких текстов, совпадений с обычными записями ноль. Без этой ветки
  // не считалось 38% сообщений человека, а часы при пороге 30 минут занижались на треть.
  const queued = {
    type: "attachment", isSidechain: false, entrypoint: "claude-vscode",
    timestamp: "2026-09-24T10:05:00.000Z", uuid: "q1",
    attachment: {
      type: "queued_command", origin: { kind: "human" },
      prompt: [{ type: "text", text: "MAF не используем тут" }],
    },
  };
  check("сессии: отложенное сообщение человека принимается", isQueuedHumanRecord(queued), true);
  check("сессии: отложенное — текст достаётся из attachment",
    cleanText(recordText(queued as never)), "MAF не используем тут");
  // Извещения среды разработки приходят тем же типом, но помечены не человеком.
  check("сессии: отложенное не от человека отвергается",
    isQueuedHumanRecord({ ...queued, attachment: { ...queued.attachment, origin: { kind: "ide" } } }), false);
  check("сессии: отложенное подагента отвергается", isQueuedHumanRecord({ ...queued, isSidechain: true }), false);
  check("сессии: отложенное из песочницы отвергается", isQueuedHumanRecord({ ...queued, entrypoint: "local-agent" }), false);
  check("сессии: отложенное без времени отвергается", isQueuedHumanRecord({ ...queued, timestamp: undefined }), false);
  // Строгая проверка обычной записи не должна принимать отложенную: у той нет promptSource.
  check("сессии: обычная проверка отложенное не принимает", isHumanRecord(queued), false);
  // Одни служебные вставки — текст пуст, значит запись не попадёт в счёт даже пройдя проверку.
  check("сессии: отложенное из одних вставок IDE даёт пустой текст",
    cleanText(recordText({ attachment: { prompt: [{ type: "text", text: "<ide_opened_file>a.ts</ide_opened_file>" }] } } as never)), "");

  // Напоминание окружения приклеено к началу первой реплики сессии: выбрасывать запись нельзя.
  check("сессии: напоминание вырезается, текст остаётся",
    cleanText("<system-reminder>служебное</system-reminder>\nпоправь отчёт"), "поправь отчёт");
  check("сессии: уведомление о фоновой задаче отбрасывается",
    cleanText("<task-notification>\n<task-id>x</task-id>"), "");
  check("сессии: письмо другой сессии отбрасывается",
    cleanText("Another Claude session sent a message: привет"), "");
  check("сессии: продолжение после сжатия отбрасывается",
    cleanText("This session is being continued from a previous conversation that ran out of context."), "");
  check("сессии: обёртка редактора вырезается",
    cleanText("<ide_selection>кусок</ide_selection> что тут не так"), "что тут не так");
  // Текст человека намеренно не причёсывается: на месте вырезанного блока остаётся пробел,
  // а схлопывание пробелов поломало бы отступы в коде, который люди присылают целыми кусками.
  check("сессии: вставка вырезается, свой текст остаётся",
    cleanText("смотри <pasted_content id=\"1\">много текста</pasted_content> вот это").includes("смотри") &&
      cleanText("смотри <pasted_content id=\"1\">много текста</pasted_content> вот это").includes("вот это") &&
      !cleanText("смотри <pasted_content id=\"1\">много текста</pasted_content> вот это").includes("много текста"), true);

  const msg = (ts: string): HumanMessage => ({ ts, text: "x", uuid: ts, session: "s", cwd: "" });
  const blocks = buildBlocks([msg("2026-09-24T10:00:00Z"), msg("2026-09-24T10:30:00Z"), msg("2026-09-24T14:00:00Z")], 90);
  check("сессии: перерыв больше порога начинает новый блок", blocks.length, 2);
  check("сессии: длительность блока — от первого до последнего", blocks[0]!.hours, 0.5);
  check("сессии: блок из одного сообщения даёт ноль", blocks[1]!.hours, 0);
  const sum = summarize(blocks, 3);
  check("сессии: блоки без длительности считаются отдельно", sum.emptyBlocks, 1);
  check("сессии: часы складываются", sum.hours, 0.5);
  check("сессии: повторы переносятся в сводку", sum.duplicates, 3);
}

// ── объяснение отказа 422 по записи времени ───────────────────────────
{
  const one = (line: string): string => explainTimeEntryRejection([line])[0] ?? "";
  const has = (line: string, word: string): boolean => one(line).includes(word);

  // Ярлык приходит на языке учётной записи Redmine, а не скилла: оба должны узнаваться.
  check("422: Comment cannot be blank узнаётся", has("Comment cannot be blank", "--comment"), true);
  check("422: Комментарий не может быть пустым узнаётся", has("Комментарий не может быть пустым", "--comment"), true);
  check("422: Activity cannot be blank узнаётся", has("Activity cannot be blank", "--activity"), true);
  check("422: Вид деятельности узнаётся", has("Вид деятельности не может быть пустым", "--activity"), true);
  check("422: Date is invalid узнаётся", has("Date is invalid", "--date"), true);
  check("422: Дата имеет неверное значение узнаётся", has("Дата имеет неверное значение", "--date"), true);

  // Главное свойство: по вхождению подстроки не сопоставляем. Пользовательское поле
  // «Часы по договору» этим CLI не отправляется вовсе, и совет «задайте --hours»
  // отправил бы человека по кругу — при уже заданных часах.
  check("422: пользовательское поле не выдаётся за --hours", explainTimeEntryRejection(["Часы по договору не может быть пустым"]).length, 0);
  check("422: пользовательское поле не выдаётся за --comment", explainTimeEntryRejection(["Комментарий руководителя не может быть пустым"]).length, 0);
  check("422: незнакомое сообщение остаётся без догадок", explainTimeEntryRejection(["Something else went wrong"]).length, 0);

  // Одинаковые подсказки не дублируются, разные — сохраняются в порядке появления.
  check("422: повтор одного поля даёт одну подсказку", explainTimeEntryRejection(["Comment cannot be blank", "Комментарий не может быть пустым"]).length, 1);
  check("422: два поля дают две подсказки", explainTimeEntryRejection(["Activity cannot be blank", "Comment cannot be blank"]).length, 2);
  check("422: пустой список отказов — пустой ответ", explainTimeEntryRejection([]).length, 0);
}

// ── файлы к задаче: разбор ввода ──────────────────────────────────────
{
  const LINK = "https://files.example.com/files/inbox/akt.pdf?link=TOKEN-ONE-TIME-0001";
  const input = readAttach(
    parseArgs(["attach", "#25127", "--file", "a.txt", "--url", LINK, "--file", "Акт, сентябрь.pdf", "--note", "Текст"]),
  );
  check("attach: задача из первого слова", input.issue, "#25127");
  // Запятая — часть имени файла, а не разделитель списка, как у --role и --tracker.
  check("attach: --file повторяется, запятая не делит имя", input.files, ["a.txt", "Акт, сентябрь.pdf"]);
  check("attach: --url разобран как адрес", input.links.map((l) => l.host), ["files.example.com"]);
  check("attach: --note принят", input.note, { text: "Текст" });
  check("attach: --note-file принят", readAttach(parseArgs(["attach", "1", "--file", "a", "--note-file", "n.html"])).note, {
    file: "n.html",
  });
  check("attach: без примечания", readAttach(parseArgs(["attach", "1", "--url", LINK])).note, null);

  const fails = (argv: string[]): string => errorText(() => readAttach(parseArgs(argv)));
  check("attach: без задачи — ошибка", fails(["attach", "--file", "a"]).includes("Укажите задачу"), true);
  check("attach: без файлов и ссылок — ошибка", fails(["attach", "7"]).includes("Нечего прикладывать"), true);
  check("attach: лишнее слово — ошибка", fails(["attach", "7", "a.txt"]).includes("Лишние слова"), true);
  check("attach: --file без пути — ошибка", fails(["attach", "7", "--file", "--yes"]).includes("--file без пути"), true);
  check("attach: --note без текста — ошибка", fails(["attach", "7", "--file", "a", "--note"]).includes("--note без текста"), true);
  check(
    "attach: --note и --note-file сразу — ошибка",
    fails(["attach", "7", "--file", "a", "--note", "x", "--note-file", "n.html"]).includes("одним способом"),
    true,
  );
  check("attach: файл дважды — ошибка", fails(["attach", "7", "--file", "a.txt", "--file", "./a.txt"]).includes("дважды"), true);
  check("attach: ссылка дважды — ошибка", fails(["attach", "7", "--url", LINK, "--url", LINK]).includes("дважды"), true);

  // Только https: строка запроса — пропуск к файлу, и в ошибке её быть не должно.
  const plainHttp = fails(["attach", "7", "--url", "http://files.example.com/files/a.pdf?link=TOKEN-HTTP-0002"]);
  check("attach: http отклоняется", plainHttp.includes("только ссылки https"), true);
  check("attach: в отказе по http нет пропуска", plainHttp.includes("TOKEN-HTTP-0002"), false);
  check("attach: в отказе по http есть хост и путь", plainHttp.includes("files.example.com/files/a.pdf"), true);
  const broken = errorText(() => parseLink("https://files example.com/f?link=TOKEN-BROKEN-0003", 2));
  check("attach: неразборчивая ссылка — ошибка с номером флага", broken.includes("--url №2"), true);
  check("attach: неразборчивая ссылка не повторяется в ошибке", broken.includes("TOKEN-BROKEN-0003"), false);

  check(
    "attach: ссылка для человека — хост и путь, без запроса и якоря",
    showLink(new URL("https://files.example.com/files/%D0%B0%D0%BA%D1%82.pdf?link=TOKEN-0004#x")),
    "files.example.com/files/акт.pdf",
  );
  const tokenLink = new URL(LINK);
  check("attach: пропуск в примечании находится", linkInText("Скачать: TOKEN-ONE-TIME-0001", tokenLink), true);
  check("attach: ссылка целиком в примечании находится", linkInText(`см. ${LINK}`, tokenLink), true);
  check("attach: хост и путь в примечании — не пропуск", linkInText("files.example.com/files/inbox/akt.pdf", tokenLink), false);
  check(
    "attach: пропуск вычищается из чужого текста ошибки",
    redactLinks(`fetch failed: ${LINK}`, [tokenLink]).includes("TOKEN-ONE-TIME-0001"),
    false,
  );
}

// ── файлы к задаче: имя и тип по ответу сервера ───────────────────────
{
  // filename* (RFC 5987) главнее filename: только в нём кириллица доходит без потерь.
  check(
    "имя файла: filename* главнее filename",
    dispositionFilename("attachment; filename=\"akt.pdf\"; filename*=UTF-8''%D0%90%D0%BA%D1%82%20%E2%84%965.pdf"),
    "Акт №5.pdf",
  );
  check(
    "имя файла: filename* первым — тот же результат",
    dispositionFilename("attachment; filename*=utf-8''%D0%90%D0%BA%D1%82.pdf; filename=\"akt.pdf\""),
    "Акт.pdf",
  );
  check("имя файла: кавычки и экранирование", dispositionFilename('attachment; filename="a \\"b\\" c.pdf"'), 'a "b" c.pdf');
  check("имя файла: ISO-8859-1 в filename*", dispositionFilename("attachment; filename*=iso-8859-1'fr'%E9t%E9.txt"), "été.txt");
  // Кодировка, которой нет ни в одном рантайме: windows-1251 для этого не годится — свежий Bun её знает,
  // и проверка зависела бы от версии Bun на машине прогона.
  check(
    "имя файла: неизвестная рантайму кодировка — откат на filename",
    dispositionFilename("attachment; filename*=x-no-such-charset''%EE%F2.txt; filename=\"ot.txt\""),
    "ot.txt",
  );
  // Сервер положил UTF-8 в filename как есть, а fetch читает заголовок побайтно.
  const bytewise = String.fromCharCode(...new TextEncoder().encode("отчёт.pdf"));
  check("имя файла: UTF-8 в filename без звёздочки", dispositionFilename(`attachment; filename="${bytewise}"`), "отчёт.pdf");
  check("имя файла: без пробела после ;", dispositionFilename("attachment;filename=plain.txt"), "plain.txt");
  check("имя файла: inline без имени", dispositionFilename("inline"), null);
  check("имя файла: заголовка нет", dispositionFilename(null), null);

  check("имя файла: путь из заголовка отрезается", cleanFileName("../../etc/passwd"), "passwd");
  check("имя файла: путь Windows отрезается", cleanFileName("C:\\Users\\x\\a.txt"), "a.txt");
  check("имя файла: управляющие знаки убираются", cleanFileName("a\u0000b\u001f.txt"), "ab.txt");
  check("имя файла: как сохранит Redmine", redmineFileName('Отчёт: итоги?.pdf'), "Отчёт_ итоги_.pdf");
  check("имя файла: подряд идущие знаки — одно подчёркивание", redmineFileName('a<>"b.txt'), "a_b.txt");
  check("имя файла: из пути ссылки", linkFileName(new URL("https://h.example.com/files/%D0%B0.pdf?link=x")), "а.pdf");
  check("имя файла: у корня ссылки имени нет", linkFileName(new URL("https://h.example.com/?link=x")), null);

  check("тип файла: из Content-Type без параметров", fileType("application/pdf; charset=binary", "x"), "application/pdf");
  check("тип файла: octet-stream уточняется по расширению", fileType("application/octet-stream", "a.pdf"), "application/pdf");
  check("тип файла: без заголовка — по расширению", fileType(null, "отчёт.txt"), "text/plain");
  check("тип файла: незнакомое расширение", fileType(null, "обработка.epf"), "application/octet-stream");

  check("размер: байты", formatBytes(812), "812 Б");
  check("размер: килобайты с запятой", formatBytes(1536), "1,5 КБ");
  check("размер: предел скачивания", formatBytes(LINK_LIMITS.maxBytes), "200 МБ");
}

// ── файлы к задаче: отказы словами ────────────────────────────────────
{
  check("ссылка 410: попросить новую", explainLinkStatus(410, "h/p").includes("Попросите новую ссылку"), true);
  check("ссылка 404: попросить новую", explainLinkStatus(404, "h/p").includes("истекла или уже использована"), true);
  check("ссылка 403: попросить новую", explainLinkStatus(403, "h/p").includes("Попросите новую ссылку"), true);
  check("ссылка 503: повторить позже", explainLinkStatus(503, "h/p").includes("Повторите позже"), true);

  const at = { issue: 25127, instance: "company", uploaded: 0 };
  const file = { name: "Акт.pdf", size: 6 * 1024 * 1024 };
  const said = (status: number, details: string[], stage: "upload" | "attach", extra: Partial<typeof at> = {}): string =>
    explainAttachRejection(status, details, { ...at, ...extra, stage, ...(stage === "upload" ? { file } : {}) }) ?? "";
  check("отказ 403 загрузки: право словами", said(403, ["недостаточно прав у владельца ключа"], "upload").includes("нет права загружать файлы"), true);
  check("отказ 403 привязки: право словами", said(403, [], "attach").includes("нет права менять эту задачу"), true);
  check("отказ 403 привязки: какое право", said(403, [], "attach").includes(ATTACH_PERMISSIONS), true);
  check("отказ 403 привязки: без кода и стека", /HTTP|\bat\s/.test(said(403, [], "attach")), false);
  const tooBigEn = said(422, ["This file cannot be uploaded because it exceeds the maximum allowed file size (5 MB)"], "upload");
  check("отказ 422: предел вложений по-английски", tooBigEn.includes("больше предела вложений"), true);
  check("отказ 422: предел назван", tooBigEn.includes("(5 MB)"), true);
  check("отказ 422: размер файла назван", tooBigEn.includes("6 МБ"), true);
  const tooBigRu = said(422, ["Этот файл нельзя загрузить, так как он превышает максимально допустимый размер (5 МБ)"], "upload");
  check("отказ 422: предел вложений по-русски", tooBigRu.includes("больше предела вложений") && tooBigRu.includes("(5 МБ)"), true);
  check("отказ 422: запрещённое расширение", said(422, ["Attachment extension exe is not allowed"], "upload").includes("расширение запрещено"), true);
  check("отказ 422: незнакомая причина передаётся как есть", said(422, ["Что-то иное"], "upload").includes("Что-то иное"), true);
  check("отказ 413: предел сервера или прокси", said(413, [], "upload").includes("прокси"), true);
  check("отказ 422 привязки: проверка всей задачи", said(422, ["Срок не может быть пустым"], "attach").includes("касается всей задачи"), true);
  check("отказ после загрузки: загруженное не видно в задаче", said(403, [], "attach", { uploaded: 2 }).includes("(2) к задаче не привязаны"), true);
  check("отказ после загрузки: один файл — в единственном числе", said(403, [], "attach", { uploaded: 1 }).includes("загруженный файл к задаче не привязан"), true);
  check("отказ 403 привязки: «не приложено» не повторяется", said(403, [], "attach").includes("не приложены"), false);
  check("отказ 401: ключ", said(401, [], "upload").includes("неверный или отозван"), true);
  check("отказ 500: объяснять нечем", explainAttachRejection(500, [], { ...at, stage: "attach" }), null);

  check("номер вложения из ответа", uploadId(7, "7.ab12"), 7);
  check("номер вложения из токена", uploadId(undefined, "12.ff00"), 12);
  check("номер вложения: токен без номера", uploadId(undefined, "zz"), null);
}

// ── файлы к задаче: права, видимость, предпросмотр ────────────────────
{
  const notes = "«Добавление примечаний»";
  const edit = "«Редактирование задач»";
  const no = { state: "no" as const, roles: ["Наблюдатель"] };
  const yes = { state: "yes" as const, roles: ["Исполнитель"] };
  const unknown = { state: "unknown" as const, roles: [], note: "права ролей этому ключу не видны" };
  const granted = mergeRights([{ permission: notes, check: no }, { permission: edit, check: yes }]);
  check("права вложений: хватает одного из двух", granted.check.state, "yes");
  check("права вложений: названо то право, что есть", granted.permission, edit);
  check("права вложений: неизвестно важнее «нет»", mergeRights([{ permission: notes, check: no }, { permission: edit, check: unknown }]).check.state, "unknown");
  const denied = mergeRights([{ permission: notes, check: no }, { permission: edit, check: no }]);
  check("права вложений: нет обоих — нет, названы оба", [denied.check.state, denied.permission], ["no", ATTACH_PERMISSIONS]);
  check("права вложений: администратор", mergeRights([{ permission: notes, check: no }, { permission: edit, check: { state: "admin", roles: [] } }]).check.state, "admin");

  check("видимость: публичный проект", describeAttachAudience(true, false).includes("ПУБЛИЧНЫЙ"), true);
  check("видимость: приватная задача", describeAttachAudience(false, true).includes("ПРИВАТНАЯ"), true);
  check("видимость: старый инстанс", describeAttachAudience(false, null).includes("не сообщает"), true);

  const ctx: AttachContext = {
    instance: "company",
    issue: { id: 25127, subject: "Сверка остатков", url: "https://redmine.example.com/issues/25127", status: "В работе", isPrivate: false, attachments: 3 },
    project: { id: 77, name: "Пример", identifier: "primer", isPublic: false },
    author: "Иван Петров (ivanov, id=5)",
    rights: { permission: notes, check: yes },
    files: [
      { kind: "file", from: "/tmp/отчёт.txt", name: "отчёт.txt", type: "text/plain", size: 812 },
      {
        kind: "url",
        from: "files.example.com/files/inbox/akt.pdf",
        name: "Акт_ сентябрь.pdf",
        original: "Акт: сентябрь.pdf",
        type: "application/pdf",
        size: 1536,
        kept: false,
      },
    ],
    note: "Акт сверки за сентябрь.",
    audience: "client",
    warnings: 0,
  };
  const text = attachPreview(ctx);
  check("предпросмотр вложений: заголовок", text.startsWith("ВЛОЖЕНИЯ К ЗАДАЧЕ #25127 · инстанс company"), true);
  check("предпросмотр вложений: предупреждение о клиенте", text.includes(ATTACH_AUDIENCE_WARNING), true);
  check("предпросмотр вложений: автор — владелец ключа", text.includes("Иван Петров (ivanov, id=5) — владелец ключа"), true);
  check("предпросмотр вложений: размеры и типы", text.includes("812 Б · text/plain") && text.includes("1,5 КБ · application/pdf"), true);
  check("предпросмотр вложений: переименование видно", text.includes("Акт: сентябрь.pdf → в Redmine «Акт_ сентябрь.pdf»"), true);
  check("предпросмотр вложений: примечание целиком", text.includes("ПРИМЕЧАНИЕ") && text.includes("Акт сверки за сентябрь."), true);
  check("предпросмотр вложений: про одноразовые ссылки", text.includes("ссылки повторно не откроет"), true);
  check("предпросмотр вложений: закрытый проект назван", text.includes("проект закрытый"), true);
  check("предпросмотр вложений: без примечания", attachPreview({ ...ctx, note: null }).includes("Примечания нет"), true);
}

// ── файлы к задаче: сверка после записи ───────────────────────────────
{
  const me = { id: 5, name: "Иван Петров" };
  const a101: IssueAttachment = { id: 101, filename: "отчёт.txt", filesize: 812, author: me };
  const a102: IssueAttachment = { id: 102, filename: "Акт.pdf", filesize: 1536, author: me };
  const journal = (notes: string, ids: number[]): AttachJournal => ({
    id: 900,
    user: me,
    notes,
    details: ids.map((id) => ({ property: "attachment", name: String(id), old_value: null, new_value: "x" })),
  });
  const wanted = {
    files: [
      { name: "отчёт.txt", size: 812, id: 101 },
      { name: "Акт.pdf", size: 1536, id: 102 },
    ],
    before: [50],
    note: "Акт сверки.",
  };
  const ok = checkAttachWrite({ attachments: [{ id: 50, filename: "old", filesize: 1 }, a101, a102], journals: [journal("Акт сверки.\r\n", [101, 102])] }, wanted);
  check("сверка вложений: легли оба", ok.ok, true);
  check("сверка вложений: итог словами", ok.text.includes("в задаче 2 из 2") && ok.text.includes("автор вложений — Иван Петров"), true);
  check("сверка вложений: примечание в той же записи", ok.text.includes("в той же записи истории"), true);

  const missing = checkAttachWrite({ attachments: [a101], journals: [journal("Акт сверки.", [101])] }, wanted);
  check("сверка вложений: не лёг один — расхождение", missing.ok, false);
  check("сверка вложений: какой не лёг", missing.text.includes("РАСХОЖДЕНИЕ") && missing.text.includes("«Акт.pdf» в задаче нет"), true);

  // Есть «Редактирование задач», нет «Добавление примечаний»: файлы легли, текст Redmine молча выбросил.
  const dropped = checkAttachWrite({ attachments: [a101, a102], journals: [journal("", [101, 102])] }, wanted);
  check("сверка вложений: примечание выброшено — расхождение", dropped.ok, false);
  check("сверка вложений: причина названа", dropped.text.includes("«Добавление примечаний»"), true);

  const smaller = checkAttachWrite({ attachments: [a101, { ...a102, filesize: 1000 }], journals: [journal("Акт сверки.", [101, 102])] }, wanted);
  check("сверка вложений: другой размер — расхождение", smaller.ok, false);

  // Старый инстанс не вернул номер: вложение находится по имени и размеру среди новых.
  const byName = checkAttachWrite(
    { attachments: [a101, a102] },
    { files: [{ name: "Акт.pdf", size: 1536, id: null }], before: [101], note: null },
  );
  check("сверка вложений: без номера — по имени и размеру", byName.ok && byName.landed[0]?.id === 102, true);
  const renamed = checkAttachWrite({ attachments: [{ ...a101, filename: "отчет.txt" }] }, { files: [{ name: "отчёт.txt", size: 812, id: 101 }], before: [], note: null });
  check("сверка вложений: другое имя — не расхождение, но сказано", renamed.ok && renamed.text.includes("под другим именем"), true);
  check("сверка вложений: задача не перечиталась", checkAttachWrite(null, wanted).ok, false);
}

// ── файлы к задаче: скачивание по ссылке без сети ─────────────────────
{
  const LINK = new URL("https://files.example.com/files/inbox/akt.pdf?link=TOKEN-FETCH-0005");
  const limits = { ...LINK_LIMITS, maxBytes: 10, headersMs: 30, idleMs: 30, totalMs: 1000 };
  const asyncError = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const calls: { url: string; redirect: string; key: boolean }[] = [];
  const serve =
    (routes: Record<string, () => Response>): Fetcher =>
    async (input, init) => {
      calls.push({ url: input.href, redirect: init.redirect, key: "X-Redmine-API-Key" in init.headers });
      const route = routes[input.pathname];
      return route ? route() : new Response("нет", { status: 404 });
    };

  const fine = await downloadLink(
    LINK,
    limits,
    serve({
      "/files/inbox/akt.pdf": () => new Response(null, { status: 302, headers: { Location: "https://store.example.com/b/1?X-Sig=SIGNED-0006" } }),
      "/b/1": () =>
        new Response("12345", {
          headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''%D0%90%D0%BA%D1%82.pdf" },
        }),
    }),
  );
  check("скачивание: перенаправление на https пройдено", new TextDecoder().decode(fine.bytes), "12345");
  check("скачивание: имя из filename*", fine.name, "Акт.pdf");
  check("скачивание: тип из Content-Type", fine.type, "application/pdf");
  check("скачивание: показан хост и путь исходной ссылки", fine.shown, "files.example.com/files/inbox/akt.pdf");
  check("скачивание: перенаправления — вручную", calls.every((c) => c.redirect === "manual"), true);
  check("скачивание: ключ Redmine хозяину ссылки не уходит", calls.some((c) => c.key), false);

  const downgrade = await asyncError(() =>
    downloadLink(LINK, limits, serve({ "/files/inbox/akt.pdf": () => new Response(null, { status: 302, headers: { Location: "http://store.example.com/b/1?X-Sig=SIGNED-0007" } }) })),
  );
  check("скачивание: перенаправление на http остановлено", downgrade.includes("незащищённый адрес"), true);
  check("скачивание: подпись перенаправления не напечатана", downgrade.includes("SIGNED-0007"), false);

  const byPath = await downloadLink(LINK, limits, serve({ "/files/inbox/akt.pdf": () => new Response("1") }));
  check("скачивание: без Content-Disposition — имя из пути", byPath.name, "akt.pdf");

  const declared = await asyncError(() =>
    downloadLink(LINK, limits, serve({ "/files/inbox/akt.pdf": () => new Response("1", { headers: { "Content-Length": "999999" } }) })),
  );
  check("скачивание: заявленный размер больше предела", declared.includes("больше предела"), true);
  const streamed = await asyncError(() =>
    downloadLink(
      LINK,
      limits,
      serve({
        "/files/inbox/akt.pdf": () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(6));
                controller.enqueue(new Uint8Array(6));
                controller.close();
              },
            }),
          ),
      }),
    ),
  );
  check("скачивание: поток больше предела останавливается", streamed.includes("больше предела"), true);

  const gone = await asyncError(() => downloadLink(LINK, limits, serve({ "/files/inbox/akt.pdf": () => new Response("", { status: 410 }) })));
  check("скачивание: 410 — попросить новую ссылку", gone.includes("Попросите новую ссылку"), true);
  check("скачивание: в отказе нет пропуска", gone.includes("TOKEN-FETCH-0005"), false);

  const hang: Fetcher = (_input, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const slow = await asyncError(() => downloadLink(LINK, limits, hang));
  check("скачивание: сервер молчит — остановка по времени", slow.includes("не ответила за"), true);

  // Bun кладёт полный адрес в свойства ошибки fetch: в текст отказа он попасть не должен.
  const refused: Fetcher = async (input) => {
    throw Object.assign(new Error(`Unable to connect: ${input.href}`), { code: "ConnectionRefused", path: input.href });
  };
  const offline = await asyncError(() => downloadLink(LINK, limits, refused));
  check("скачивание: сетевой сбой — код назван", offline.includes("ConnectionRefused"), true);
  check("скачивание: сетевой сбой — пропуск вычищен", offline.includes("TOKEN-FETCH-0005"), false);
}

// ── файлы к задаче: живой прогон CLI против поддельного Redmine ───────
{
  // Ссылки принимаются только https, поэтому и поддельный сервер — https: сертификат выпускается здесь же
  // на время прогона. Он самоподписанный, и проверку цепочки отключает переменная окружения — только
  // у дочернего процесса CLI. Ни одного запроса за пределы 127.0.0.1 прогон не делает.
  const der = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
    const body = concatBytes(parts);
    const n = body.length;
    const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
    return concatBytes([new Uint8Array([tag, ...len]), body]);
  };
  function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  const oid = (dotted: string): Uint8Array => {
    const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
    const bytes = [40 * a + b];
    for (const n of rest) {
      const group = [n & 0x7f];
      for (let v = n >>> 7; v > 0; v >>>= 7) group.unshift((v & 0x7f) | 0x80);
      bytes.push(...group);
    }
    return der(0x06, new Uint8Array(bytes));
  };
  const integer = (raw: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < raw.length - 1 && raw[start] === 0) start++;
    const body = raw.slice(start);
    return der(0x02, (body[0] ?? 0) & 0x80 ? concatBytes([new Uint8Array([0]), body]) : body);
  };
  const utcTime = (d: Date): Uint8Array =>
    der(0x17, new TextEncoder().encode(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
  const pem = (label: string, bytes: Uint8Array): string =>
    `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END ${label}-----\n`;

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const name = der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, new TextEncoder().encode("localhost")))));
  const algorithm = der(0x30, oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const now = Date.now();
  const tbs = der(
    0x30,
    integer(new Uint8Array([1])),
    algorithm,
    name,
    der(0x30, utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  // Копия — ради типа: WebCrypto принимает только массив поверх обычного ArrayBuffer.
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(tbs)));
  const signature = der(0x30, integer(raw.slice(0, 32)), integer(raw.slice(32)));
  const cert = der(0x30, tbs, algorithm, der(0x03, concatBytes([new Uint8Array([0]), signature])));
  const key = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));

  // ── поддельный Redmine и раздача файлов по одноразовым ссылкам ──
  const API_KEY = "selftest-key-not-a-secret";
  const LINK_TOKEN = "TOKEN-LIVE-ONE-TIME-0008";
  const GONE_TOKEN = "TOKEN-LIVE-EXPIRED-0009";
  const linkBody = new TextEncoder().encode("%PDF-1.4 акт сверки за сентябрь");
  type Seen = { method: string; path: string; query: URLSearchParams; key: string | null; type: string | null; body: Uint8Array };
  const seen: Seen[] = [];
  const served = new Set<string>();
  type Stored = IssueAttachment & { token: string };
  const uploads: Stored[] = [];
  const issues = new Map<number, { attachments: Stored[]; journals: AttachJournal[] }>([
    [7, { attachments: [], journals: [] }],
    [8, { attachments: [], journals: [] }],
    [9, { attachments: [], journals: [] }], // в закрытом проекте 78
  ]);
  const author = { id: 5, name: "Иван Петров" };
  const json = (data: unknown, status = 200): Response => Response.json(data, { status });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: pem("CERTIFICATE", cert), key: pem("PRIVATE KEY", key) },
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      seen.push({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        key: req.headers.get("X-Redmine-API-Key"),
        type: req.headers.get("Content-Type"),
        body,
      });
      const path = url.pathname;

      // Раздача по одноразовой ссылке: второй раз та же ссылка уже не отдаёт файл.
      if (path.startsWith("/files/")) {
        const token = url.searchParams.get("link") ?? "";
        if (token !== LINK_TOKEN || served.has(token)) return new Response("ссылка использована", { status: 410 });
        served.add(token);
        return new Response(linkBody, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="akt.pdf"; filename*=UTF-8''${encodeURIComponent("Акт сверки №5.pdf")}`,
          },
        });
      }
      if (req.headers.get("X-Redmine-API-Key") !== API_KEY) return new Response("", { status: 401 });

      if (path === "/users/current.json") {
        if (url.searchParams.get("include") === "memberships") {
          return json({ user: { id: 5, admin: false, memberships: [{ project: { id: 77, name: "Пример" }, roles: [{ id: 3, name: "Исполнитель" }] }] } });
        }
        return json({ user: { id: 5, login: "ivanov", firstname: "Иван", lastname: "Петров", api_key: "not-for-output" } });
      }
      if (path === "/roles.json") return json({ roles: [{ id: 3, name: "Исполнитель" }] });
      if (path === "/roles/3.json") return json({ role: { id: 3, name: "Исполнитель", permissions: ["view_issues", "add_issue_notes"] } });
      if (path === "/projects/77.json") {
        return json({ project: { id: 77, name: "Пример", identifier: "primer", status: 1, is_public: false } });
      }
      if (path === "/projects/78.json") {
        return json({ project: { id: 78, name: "Архив работ", identifier: "arkhiv", status: 5, is_public: false } });
      }
      if (path === "/uploads.json" && req.method === "POST") {
        if (req.headers.get("Content-Type") !== "application/octet-stream") return new Response("", { status: 406 });
        const filename = url.searchParams.get("filename") ?? "";
        if (filename === "big.bin") {
          return json({ errors: ["This file cannot be uploaded because it exceeds the maximum allowed file size (5 MB)"] }, 422);
        }
        const id = 100 + uploads.length + 1;
        const stored: Stored = { id, filename, filesize: body.length, author, token: `${id}.c0ffee${id}` };
        uploads.push(stored);
        return json({ upload: { id, token: stored.token } }, 201);
      }
      const issueMatch = path.match(/^\/issues\/(\d+)\.json$/);
      const issueId = issueMatch ? Number(issueMatch[1]) : 0;
      const state = issues.get(issueId);
      if (state && req.method === "GET") {
        const include = url.searchParams.get("include") ?? "";
        return json({
          issue: {
            id: issueId,
            subject: "Сверка остатков",
            project: issueId === 9 ? { id: 78, name: "Архив работ" } : { id: 77, name: "Пример" },
            tracker: { id: 1, name: "Задача" },
            status: { id: 2, name: "В работе" },
            priority: { id: 2, name: "Нормальный" },
            author,
            done_ratio: 0,
            is_private: false,
            created_on: "2026-10-01T10:00:00Z",
            updated_on: "2026-10-01T10:00:00Z",
            ...(include.includes("attachments") ? { attachments: state.attachments.map(({ token: _t, ...a }) => a) } : {}),
            ...(include.includes("journals") ? { journals: state.journals } : {}),
          },
        });
      }
      if (state && req.method === "PUT") {
        if (issueId === 8) return new Response("", { status: 403 });
        const patch = (JSON.parse(new TextDecoder().decode(body)) as { issue: { notes?: string; uploads?: { token: string }[] } }).issue;
        const added = (patch.uploads ?? [])
          .map((u) => uploads.find((s) => s.token === u.token))
          .filter((s): s is Stored => s !== undefined);
        state.attachments.push(...added);
        state.journals.push({
          id: 900 + state.journals.length,
          user: author,
          notes: patch.notes ?? "",
          details: added.map((a) => ({ property: "attachment", name: String(a.id), old_value: null, new_value: a.filename })),
        });
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 404 });
    },
  });

  const home = await mkdtemp(join(tmpdir(), "redmine-attach-selftest-"));
  try {
    const base = server.url.href;
    const local = join(home, "отчёт.txt");
    const localBody = new TextEncoder().encode("Сверка остатков на 30.09\n");
    await writeFile(local, localBody);
    const big = join(home, "big.bin");
    await writeFile(big, new Uint8Array(64));
    const link = `${base}files/inbox/akt.pdf?link=${LINK_TOKEN}`;
    const note = "Акт сверки за сентябрь: приложен к задаче, сверка остатков по нему сходится.";

    const cli = async (argv: string[], profileOnly = false): Promise<{ code: number; out: string; err: string }> => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "redmine.ts"), ...argv], {
        cwd: home,
        // Окружение собирается заново: ни конфиг, ни ключи, ни REDMINE_* того, кто запускает проверку, сюда не попадают.
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
          HOME: home,
          USERPROFILE: home,
          ...(profileOnly ? {} : { REDMINE_URL: base, REDMINE_API_KEY: API_KEY }),
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const guardTimer = setTimeout(() => proc.kill(), 30_000);
      const [out, raw, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(guardTimer);
      // Предупреждение рантайма об отключённой проверке сертификата — про сам прогон, а не про CLI.
      const err = raw
        .split("\n")
        .filter((line) => !line.includes("NODE_TLS_REJECT_UNAUTHORIZED"))
        .join("\n");
      return { code, out, err };
    };
    const writes = (from: number): Seen[] => seen.slice(from).filter((s) => s.method !== "GET");
    const linkHits = (): Seen[] => seen.filter((s) => s.path.startsWith("/files/"));
    const leaks = (r: { out: string; err: string }, token: string): boolean => `${r.out}${r.err}`.includes(token);

    // 1. Предпросмотр: задача ссылкой, свой файл и одноразовая ссылка. В Redmine ничего не пишется.
    const mark1 = seen.length;
    const preview = await cli(["attach", `${base}issues/7`, "--file", local, "--url", link, "--note", note]);
    check("attach CLI: предпросмотр завершается без ошибки", [preview.code, preview.err.trim()], [0, ""]);
    check("attach CLI: предпросмотр ничего не пишет", writes(mark1).length, 0);
    check("attach CLI: предпросмотр — заголовок", preview.out.includes("ВЛОЖЕНИЯ К ЗАДАЧЕ #7"), true);
    check("attach CLI: имя из filename*", preview.out.includes("Акт сверки №5.pdf"), true);
    check("attach CLI: размер и тип файла по ссылке", preview.out.includes(`${formatBytes(linkBody.length)} · application/pdf`), true);
    check("attach CLI: размер и тип своего файла", preview.out.includes(`${formatBytes(localBody.length)} · text/plain`), true);
    check("attach CLI: автор — владелец ключа", preview.out.includes("Иван Петров (ivanov, id=5) — владелец ключа"), true);
    check("attach CLI: право найдено по роли", preview.out.includes("«Исполнитель» даёт право «Добавление примечаний»"), true);
    check("attach CLI: предупреждение о клиенте", preview.out.includes(ATTACH_AUDIENCE_WARNING), true);
    check("attach CLI: примечание показано целиком", preview.out.includes(note), true);
    check("attach CLI: предпросмотр просит --yes", preview.out.includes("Ничего не отправлено"), true);
    check("attach CLI: ссылка скачана один раз", linkHits().length, 1);
    check("attach CLI: ключ Redmine хозяину ссылки не ушёл", linkHits().some((s) => s.key !== null), false);
    check("attach CLI: пропуск ссылки не напечатан", leaks(preview, LINK_TOKEN), false);
    check("attach CLI: строка запроса не напечатана", leaks(preview, "link="), false);
    check("attach CLI: ключ API не напечатан", leaks(preview, API_KEY) || leaks(preview, "not-for-output"), false);

    // 2. Повторный предпросмотр в --json: ссылка уже потрачена, берётся копия; пропуска нет и в JSON.
    const again = await cli(["attach", "7", "--file", local, "--url", link, "--note", note, "--json"]);
    check("attach CLI: повторный предпросмотр берёт копию", [again.code, linkHits().length], [0, 1]);
    check("attach CLI: --json без пропуска ссылки", leaks(again, LINK_TOKEN), false);
    const againJson = ((): unknown => {
      try {
        return JSON.parse(again.out);
      } catch {
        return null; // Не JSON — проверка ниже провалится словами, а не обрушит самопроверку.
      }
    })();
    check("attach CLI: --json — это предпросмотр", (againJson as { dryRun?: boolean } | null)?.dryRun, true);

    // 3. Запись: ровно две загрузки и одна правка задачи; ссылка повторно не открывается.
    const mark3 = seen.length;
    const sent = await cli(["attach", "7", "--file", local, "--url", link, "--note", note, "--yes"]);
    const done = writes(mark3);
    check("attach CLI: запись завершается без ошибки", [sent.code, sent.err.trim()], [0, ""]);
    check(
      "attach CLI: уходят ровно две загрузки и одна правка задачи",
      done.map((s) => `${s.method} ${s.path}${s.query.get("filename") ? ` ${s.query.get("filename")}` : ""}`),
      ["POST /uploads.json отчёт.txt", "POST /uploads.json Акт сверки №5.pdf", "PUT /issues/7.json"],
    );
    check("attach CLI: загрузка — байтами octet-stream", done.slice(0, 2).map((s) => s.type), ["application/octet-stream", "application/octet-stream"]);
    check("attach CLI: загрузка — ключом владельца", done.every((s) => s.key === API_KEY), true);
    // Без «!»: если запросов меньше ожидаемого, проверки должны провалиться словами, а не обрушить самопроверку.
    const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && Buffer.from(a).equals(Buffer.from(b));
    check("attach CLI: свой файл ушёл байт в байт", sameBytes(done[0]?.body, localBody), true);
    check("attach CLI: файл по ссылке ушёл байт в байт", sameBytes(done[1]?.body, linkBody), true);
    type PutBody = { issue?: { notes?: string; uploads?: { token: string; filename: string; content_type: string }[] } };
    const putBody = ((): PutBody | null => {
      try {
        return JSON.parse(new TextDecoder().decode(done[2]?.body)) as PutBody;
      } catch {
        return null;
      }
    })();
    check("attach CLI: примечание в той же правке", putBody?.issue?.notes, note);
    check(
      "attach CLI: токены загрузок, имена и типы в правке",
      putBody?.issue?.uploads,
      [
        { token: uploads[0]?.token, filename: "отчёт.txt", content_type: "text/plain" },
        { token: uploads[1]?.token, filename: "Акт сверки №5.pdf", content_type: "application/pdf" },
      ],
    );
    check("attach CLI: ссылка повторно не открывалась", linkHits().length, 1);
    check("attach CLI: сверка после записи", sent.out.includes("Сверка: в задаче 2 из 2") && sent.out.includes("в той же записи истории"), true);
    check("attach CLI: после записи пропуска в выводе нет", leaks(sent, LINK_TOKEN), false);
    check(
      "attach CLI: копия скачанного удалена после записи",
      await readdir(join(home, ".redmine", "attach")).catch(() => ["(каталога копий нет — предпросмотр ничего не сохранил)"]),
      [],
    );

    // 4. Истёкшая ссылка: словами и с просьбой о новой; ничего не пишется.
    const mark4 = seen.length;
    const expired = await cli(["attach", "7", "--url", `${base}files/inbox/old.pdf?link=${GONE_TOKEN}`]);
    check("attach CLI: истёкшая ссылка — отказ", expired.code, 1);
    check("attach CLI: истёкшая ссылка — попросить новую", expired.err.includes("Попросите новую ссылку"), true);
    check("attach CLI: истёкшая ссылка — пропуск не напечатан", leaks(expired, GONE_TOKEN), false);
    check("attach CLI: истёкшая ссылка — ничего не записано", writes(mark4).length, 0);

    // 5. Нет права менять задачу (403 на правку): словами, без кода и стека.
    const mark5 = seen.length;
    const forbidden = await cli(["attach", "8", "--file", local, "--yes"]);
    check("attach CLI: 403 — отказ", forbidden.code, 1);
    check("attach CLI: 403 — право словами", forbidden.err.includes("нет права менять эту задачу") && forbidden.err.includes(ATTACH_PERMISSIONS), true);
    check("attach CLI: 403 — без сырого ответа и стека", /HTTP 403|\n\s+at /.test(forbidden.err), false);
    check("attach CLI: 403 — загрузка была, правка отклонена", writes(mark5).map((s) => s.method), ["POST", "PUT"]);

    // 6. Файл больше предела вложений Redmine (422 на загрузке): словами, правка задачи не уходит.
    const mark6 = seen.length;
    const tooBig = await cli(["attach", "7", "--file", big, "--yes"]);
    check("attach CLI: 422 — отказ", tooBig.code, 1);
    check("attach CLI: 422 — предел словами", tooBig.err.includes("больше предела вложений") && tooBig.err.includes("(5 MB)"), true);
    check("attach CLI: 422 — правка задачи не ушла", writes(mark6).map((s) => s.method), ["POST"]);

    // 7. Ссылка http: отказ до любого запроса, пропуск не печатается.
    const mark7 = seen.length;
    const insecure = await cli(["attach", "7", "--url", `http://127.0.0.1:${server.port}/files/x.pdf?link=TOKEN-LIVE-HTTP-0010`]);
    check("attach CLI: http — отказ до сети", [insecure.code, seen.length - mark7], [1, 0]);
    check("attach CLI: http — пропуск не напечатан", leaks(insecure, "TOKEN-LIVE-HTTP-0010"), false);

    // 8. Ссылка в примечании и запрещённый текст останавливаются до скачивания: ссылка не тратится.
    const fresh = `${base}files/inbox/new.pdf?link=TOKEN-LIVE-FRESH-0011`;
    const leaked = await cli(["attach", "7", "--url", fresh, "--note", `Файл: ${fresh}`]);
    check("attach CLI: ссылка в примечании — отказ", [leaked.code, leaked.err.includes("одноразовая ссылка")], [1, true]);
    check("attach CLI: ссылка в примечании — пропуск не напечатан", leaks(leaked, "TOKEN-LIVE-FRESH-0011"), false);
    const secretNote = await cli(["attach", "7", "--url", fresh, "--note", "Пароль от админки: Zx9kLm2025q"]);
    check("attach CLI: запрещённый текст примечания — отказ", [secretNote.code, secretNote.err.includes("Отправка остановлена")], [1, true]);
    check("attach CLI: до скачивания дело не дошло", linkHits().filter((s) => s.path.endsWith("new.pdf")).length, 0);

    // 9. Имя файла видно в задаче так же, как текст, и проходит ту же проверку.
    const mark9 = seen.length;
    const leakyName = join(home, "пароль Zx9kLm2025q.txt");
    await writeFile(leakyName, "x");
    const named = await cli(["attach", "7", "--file", leakyName, "--yes"]);
    check("attach CLI: запрещённое имя файла — отказ", [named.code, named.err.includes("Отправка остановлена")], [1, true]);
    check("attach CLI: запрещённое имя файла — поле названо", named.err.includes("(имена файлов)"), true);
    check("attach CLI: запрещённое имя файла — ничего не записано", writes(mark9).length, 0);

    // 10. Задача в закрытом проекте: только чтение — остановка до любой записи.
    const mark10 = seen.length;
    const closed = await cli(["attach", "9", "--file", local, "--yes"]);
    check("attach CLI: закрытый проект — отказ до записи", [closed.code, closed.err.includes("закрыт"), writes(mark10).length], [1, true, 0]);
    check("attach CLI: закрытый проект — подсказка reopen-project", closed.err.includes("reopen-project arkhiv"), true);

    // 11. Ссылка на задачу выбирает инстанс сама. Второй профиль — на зарезервированном домене .invalid:
    // даже ошибка в коде не увела бы запрос к настоящему серверу.
    await mkdir(join(home, ".redmine"), { recursive: true });
    await writeFile(
      join(home, ".redmine", "config.json"),
      JSON.stringify({
        default: "second",
        instances: { first: { url: base, apiKey: API_KEY }, second: { url: "https://second.redmine.invalid/", apiKey: "other" } },
      }),
    );
    const mark11 = seen.length;
    const switched = await cli(["attach", `${base}issues/7`, "--file", local], true);
    check("attach CLI: ссылка на задачу переключает инстанс", [switched.code, switched.out.includes("ВЛОЖЕНИЯ К ЗАДАЧЕ #7 · инстанс first")], [0, true]);
    check("attach CLI: после переключения — ничего не записано", writes(mark11).length, 0);
    const conflict = await cli(["attach", `${base}issues/7`, "--file", local, "--instance", "second"], true);
    check("attach CLI: ссылка и --instance спорят — отказ", [conflict.code, conflict.err.includes("ведёт на инстанс first, а --instance задаёт second")], [1, true]);
    await removePath(join(home, ".redmine", "config.json"), { force: true });
  } finally {
    server.stop(true);
    await removePath(home, { recursive: true, force: true });
  }
}

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Проверок пройдено: ${passed}`);
if (failures.length > 0) {
  console.error(`\nНе прошло: ${failures.length}`);
  for (const f of failures) console.error(`  — ${f}`);
  process.exit(1);
}
console.log("Самопроверка пройдена.");

/**
 * Замер присутствия по транскриптам сессий Claude Code и Codex.
 *
 * Сестра `harvest`: та меряет по окнам коммитов, эта — по сообщениям человека. Нужна для работы,
 * не оставившей следа в git: разбор, постановка задач, переписка с заказчиком, настройка систем.
 *
 * ЧТО ЭТО МЕРЯЕТ. Присутствие, а не трудозатраты. Внутри отрезка человек мог отвлекаться, а блок
 * из одного сообщения даёт ноль. Поэтому рядом с часами всегда стоят число сообщений, число дней
 * и число блоков нулевой длины — они устойчивее и показывают, чего в часах нет.
 *
 * ПОЧЕМУ ОТБОР ТАКОЙ СЛОЖНЫЙ. Всё, что ниже, получено замером на живом каталоге, а не из описания
 * формата, и каждое условие отсекает конкретную ошибку:
 *
 *   - Обход строго одного уровня `projects/*\/*.jsonl`. Рекурсивный обход затягивает транскрипты
 *     подагентов и журналы воркфлоу — на замерянной машине 192 файла против 9 настоящих сессий,
 *     и счёт сообщений вырастает со 414 до 847.
 *   - `promptSource === "sdk"` отсекает служебные вставки, но НЕ все: на клиентах 2.1.270 и 2.1.273
 *     уведомления о фоновых задачах приходили с тем же значением и без признаков. Их ловит только
 *     проверка текста. Поэтому проверка полей и проверка текста обе обязательны.
 *   - `turnOrigin` появился лишь в 2.1.280. Сравнение `turnOrigin === "human"` выбрасывает две трети
 *     истории, поэтому условие — «отсутствует или human».
 *   - `entrypoint` обязан быть claude-desktop или claude-vscode: у песочниц режима local-agent
 *     совпадают все прочие признаки, и отличить их больше нечем.
 *   - Дедупликация по `uuid`: при перемотке разговора записи дублируются, замерено 8,9%.
 *
 * ЧТО ЭТИ ЧИСЛА НЕ ПОКРЫВАЮТ. Работу вне инструмента, звонки, машинное время, и всё, что старше
 * срока хранения транскриптов: клиент чистит их сам, и отсутствие файлов не значит отсутствия работы.
 * Команда печатает границы собственного окна — по ним и судить.
 */

export type HumanMessage = {
  /** Мгновение в UTC, как записано клиентом. */
  ts: string;
  text: string;
  uuid: string;
  session: string;
  cwd: string;
  /** Чей транскрипт: Claude Code или Codex. Замер общий, источник виден в выводе. */
  client: Client;
};

export type Client = "claude" | "codex";

export type Block = {
  start: string;
  end: string;
  /** Часы присутствия: конец минус начало. Для блока из одного сообщения — ноль. */
  hours: number;
  messages: HumanMessage[];
};

export type Summary = {
  hours: number;
  messages: number;
  days: string[];
  blocks: number;
  /** Блоки из одного сообщения: присутствие в них не измеряется, и это надо видеть. */
  emptyBlocks: number;
  from: string;
  to: string;
  sessions: number;
  duplicates: number;
};

/** Разрешённые точки входа. Всё прочее — песочницы и служебные прогоны, они не человек. */
const ENTRYPOINTS = new Set(["claude-desktop", "claude-vscode"]);

/**
 * Блоки, которые вырезаются ИЗ текста, а не служат поводом выбросить запись.
 * Напоминание окружения приклеивается к началу первого сообщения сессии: правило «начинается с»
 * выбросило бы первую реплику каждой сессии целиком.
 */
const STRIP = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g,
  /<ide_selection>[\s\S]*?<\/ide_selection>/g,
  /<ide_diagnostics>[\s\S]*?<\/ide_diagnostics>/g,
  /<pasted_content[\s\S]*?<\/pasted_content>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

/** Начала, по которым запись отбрасывается ПОСЛЕ очистки: это не речь человека. */
const DROP_PREFIXES = [
  "<task-notification>",
  "<command-message>",
  "<command-name>",
  "<skill-format>",
  "Another Claude session sent a message",
  "This session is being continued from a previous conversation",
  "Base directory for this skill:",
  "[Image:",
  "[Request interrupted",
  "Caveat: The messages below",
  "# Workflow authoring reference",
];

type Record_ = {
  type?: string;
  isMeta?: unknown;
  isSidechain?: unknown;
  promptSource?: unknown;
  turnOrigin?: unknown;
  entrypoint?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  message?: { role?: string; content?: unknown };
  attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string } };
};

/** Проверка по полям. Необходима, но недостаточна: текст проверяется отдельно. */
export function isHumanRecord(record: unknown): record is Record_ {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record_;
  if (r.type !== "user") return false;
  if (r.isMeta) return false;
  if (r.isSidechain === true) return false;
  if (r.promptSource !== "sdk") return false;
  if (r.turnOrigin !== undefined && r.turnOrigin !== null && r.turnOrigin !== "human") return false;
  if (typeof r.entrypoint !== "string" || !ENTRYPOINTS.has(r.entrypoint)) return false;
  if (typeof r.timestamp !== "string" || !r.timestamp) return false;
  const content = r.message?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  // Результат инструмента приходит записью с ролью пользователя — это 95% таких записей.
  return !content.some((p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "tool_result");
}

/**
 * Сообщение, набранное человеком, ПОКА ассистент работал. Оно приходит записью типа
 * "attachment" с вложением queued_command и не появляется вторым разом обычной записью:
 * подаётся внутри идущего хода. Поэтому без этой проверки такие сообщения не считались
 * вовсе — на одном транскрипте 150 из 400 с лишним.
 *
 * Считаем только помеченные origin.kind = "human". Остальные queued_command — служебные
 * извещения среды разработки (какой файл открыт, что выделено); текст у них отсеется и
 * в cleanText, но отбрасывать их здесь дешевле и честнее по смыслу.
 *
 * Поля promptSource и turnOrigin у таких записей отсутствуют, поэтому строгая проверка
 * обычной записи для них не годится и ослаблять её нельзя — нужна отдельная.
 */
export function isQueuedHumanRecord(record: unknown): record is Record_ {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record_;
  if (r.type !== "attachment") return false;
  if (r.isSidechain === true) return false;
  if (r.attachment?.type !== "queued_command") return false;
  if (r.attachment?.origin?.kind !== "human") return false;
  if (typeof r.entrypoint !== "string" || !ENTRYPOINTS.has(r.entrypoint)) return false;
  if (typeof r.timestamp !== "string" || !r.timestamp) return false;
  return Array.isArray(r.attachment?.prompt);
}

export function recordText(record: { message?: { content?: unknown }; attachment?: { prompt?: unknown } }): string {
  // У отложенного сообщения текст лежит в attachment.prompt тем же набором частей {type,text}.
  const content = record.message?.content ?? record.attachment?.prompt;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
    .join("");
}

/** Очистка текста. Пустая строка на выходе означает «человек этого не писал». */
export function cleanText(raw: string): string {
  let text = raw;
  for (const rx of STRIP) text = text.replace(rx, " ");
  text = text.trim();
  if (!text) return "";
  for (const prefix of DROP_PREFIXES) if (text.startsWith(prefix)) return "";
  return text;
}

/** Файлы транскриптов сессий: ровно один уровень вложенности, ничего глубже. */
export async function claudeSessionFiles(home: string): Promise<string[]> {
  const root = `${home}/.claude/projects`;
  const out: string[] = [];
  const { readdirSync, existsSync } = await import("node:fs");
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(`${root}/${dir.name}`, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) out.push(`${root}/${dir.name}/${file.name}`);
    }
  }
  return out.sort();
}

export async function readClaudeMessages(files: string[]): Promise<{ messages: HumanMessage[]; duplicates: number }> {
  const seen = new Set<string>();
  const messages: HumanMessage[] = [];
  let duplicates = 0;

  for (const path of files) {
    const text = await Bun.file(path).text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // Битая строка — пропускаем молча: одна запись картины не меняет.
      }
      if (!isHumanRecord(record) && !isQueuedHumanRecord(record)) continue;
      const r = record as Record_;
      const uuid = String(r.uuid ?? "");
      if (uuid && seen.has(uuid)) {
        duplicates++;
        continue;
      }
      if (uuid) seen.add(uuid);
      const clean = cleanText(recordText(r));
      if (!clean) continue;
      messages.push({
        ts: String(r.timestamp),
        text: clean,
        uuid,
        session: String(r.sessionId ?? ""),
        cwd: String(r.cwd ?? ""),
        client: "claude",
      });
    }
  }
  messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { messages, duplicates };
}


// ── Codex ─────────────────────────────────────────────────────────────
//
// Формат замерен на живом каталоге ~/.codex/sessions (Codex Desktop и расширение VS Code,
// версии 0.154–0.171, 19 файлов), а не взят из описания:
//
//   - Файлы лежат по датам: sessions/ГГГГ/ММ/ДД/rollout-*.jsonl. Обход рекурсивный, но берутся
//     только rollout-*.jsonl.
//   - Подагенты пишут СВОИ файлы, и в заголовке session_meta у них source — объект
//     ({subagent: …}), у человека — строка. На замерянной машине 13 файлов из 19 — подагенты
//     проверки; их 179 «реплик пользователя» — промпты подагенту, а не человек.
//   - Реплика человека — событие item_completed с item.type = "UserMessage". Записи
//     response_item с ролью user для счёта не годятся: в них же приходят вставки окружения
//     (environment_context, AGENTS.md, контекст редактора) — 251 запись против 98 настоящих.
//   - Ответ человека на вопрос ассистента приходит той же UserMessage в обёртке
//     <send_user_message_question_reply> с JSON внутри: это действие человека, оно считается,
//     а текстом служат сами ответы.
//   - Приложенные файлы дают префикс «# Files mentioned by the user: … ## My request:»: текст
//     человека — после него.

/** Файлы транскриптов Codex: sessions/ГГГГ/ММ/ДД/rollout-*.jsonl. */
export async function codexSessionFiles(home: string): Promise<string[]> {
  const root = `${home}/.codex/sessions`;
  const { readdirSync, existsSync } = await import("node:fs");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(root, 0);
  return out.sort();
}

type CodexLine = {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    id?: unknown;
    cwd?: unknown;
    source?: unknown;
    item?: { type?: unknown; id?: unknown; content?: unknown };
  };
};

/** Заголовок сессии Codex: подагент или человек. У подагента source — объект. */
export function isCodexSubagentMeta(line: unknown): boolean {
  const r = line as CodexLine;
  return r?.type === "session_meta" && typeof r.payload?.source === "object" && r.payload?.source !== null;
}

/** Реплика человека в Codex: событие item_completed с UserMessage и временем. */
export function isCodexHumanLine(line: unknown): boolean {
  if (typeof line !== "object" || line === null) return false;
  const r = line as CodexLine;
  if (r.type !== "event_msg") return false;
  if (r.payload?.type !== "item_completed") return false;
  if (r.payload?.item?.type !== "UserMessage") return false;
  return typeof r.timestamp === "string" && r.timestamp !== "";
}

/** Текст реплики Codex: части text, ответы на вопросы и запрос после списка файлов. */
export function codexText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const raw = content
    .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
    .join("");
  const reply = raw.match(/<send_user_message_question_reply>([\s\S]*?)(?:<\/send_user_message_question_reply>|$)/);
  if (reply) {
    try {
      const items = JSON.parse(reply[1]!.trim()) as { answer?: unknown }[];
      return items.map((i) => String(i.answer ?? "")).filter(Boolean).join(" · ");
    } catch {
      return ""; // Обёртка без читаемого JSON — человеческого текста в ней не найти.
    }
  }
  const marker = "## My request:";
  const at = raw.indexOf(marker);
  if (raw.trimStart().startsWith("# Files mentioned by the user") && at !== -1) return raw.slice(at + marker.length).trim();
  return raw.trim();
}

export async function readCodexMessages(files: string[]): Promise<{ messages: HumanMessage[]; duplicates: number }> {
  const seen = new Set<string>();
  const messages: HumanMessage[] = [];
  let duplicates = 0;
  for (const path of files) {
    let session = "";
    let cwd = "";
    let subagent = false;
    for (const line of (await Bun.file(path).text()).split("\n")) {
      if (!line.startsWith("{")) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const r = record as CodexLine;
      if (r.type === "session_meta") {
        subagent = isCodexSubagentMeta(r);
        session = String(r.payload?.id ?? "");
        cwd = String(r.payload?.cwd ?? "");
        continue;
      }
      if (subagent || !isCodexHumanLine(r)) continue;
      const id = String(r.payload?.item?.id ?? "");
      if (id && seen.has(id)) {
        duplicates++;
        continue;
      }
      if (id) seen.add(id);
      const text = cleanText(codexText(r.payload?.item?.content));
      if (!text) continue;
      messages.push({ ts: String(r.timestamp), text, uuid: id, session, cwd, client: "codex" });
    }
  }
  return { messages, duplicates };
}

/** Все транскрипты обоих клиентов, отобранные по --client. */
export async function sessionFiles(home: string, clients: Client[]): Promise<{ claude: string[]; codex: string[] }> {
  return {
    claude: clients.includes("claude") ? await claudeSessionFiles(home) : [],
    codex: clients.includes("codex") ? await codexSessionFiles(home) : [],
  };
}

/** Сообщения человека из обоих клиентов, по времени. */
export async function readHumanMessages(files: { claude: string[]; codex: string[] }): Promise<{ messages: HumanMessage[]; duplicates: number }> {
  const a = await readClaudeMessages(files.claude);
  const b = await readCodexMessages(files.codex);
  const messages = [...a.messages, ...b.messages].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  return { messages, duplicates: a.duplicates + b.duplicates };
}

/**
 * Резка на блоки по перерыву. Границы файлов и сессий не участвуют: один файл здесь
 * покрывает до 17 дней, а один рабочий вечер разложен по нескольким файлам.
 */
export function buildBlocks(messages: HumanMessage[], gapMinutes: number): Block[] {
  if (messages.length === 0) return [];
  const gap = gapMinutes * 60_000;
  const blocks: Block[] = [];
  let current: HumanMessage[] = [messages[0]!];
  for (let i = 1; i < messages.length; i++) {
    const prev = new Date(messages[i - 1]!.ts).getTime();
    const now = new Date(messages[i]!.ts).getTime();
    if (now - prev > gap) {
      blocks.push(toBlock(current));
      current = [messages[i]!];
    } else current.push(messages[i]!);
  }
  blocks.push(toBlock(current));
  return blocks;
}

function toBlock(items: HumanMessage[]): Block {
  const start = items[0]!.ts;
  const end = items[items.length - 1]!.ts;
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return { start, end, hours: Math.round(hours * 100) / 100, messages: items };
}

/** Местная дата мгновения. День режется по часам машины: в UTC вечер уезжает на завтра. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function summarize(blocks: Block[], duplicates: number): Summary {
  const days = new Set<string>();
  const sessions = new Set<string>();
  let hours = 0;
  let messages = 0;
  let emptyBlocks = 0;
  for (const b of blocks) {
    hours += b.hours;
    messages += b.messages.length;
    if (b.messages.length < 2) emptyBlocks++;
    for (const m of b.messages) {
      days.add(localDay(m.ts));
      if (m.session) sessions.add(m.session);
    }
  }
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  return {
    hours: Math.round(hours * 100) / 100,
    messages,
    days: [...days].sort(),
    blocks: blocks.length,
    emptyBlocks,
    from: first ? localDay(first.start) : "—",
    to: last ? localDay(last.end) : "—",
    sessions: sessions.size,
    duplicates,
  };
}

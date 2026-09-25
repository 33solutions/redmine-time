/**
 * Замер присутствия по транскриптам сессий Claude Code.
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
};

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

export function recordText(record: { message?: { content?: unknown } }): string {
  const content = record.message?.content;
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
export async function sessionFiles(home: string): Promise<string[]> {
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

export async function readHumanMessages(files: string[]): Promise<{ messages: HumanMessage[]; duplicates: number }> {
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
      if (!isHumanRecord(record)) continue;
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
      });
    }
  }
  messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { messages, duplicates };
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

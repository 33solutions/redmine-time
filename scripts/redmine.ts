#!/usr/bin/env bun
/**
 * Redmine CLI — трудозатраты, задачи, входящие события, отчёты.
 * Bun + TypeScript, нулевые зависимости, нативный fetch.
 *
 * Конфиг: ~/.redmine/config.json (профили инстансов), env имеет приоритет.
 * Вывод: человекочитаемый текст, либо --json для машинного разбора.
 */

import { join } from "node:path";

// ─────────────────────────────── конфиг ───────────────────────────────

type Instance = {
  url: string;
  apiKey: string;
  defaultActivity?: string;
  defaultProject?: string;
  dailyTargetHours?: number;
  projectAliases?: Record<string, string>;
};

type ConfigFile = {
  default?: string;
  instances: Record<string, Instance>;
};

type Resolved = Instance & { name: string; base: string };

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const CONFIG_DIR = join(HOME, ".redmine");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CACHE_PATH = join(CONFIG_DIR, "cache.json");
const STATE_PATH = join(CONFIG_DIR, "state.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

class UserError extends Error {}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: string[],
    readonly url: string,
  ) {
    super(`HTTP ${status} ${url}${details.length ? ": " + details.join("; ") : ""}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readConfigFile(): Promise<ConfigFile | null> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return null;
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new UserError(`Конфиг ${CONFIG_PATH} не является валидным JSON.`);
  }
  if (!isRecord(raw)) throw new UserError(`Конфиг ${CONFIG_PATH} должен быть объектом.`);
  if (!isRecord(raw.instances)) throw new UserError(`В ${CONFIG_PATH} нет объекта "instances".`);

  const parsed: Record<string, Instance> = {};
  for (const [name, value] of Object.entries(raw.instances)) {
    if (!isRecord(value)) continue;
    parsed[name] = {
      url: typeof value.url === "string" ? value.url : "",
      apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
      defaultActivity: typeof value.defaultActivity === "string" ? value.defaultActivity : undefined,
      defaultProject: typeof value.defaultProject === "string" ? value.defaultProject : undefined,
      dailyTargetHours: typeof value.dailyTargetHours === "number" ? value.dailyTargetHours : undefined,
      projectAliases: isRecord(value.projectAliases)
        ? Object.fromEntries(
            Object.entries(value.projectAliases).filter((e): e is [string, string] => typeof e[1] === "string"),
          )
        : undefined,
    };
  }
  return { default: typeof raw.default === "string" ? raw.default : undefined, instances: parsed };
}

function normalizeBase(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new UserError(`URL Redmine должен начинаться с http(s)://, получено: ${url}`);
  }
  return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

/** Поиск профиля по имени, хосту или подстроке URL. */
function pickInstance(cfg: ConfigFile, wanted: string): [string, Instance] {
  const names = Object.keys(cfg.instances);
  const needle = wanted.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === needle);
  if (exact) return [exact, cfg.instances[exact]!];
  const byUrl = names.find((n) => (cfg.instances[n]?.url ?? "").toLowerCase().includes(needle));
  if (byUrl) return [byUrl, cfg.instances[byUrl]!];
  const byPrefix = names.filter((n) => n.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1) return [byPrefix[0]!, cfg.instances[byPrefix[0]!]!];
  throw new UserError(`Инстанс "${wanted}" не найден. Доступные: ${names.join(", ") || "нет"} (см. ${CONFIG_PATH}).`);
}

async function resolveInstance(requested: string | undefined): Promise<Resolved> {
  const cfg = await readConfigFile();
  const envUrl = process.env.REDMINE_URL;
  const envKey = process.env.REDMINE_API_KEY;
  const wanted = requested ?? process.env.REDMINE_INSTANCE ?? cfg?.default;

  let name = "env";
  let inst: Instance | undefined;

  if (cfg && Object.keys(cfg.instances).length > 0) {
    if (wanted) {
      const [n, i] = pickInstance(cfg, wanted);
      name = n;
      inst = i;
    } else {
      const names = Object.keys(cfg.instances);
      if (names.length === 1) {
        name = names[0]!;
        inst = cfg.instances[name]!;
      } else if (!envUrl) {
        throw new UserError(
          `В конфиге несколько инстансов (${names.join(", ")}) и не задан "default". ` +
            `Укажите --instance <имя> или добавьте "default" в ${CONFIG_PATH}.`,
        );
      }
    }
  }

  const url = envUrl ?? inst?.url ?? "";
  const apiKey = envKey ?? inst?.apiKey ?? "";
  if (!url || !apiKey) {
    throw new UserError(
      `Нет доступа к Redmine. Заполните ${CONFIG_PATH} (образец — config.example.json в папке скилла) ` +
        `или задайте REDMINE_URL и REDMINE_API_KEY. ` +
        (url ? "" : "Отсутствует url. ") +
        (apiKey ? "" : "Отсутствует apiKey."),
    );
  }
  return { ...(inst ?? {}), name, url, apiKey, base: normalizeBase(url) };
}

/** Все профили — для команд, работающих сразу по обоим Redmine. */
async function allInstances(): Promise<Resolved[]> {
  const cfg = await readConfigFile();
  const names = Object.keys(cfg?.instances ?? {});
  if (names.length === 0) return [await resolveInstance(undefined)];
  return names
    .map((name) => {
      const inst = cfg!.instances[name]!;
      if (!inst.url || !inst.apiKey) return null;
      return { ...inst, name, base: normalizeBase(inst.url) };
    })
    .filter((x): x is Resolved => x !== null);
}

// ──────────────────────────────── HTTP ────────────────────────────────

type Query = Record<string, string | number | boolean | undefined>;

async function request<T>(
  rm: Resolved,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query?: Query,
  body?: unknown,
): Promise<T> {
  const url = new URL(path.replace(/^\//, ""), rm.base);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      "X-Redmine-API-Key": rm.apiKey,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let details: string[] = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && Array.isArray(parsed.errors)) details = parsed.errors.map(String);
    } catch {
      if (text.trim()) details = [text.slice(0, 300).replace(/\s+/g, " ")];
    }
    if (res.status === 401) details.unshift("неверный или просроченный API-ключ");
    if (res.status === 403) details.unshift("недостаточно прав у владельца ключа");
    if (res.status === 404) details.unshift("объект не найден или REST API отключён в настройках Redmine");
    throw new ApiError(res.status, details, url.toString());
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

async function fetchAll<T>(rm: Resolved, path: string, key: string, query: Query, max = 500): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await request<Record<string, unknown>>(rm, "GET", path, {
      ...query,
      limit: Math.min(100, Math.max(1, max - out.length)),
      offset,
    });
    const items = page[key];
    if (!Array.isArray(items)) break;
    out.push(...(items as T[]));
    const total = typeof page.total_count === "number" ? page.total_count : out.length;
    offset += items.length;
    if (items.length === 0 || out.length >= Math.min(total, max)) break;
  }
  return out;
}

/** Параллельная загрузка с ограничением одновременных запросов. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─────────────────────────────── модели ───────────────────────────────

type IdName = { id: number; name: string };

type JournalDetail = { property: string; name: string; old_value: string | null; new_value: string | null };

type Journal = {
  id: number;
  user: IdName;
  notes: string;
  created_on: string;
  private_notes?: boolean;
  details: JournalDetail[];
};

type Issue = {
  id: number;
  subject: string;
  description?: string;
  project: IdName;
  tracker: IdName;
  status: IdName;
  priority: IdName;
  author: IdName;
  assigned_to?: IdName;
  fixed_version?: IdName;
  parent?: { id: number };
  done_ratio: number;
  estimated_hours?: number | null;
  spent_hours?: number;
  start_date?: string | null;
  due_date?: string | null;
  created_on: string;
  updated_on: string;
  journals?: Journal[];
};

type TimeEntry = {
  id: number;
  project: IdName;
  issue?: { id: number };
  user: IdName;
  activity: IdName;
  hours: number;
  comments: string;
  spent_on: string;
  created_on: string;
  updated_on: string;
};

type ProjectRef = { id: number; name: string; identifier: string; status: number };

type CurrentUser = { id: number; login: string; firstname: string; lastname: string; mail?: string };

// ─────────────────────────── кэш и состояние ──────────────────────────

type CacheEntry = { at: number; data: unknown };
type CacheFile = Record<string, CacheEntry>;

let cacheMemo: CacheFile | null = null;
let noCache = false;

async function cacheGet<T>(key: string): Promise<T | null> {
  if (noCache) return null;
  if (cacheMemo === null) {
    const file = Bun.file(CACHE_PATH);
    cacheMemo = (await file.exists()) ? ((await file.json().catch(() => ({}))) as CacheFile) : {};
  }
  const hit = cacheMemo[key];
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.data as T;
}

async function cacheSet(key: string, data: unknown): Promise<void> {
  if (cacheMemo === null) cacheMemo = {};
  cacheMemo[key] = { at: Date.now(), data };
  await Bun.write(CACHE_PATH, JSON.stringify(cacheMemo));
}

async function cached<T>(rm: Resolved, key: string, load: () => Promise<T>): Promise<T> {
  const full = `${rm.name}:${key}`;
  const hit = await cacheGet<T>(full);
  if (hit !== null) return hit;
  const data = await load();
  await cacheSet(full, data);
  return data;
}

type State = Record<string, { lastSeen?: string }>;

async function readState(): Promise<State> {
  const file = Bun.file(STATE_PATH);
  if (!(await file.exists())) return {};
  return ((await file.json().catch(() => ({}))) ?? {}) as State;
}

async function writeLastSeen(instance: string, iso: string): Promise<void> {
  const state = await readState();
  state[instance] = { ...(state[instance] ?? {}), lastSeen: iso };
  await Bun.write(STATE_PATH, JSON.stringify(state, null, 2));
}

// ───────────────────────────── справочники ────────────────────────────

async function activities(rm: Resolved): Promise<IdName[]> {
  return cached(rm, "activities", async () => {
    const r = await request<{ time_entry_activities: IdName[] }>(rm, "GET", "enumerations/time_entry_activities.json");
    return r.time_entry_activities;
  });
}

async function statuses(rm: Resolved): Promise<IdName[]> {
  return cached(rm, "statuses", async () => {
    const r = await request<{ issue_statuses: IdName[] }>(rm, "GET", "issue_statuses.json");
    return r.issue_statuses;
  });
}

async function projects(rm: Resolved): Promise<ProjectRef[]> {
  return cached(rm, "projects", async () => fetchAll<ProjectRef>(rm, "projects.json", "projects", {}, 1000));
}

async function trackers(rm: Resolved): Promise<IdName[]> {
  return cached(rm, "trackers", async () => {
    const r = await request<{ trackers: IdName[] }>(rm, "GET", "trackers.json");
    return r.trackers;
  });
}

async function priorities(rm: Resolved): Promise<IdName[]> {
  return cached(rm, "priorities", async () => {
    const r = await request<{ issue_priorities: IdName[] }>(rm, "GET", "enumerations/issue_priorities.json");
    return r.issue_priorities;
  });
}

const userMemo = new Map<string, CurrentUser>();

async function currentUser(rm: Resolved): Promise<CurrentUser> {
  const hit = userMemo.get(rm.name);
  if (hit) return hit;
  const r = await request<{ user: CurrentUser }>(rm, "GET", "users/current.json");
  userMemo.set(rm.name, r.user);
  return r.user;
}

function matchByName<T extends IdName>(items: T[], needle: string, kind: string): T {
  if (/^\d+$/.test(needle)) {
    const byId = items.find((i) => i.id === Number(needle));
    if (byId) return byId;
    return { id: Number(needle), name: `#${needle}` } as T;
  }
  const low = needle.toLowerCase();
  const exact = items.find((i) => i.name.toLowerCase() === low);
  if (exact) return exact;
  const partial = items.filter((i) => i.name.toLowerCase().includes(low));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new UserError(`Неоднозначно: "${needle}" подходит под ${partial.map((i) => i.name).join(", ")}.`);
  }
  throw new UserError(`${kind} "${needle}" не найден. Доступно: ${items.map((i) => i.name).join(", ")}.`);
}

async function resolveActivityId(rm: Resolved, value: string | undefined): Promise<number | undefined> {
  const wanted = value ?? rm.defaultActivity;
  if (!wanted) return undefined;
  return matchByName(await activities(rm), wanted, "Вид деятельности").id;
}

async function resolveProjectKey(rm: Resolved, value: string): Promise<string | number> {
  const key = rm.projectAliases?.[value] ?? value;
  if (/^\d+$/.test(key)) return Number(key);
  const list = await projects(rm);
  const byIdent = list.find((p) => p.identifier.toLowerCase() === key.toLowerCase());
  if (byIdent) return byIdent.identifier;
  const low = key.toLowerCase();
  const byName = list.filter((p) => p.name.toLowerCase().includes(low));
  if (byName.length === 1) return byName[0]!.identifier;
  if (byName.length > 1) {
    throw new UserError(
      `Проект "${value}" неоднозначен: ${byName.map((p) => `${p.name} (${p.identifier})`).join(", ")}.`,
    );
  }
  throw new UserError(`Проект "${value}" не найден. Список: redmine.ts projects`);
}

// ─────────────────────────── даты и часы ──────────────────────────────

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDays(d: Date, days: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

function parseDate(input: string): string {
  const s = input.trim().toLowerCase();
  const today = new Date();
  if (s === "today" || s === "сегодня") return fmtDate(today);
  if (s === "yesterday" || s === "вчера") return fmtDate(shiftDays(today, -1));
  if (s === "tomorrow" || s === "завтра") return fmtDate(shiftDays(today, 1));
  if (/^-\d+$/.test(s)) return fmtDate(shiftDays(today, Number(s)));
  if (/^\+\d+$/.test(s)) return fmtDate(shiftDays(today, Number(s.slice(1))));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dotted = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (dotted) {
    const day = Number(dotted[1]);
    const month = Number(dotted[2]);
    const rawYear = dotted[3];
    const year =
      rawYear === undefined ? today.getFullYear() : rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return fmtDate(new Date(year, month - 1, day));
  }
  throw new UserError(`Не понимаю дату "${input}". Форматы: YYYY-MM-DD, DD.MM[.YYYY], today, yesterday, -3.`);
}

function startOfWeek(d: Date): Date {
  const c = new Date(d);
  const dow = (c.getDay() + 6) % 7; // понедельник = 0
  return shiftDays(c, -dow);
}

/** Период → [from, to] в формате YYYY-MM-DD. */
function parsePeriod(input: string): [string, string] {
  const s = input.trim().toLowerCase();
  const today = new Date();
  if (s === "today" || s === "сегодня") return [fmtDate(today), fmtDate(today)];
  if (s === "yesterday" || s === "вчера") {
    const y = shiftDays(today, -1);
    return [fmtDate(y), fmtDate(y)];
  }
  if (s === "week" || s === "неделя") return [fmtDate(startOfWeek(today)), fmtDate(today)];
  if (s === "last-week" || s === "прошлая-неделя") {
    const start = shiftDays(startOfWeek(today), -7);
    return [fmtDate(start), fmtDate(shiftDays(start, 6))];
  }
  if (s === "month" || s === "месяц") return [fmtDate(new Date(today.getFullYear(), today.getMonth(), 1)), fmtDate(today)];
  if (s === "last-month" || s === "прошлый-месяц") {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return [fmtDate(start), fmtDate(end)];
  }
  const ym = s.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    return [fmtDate(new Date(year, month - 1, 1)), fmtDate(new Date(year, month, 0))];
  }
  const range = s.match(/^(.+?)\.\.(.+)$/);
  if (range) return [parseDate(range[1]!), parseDate(range[2]!)];
  const single = parseDate(s);
  return [single, single];
}

function parseHours(input: string): number {
  const s = input.trim().toLowerCase().replace(",", ".");
  const colon = s.match(/^(\d+):([0-5]\d)$/);
  if (colon) return Number(colon[1]) + Number(colon[2]) / 60;
  const hm = s.match(/^(\d+(?:\.\d+)?)\s*(?:h|ч|час[а-я]*)\s*(\d{1,2})?\s*(?:m|м|мин[а-я]*)?$/);
  if (hm) return Number(hm[1]) + (hm[2] ? Number(hm[2]) / 60 : 0);
  const minutes = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|м|мин[а-я]*)$/);
  if (minutes) return Number(minutes[1]) / 60;
  const plain = Number(s);
  if (Number.isFinite(plain) && plain > 0) return plain;
  throw new UserError(`Не понимаю длительность "${input}". Форматы: 2, 2.5, 1h30, 1:30, 90m.`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function h(n: number): string {
  return `${round2(n).toFixed(2)}ч`;
}

function daysUntil(dateIso: string): number {
  const target = new Date(`${dateIso}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

// ────────────────────────────── argv ──────────────────────────────────

type Args = { cmd: string; positional: string[]; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const short: Record<string, string> = { i: "instance", q: "query", p: "project", d: "date", n: "limit" };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(body, next);
        index++;
      } else {
        flags.set(body, true);
      }
    } else if (/^-[a-z]$/i.test(token)) {
      const name = short[token[1]!] ?? token[1]!;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        index++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  const cmd = positional.shift() ?? "help";
  return { cmd, positional, flags };
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function bool(args: Args, name: string): boolean {
  return args.flags.has(name) && args.flags.get(name) !== "false";
}

function num(args: Args, name: string): number | undefined {
  const v = str(args, name);
  if (v === undefined) return undefined;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n)) throw new UserError(`Флаг --${name} ожидает число, получено "${v}".`);
  return n;
}

function required(args: Args, name: string): string {
  const v = str(args, name);
  if (v === undefined) throw new UserError(`Не задан обязательный флаг --${name}.`);
  return v;
}

// ────────────────────────────── вывод ─────────────────────────────────

let jsonMode = false;

function emit(data: unknown, human: () => string): void {
  if (jsonMode) console.log(JSON.stringify(data, null, 2));
  else console.log(human());
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "(пусто)";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => (i === cols - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd())
    .join("\n");
}

function issueUrl(rm: Resolved, id: number): string {
  return `${rm.base}issues/${id}`;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
};

/** Redmine отдаёт описания и комментарии как HTML или textile — приводим к читаемому тексту. */
function plain(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&([a-z#0-9]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Однострочная обрезка — для ячеек таблиц. */
function clip(text: string, max: number): string {
  const flat = plain(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Многострочная обрезка — сохраняет абзацы описаний и комментариев. */
function clipBlock(text: string, max: number, indent = ""): string {
  const trimmed = plain(text.replace(/\r\n/g, "\n"));
  const cut = trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
  return cut
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

// ───────────────────────────── справочные команды ─────────────────────

async function cmdWhoami(rm: Resolved, _args: Args): Promise<void> {
  const user = await currentUser(rm);
  emit({ instance: rm.name, url: rm.base, user }, () =>
    [
      `Инстанс: ${rm.name} (${rm.base})`,
      `Пользователь: ${user.firstname} ${user.lastname} (${user.login}, id=${user.id})`,
      user.mail ? `Почта: ${user.mail}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function cmdInstances(args: Args): Promise<void> {
  const cfg = await readConfigFile();
  const rows = Object.entries(cfg?.instances ?? {}).map(([name, i]) => ({
    name,
    url: i.url,
    isDefault: cfg?.default === name,
    hasKey: Boolean(i.apiKey),
    defaultActivity: i.defaultActivity ?? null,
    dailyTargetHours: i.dailyTargetHours ?? null,
  }));
  const envUrl = process.env.REDMINE_URL;
  emit({ configPath: CONFIG_PATH, envOverride: Boolean(envUrl), instances: rows }, () =>
    rows.length === 0
      ? `Конфиг ${CONFIG_PATH} пуст или отсутствует.` + (envUrl ? `\nЗадан REDMINE_URL=${envUrl}.` : "")
      : table([
          ["ИНСТАНС", "URL", "КЛЮЧ", "ПО УМОЛЧ.", "ВИД ПО УМОЛЧ."],
          ...rows.map((r) => [
            r.name,
            r.url,
            r.hasKey ? "есть" : "НЕТ",
            r.isDefault ? "да" : "",
            r.defaultActivity ?? "",
          ]),
        ]) +
        (envUrl ? `\n\nВнимание: REDMINE_URL в окружении переопределяет профиль (${envUrl}).` : "") +
        (bool(args, "verbose") ? `\nКонфиг: ${CONFIG_PATH}` : ""),
  );
}

async function cmdActivities(rm: Resolved, _args: Args): Promise<void> {
  const list = await activities(rm);
  emit(list, () => table([["ID", "ВИД ДЕЯТЕЛЬНОСТИ"], ...list.map((a) => [String(a.id), a.name])]));
}

async function cmdStatuses(rm: Resolved, _args: Args): Promise<void> {
  const list = await statuses(rm);
  emit(list, () => table([["ID", "СТАТУС"], ...list.map((s) => [String(s.id), s.name])]));
}

async function cmdProjects(rm: Resolved, args: Args): Promise<void> {
  const q = (str(args, "query") ?? args.positional[0] ?? "").toLowerCase();
  const list = (await projects(rm)).filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
  );
  emit(list, () =>
    table([["ID", "IDENTIFIER", "НАЗВАНИЕ"], ...list.map((p) => [String(p.id), p.identifier, p.name])]),
  );
}

// ───────────────────────────── задачи ─────────────────────────────────

async function resolveStatusFilter(rm: Resolved, value: string): Promise<string | number> {
  const low = value.toLowerCase();
  if (low === "open" || low === "closed" || low === "*" || low === "all") return low === "all" ? "*" : low;
  return matchByName(await statuses(rm), value, "Статус").id;
}

const BULKY_FIELDS = new Set(["description", "notes"]);

function formatJournalDetail(d: JournalDetail): string {
  if (BULKY_FIELDS.has(d.name)) return `${d.name}: текст изменён`;
  if (d.property === "attachment") return `вложение: ${d.new_value ?? d.old_value ?? "—"}`;
  const from = d.old_value ?? "—";
  const to = d.new_value ?? "—";
  return `${d.name}: ${clip(from, 40)} → ${clip(to, 40)}`;
}

async function cmdIssue(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? str(args, "issue");
  if (!raw) throw new UserError("Укажите номер задачи: redmine.ts issue 1234");
  const id = Number(raw.replace("#", ""));
  const r = await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`, { include: "journals,relations" });
  const i = r.issue;
  const journals = (i.journals ?? []).filter((j) => j.notes?.trim() || j.details.length > 0);
  const tail = journals.slice(-(num(args, "comments") ?? 5));

  emit(i, () => {
    const lines = [
      `#${i.id} — ${i.subject}`,
      issueUrl(rm, i.id),
      `Проект: ${i.project.name} | Трекер: ${i.tracker.name} | Статус: ${i.status.name} | Приоритет: ${i.priority.name}`,
      `Исполнитель: ${i.assigned_to?.name ?? "—"} | Автор: ${i.author.name} | Готовность: ${i.done_ratio}%`,
      `Оценка: ${i.estimated_hours != null ? h(i.estimated_hours) : "—"} | Списано: ${
        i.spent_hours != null ? h(i.spent_hours) : "—"
      }`,
      `Начало: ${i.start_date ?? "—"} | Срок: ${i.due_date ?? "—"}${
        i.due_date ? ` (${daysUntil(i.due_date)} дн.)` : ""
      } | Обновлена: ${i.updated_on}`,
    ];
    if (i.description?.trim()) lines.push("", "Описание:", clipBlock(i.description, 2000));
    if (tail.length) {
      lines.push("", `Последние события (${tail.length} из ${journals.length}):`);
      for (const j of tail) {
        lines.push(`— ${j.created_on} ${j.user.name}:`);
        if (j.notes?.trim()) lines.push(clipBlock(j.notes, 600, "  "));
        for (const d of j.details) lines.push(`  · ${formatJournalDetail(d)}`);
      }
    }
    return lines.join("\n");
  });
}

async function cmdIssues(rm: Resolved, args: Args): Promise<void> {
  const query: Query = {
    limit: num(args, "limit") ?? 25,
    sort: str(args, "sort") ?? "updated_on:desc",
    status_id: await resolveStatusFilter(rm, str(args, "status") ?? "open"),
  };
  const project = str(args, "project") ?? rm.defaultProject;
  if (project) query.project_id = await resolveProjectKey(rm, project);
  const assignee = str(args, "assignee");
  if (assignee) query.assigned_to_id = assignee === "me" ? "me" : assignee;
  if (bool(args, "mine")) query.assigned_to_id = "me";
  if (bool(args, "watched")) query.watcher_id = "me";
  const subject = str(args, "subject") ?? str(args, "query") ?? args.positional[0];
  if (subject) query.subject = `~${subject}`;
  const updatedAfter = str(args, "updated-after");
  if (updatedAfter) query.updated_on = `>=${parseDate(updatedAfter)}`;
  const due = str(args, "due-before");
  if (due) query.due_date = `<=${parseDate(due)}`;

  const r = await request<{ issues: Issue[]; total_count: number }>(rm, "GET", "issues.json", query);
  emit({ instance: rm.name, total_count: r.total_count, issues: r.issues }, () =>
    r.issues.length === 0
      ? "Задач не найдено."
      : `Найдено ${r.total_count}, показано ${r.issues.length}:\n` +
        table([
          ["ID", "СТАТУС", "ГОТОВ", "СРОК", "ПРОЕКТ", "ТЕМА"],
          ...r.issues.map((i) => [
            `#${i.id}`,
            clip(i.status.name, 14),
            `${i.done_ratio}%`,
            i.due_date ?? "—",
            clip(i.project.name, 20),
            clip(i.subject, 60),
          ]),
        ]),
  );
}

async function cmdSearch(rm: Resolved, args: Args): Promise<void> {
  const q = args.positional.join(" ") || str(args, "query");
  if (!q) throw new UserError('Укажите текст поиска: redmine.ts search "фраза"');
  const project = str(args, "project");
  const path = project ? `projects/${await resolveProjectKey(rm, project)}/search.json` : "search.json";
  const r = await request<{
    results: { id: number; title: string; type: string; url: string; datetime: string }[];
    total_count: number;
  }>(rm, "GET", path, { q, issues: 1, limit: num(args, "limit") ?? 25 });
  emit(r, () =>
    r.results.length === 0
      ? "Ничего не найдено."
      : `Найдено ${r.total_count}:\n` +
        table([
          ["ID", "ТИП", "ЗАГОЛОВОК", "ИЗМЕНЕНО"],
          ...r.results.map((x) => [`#${x.id}`, clip(x.type, 12), clip(x.title, 80), x.datetime.slice(0, 10)]),
        ]),
  );
}

async function cmdTrackers(rm: Resolved, _args: Args): Promise<void> {
  const [tr, pr] = await Promise.all([trackers(rm), priorities(rm)]);
  emit({ trackers: tr, priorities: pr }, () =>
    table([["ID", "ТРЕКЕР"], ...tr.map((t) => [String(t.id), t.name])]) +
      "\n\n" +
      table([["ID", "ПРИОРИТЕТ"], ...pr.map((p) => [String(p.id), p.name])]),
  );
}

async function cmdCreateIssue(rm: Resolved, args: Args): Promise<void> {
  const project = str(args, "project") ?? rm.defaultProject;
  if (!project) throw new UserError("Нужен --project <identifier|часть названия>.");
  const subject = str(args, "subject") ?? args.positional.join(" ");
  if (!subject) throw new UserError('Нужна тема: --subject "..."');

  const descriptionFile = str(args, "description-file");
  const description = descriptionFile ? await Bun.file(descriptionFile).text() : str(args, "description");

  const payload: Record<string, unknown> = {
    project_id: await resolveProjectKey(rm, project),
    subject,
  };
  if (description) payload.description = description;
  const tracker = str(args, "tracker");
  if (tracker) payload.tracker_id = matchByName(await trackers(rm), tracker, "Трекер").id;
  const priority = str(args, "priority");
  if (priority) payload.priority_id = matchByName(await priorities(rm), priority, "Приоритет").id;
  const status = str(args, "status");
  if (status) payload.status_id = matchByName(await statuses(rm), status, "Статус").id;
  const assignee = str(args, "assignee");
  if (assignee) payload.assigned_to_id = assignee === "me" ? (await currentUser(rm)).id : Number(assignee);
  const due = str(args, "due");
  if (due) payload.due_date = parseDate(due);
  const start = str(args, "start");
  if (start) payload.start_date = parseDate(start);
  const estimated = str(args, "estimated");
  if (estimated) payload.estimated_hours = round2(parseHours(estimated));
  const parent = str(args, "parent");
  if (parent) payload.parent_issue_id = Number(parent.replace("#", ""));
  const done = num(args, "done");
  if (done !== undefined) payload.done_ratio = done;

  if (bool(args, "dry-run")) {
    emit({ dryRun: true, instance: rm.name, issue: payload }, () =>
      `ПРЕДПРОСМОТР новой задачи (инстанс ${rm.name}, ничего не создано):\n${JSON.stringify(payload, null, 2)}`,
    );
    return;
  }
  const r = await request<{ issue: Issue }>(rm, "POST", "issues.json", undefined, { issue: payload });
  const i = r.issue;
  emit(i, () =>
    `Создана #${i.id} — ${i.subject}\n${issueUrl(rm, i.id)}\n` +
      `Проект: ${i.project.name} | Трекер: ${i.tracker.name} | Статус: ${i.status.name}` +
      (i.due_date ? ` | Срок: ${i.due_date}` : ""),
  );
}

async function cmdUpdateIssue(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? required(args, "issue");
  const id = Number(raw.replace("#", ""));
  if (!Number.isInteger(id)) throw new UserError("Укажите номер задачи: redmine.ts update-issue 1234 --done 50");
  const patch: Record<string, unknown> = {};
  const status = str(args, "status");
  if (status) patch.status_id = matchByName(await statuses(rm), status, "Статус").id;
  const done = num(args, "done");
  if (done !== undefined) patch.done_ratio = done;
  const note = str(args, "note");
  if (note) patch.notes = note;
  const assignee = str(args, "assignee");
  if (assignee) patch.assigned_to_id = assignee === "me" ? (await currentUser(rm)).id : Number(assignee);
  const due = str(args, "due");
  if (due) patch.due_date = parseDate(due);
  if (Object.keys(patch).length === 0) {
    throw new UserError("Нечего менять: задайте --status/--done/--note/--assignee/--due.");
  }

  if (bool(args, "dry-run")) {
    emit({ dryRun: true, issue: id, patch }, () => `ПРЕДПРОСМОТР изменения #${id}:\n${JSON.stringify(patch, null, 2)}`);
    return;
  }
  await request(rm, "PUT", `issues/${id}.json`, undefined, { issue: patch });
  const r = await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`);
  const i = r.issue;
  emit(i, () => `#${i.id} обновлена: статус ${i.status.name}, готовность ${i.done_ratio}%\n${issueUrl(rm, i.id)}`);
}

async function cmdComment(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? required(args, "issue");
  const id = Number(raw.replace("#", ""));
  if (!Number.isInteger(id)) throw new UserError('Укажите задачу: redmine.ts comment 1234 --text "..."');
  const textFile = str(args, "text-file");
  const text = textFile ? await Bun.file(textFile).text() : (str(args, "text") ?? args.positional.slice(1).join(" "));
  if (!text.trim()) throw new UserError('Нужен текст комментария: --text "..." или --text-file <файл>.');
  const patch: Record<string, unknown> = { notes: text };
  if (bool(args, "private")) patch.private_notes = true;

  if (bool(args, "dry-run")) {
    emit({ dryRun: true, issue: id, patch }, () => `ПРЕДПРОСМОТР комментария к #${id}:\n${text}`);
    return;
  }
  await request(rm, "PUT", `issues/${id}.json`, undefined, { issue: patch });
  emit({ issue: id, added: true }, () => `Комментарий добавлен к #${id}: ${issueUrl(rm, id)}`);
}

// ─────────────────────── входящие: новое и сроки ──────────────────────

type InboxEvent = {
  instance: string;
  issue: { id: number; subject: string; project: string; status: string; due_date: string | null; url: string };
  kind: "assigned" | "comment" | "change";
  at: string;
  who: string;
  text: string;
};

function isoSince(value: string): string {
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toISOString();
  const hours = s.match(/^-?(\d+)\s*(?:h|ч)$/i);
  if (hours) return new Date(Date.now() - Number(hours[1]) * 3_600_000).toISOString();
  return new Date(`${parseDate(s)}T00:00:00`).toISOString();
}

async function collectInbox(rm: Resolved, sinceIso: string, args: Args): Promise<InboxEvent[]> {
  const me = await currentUser(rm);
  const includeOwn = bool(args, "include-own");
  const limit = num(args, "limit") ?? 30;

  const scopes: Query[] = [{ assigned_to_id: "me" }];
  if (bool(args, "watched")) scopes.push({ watcher_id: "me" });
  if (bool(args, "authored")) scopes.push({ author_id: "me" });

  const seen = new Map<number, Issue>();
  for (const scope of scopes) {
    const page = await request<{ issues: Issue[] }>(rm, "GET", "issues.json", {
      ...scope,
      status_id: str(args, "status") ? await resolveStatusFilter(rm, required(args, "status")) : "open",
      updated_on: `>=${sinceIso.replace(/\.\d{3}Z$/, "Z")}`,
      sort: "updated_on:desc",
      limit,
    });
    for (const issue of page.issues) seen.set(issue.id, issue);
  }

  const issues = [...seen.values()];
  const detailed = await mapLimit(issues, 5, async (issue) => {
    const r = await request<{ issue: Issue }>(rm, "GET", `issues/${issue.id}.json`, { include: "journals" });
    return r.issue;
  });

  const events: InboxEvent[] = [];
  for (const issue of detailed) {
    const ref = {
      id: issue.id,
      subject: issue.subject,
      project: issue.project.name,
      status: issue.status.name,
      due_date: issue.due_date ?? null,
      url: issueUrl(rm, issue.id),
    };

    if (new Date(issue.created_on).toISOString() >= sinceIso) {
      events.push({
        instance: rm.name,
        issue: ref,
        kind: "assigned",
        at: issue.created_on,
        who: issue.author.name,
        text: `новая задача${issue.assigned_to?.id === me.id ? " на мне" : ""}: ${clip(issue.description ?? "", 200)}`,
      });
    }

    for (const j of issue.journals ?? []) {
      if (new Date(j.created_on).toISOString() < sinceIso) continue;
      if (!includeOwn && j.user.id === me.id) continue;
      const assignedToMe = j.details.find(
        (d) => d.property === "attr" && d.name === "assigned_to_id" && d.new_value === String(me.id),
      );
      if (assignedToMe) {
        events.push({
          instance: rm.name,
          issue: ref,
          kind: "assigned",
          at: j.created_on,
          who: j.user.name,
          text: "назначена на меня",
        });
      }
      if (j.notes?.trim()) {
        events.push({
          instance: rm.name,
          issue: ref,
          kind: "comment",
          at: j.created_on,
          who: j.user.name,
          text: clip(j.notes, 400),
        });
      }
      const changes = j.details.filter((d) => !(d.name === "assigned_to_id" && assignedToMe));
      if (changes.length && !j.notes?.trim()) {
        events.push({
          instance: rm.name,
          issue: ref,
          kind: "change",
          at: j.created_on,
          who: j.user.name,
          text: changes.map(formatJournalDetail).join("; "),
        });
      }
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

async function cmdInbox(args: Args): Promise<void> {
  const sinceRaw = str(args, "since");
  const targets = bool(args, "all-instances") ? await allInstances() : [await resolveInstance(str(args, "instance"))];
  const state = await readState();

  const blocks = await Promise.all(
    targets.map(async (rm) => {
      const since = sinceRaw
        ? isoSince(sinceRaw)
        : (state[rm.name]?.lastSeen ?? new Date(Date.now() - 7 * 86_400_000).toISOString());
      const events = await collectInbox(rm, since, args);
      return { rm, since, events };
    }),
  );

  const all = blocks.flatMap((b) => b.events);

  if (bool(args, "mark")) {
    const now = new Date().toISOString();
    for (const b of blocks) await writeLastSeen(b.rm.name, now);
  }

  emit(
    {
      since: Object.fromEntries(blocks.map((b) => [b.rm.name, b.since])),
      marked: bool(args, "mark"),
      events: all,
    },
    () => {
      if (all.length === 0) {
        return `Нового нет (с ${blocks.map((b) => `${b.rm.name}: ${b.since.slice(0, 16).replace("T", " ")}`).join(", ")}).`;
      }
      const lines: string[] = [];
      const byIssue = new Map<string, InboxEvent[]>();
      for (const e of all) {
        const key = `${e.instance}#${e.issue.id}`;
        const bucket = byIssue.get(key);
        if (bucket) bucket.push(e);
        else byIssue.set(key, [e]);
      }
      for (const [key, list] of byIssue) {
        const head = list[0]!.issue;
        const dueNote = head.due_date ? ` | срок ${head.due_date} (${daysUntil(head.due_date)} дн.)` : "";
        lines.push(`${key} — ${head.subject}`);
        lines.push(`  ${head.project} | ${head.status}${dueNote}`);
        for (const e of list) {
          const tag = e.kind === "assigned" ? "НОВАЯ" : e.kind === "comment" ? "коммент" : "измен.";
          lines.push(`  [${tag}] ${e.at.slice(0, 16).replace("T", " ")} ${e.who}: ${e.text}`);
        }
        lines.push(`  ${head.url}`);
        lines.push("");
      }
      lines.push(
        `Событий: ${all.length} по ${byIssue.size} задачам, с ` +
          blocks.map((b) => `${b.rm.name}: ${b.since.slice(0, 16).replace("T", " ")}`).join(", ") +
          (bool(args, "mark") ? ". Отметка «просмотрено» обновлена." : ". Отметить просмотренным: --mark"),
      );
      return lines.join("\n");
    },
  );
}

type DueRow = {
  instance: string;
  id: number;
  subject: string;
  project: string;
  status: string;
  due_date: string | null;
  days: number | null;
  done_ratio: number;
  estimated_hours: number | null;
  spent_hours: number | null;
  url: string;
};

async function cmdDue(args: Args): Promise<void> {
  const days = num(args, "days") ?? 14;
  const targets = bool(args, "all-instances") ? await allInstances() : [await resolveInstance(str(args, "instance"))];
  const horizon = fmtDate(shiftDays(new Date(), days));

  const rows: DueRow[] = [];
  for (const rm of targets) {
    const query: Query = {
      assigned_to_id: bool(args, "anyone") ? undefined : "me",
      status_id: "open",
      sort: "due_date:asc",
      limit: num(args, "limit") ?? 100,
    };
    const project = str(args, "project");
    if (project) query.project_id = await resolveProjectKey(rm, project);
    if (!bool(args, "all")) query.due_date = `<=${horizon}`;

    const issues = await fetchAll<Issue>(rm, "issues.json", "issues", query, num(args, "limit") ?? 100);
    for (const i of issues) {
      rows.push({
        instance: rm.name,
        id: i.id,
        subject: i.subject,
        project: i.project.name,
        status: i.status.name,
        due_date: i.due_date ?? null,
        days: i.due_date ? daysUntil(i.due_date) : null,
        done_ratio: i.done_ratio,
        estimated_hours: i.estimated_hours ?? null,
        spent_hours: i.spent_hours ?? null,
        url: issueUrl(rm, i.id),
      });
    }
  }

  rows.sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));

  // Отсекаем «мёртвые хвосты»: задачи, просроченные больше чем на staleDays, и статусы-исключения.
  const staleDays = num(args, "stale-days") ?? 90;
  const showStale = bool(args, "stale");
  const excluded = (str(args, "exclude-status") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const byStatus = rows.filter((r) => !excluded.includes(r.status.toLowerCase()));
  const hiddenByStatus = rows.length - byStatus.length;
  const stale = byStatus.filter((r) => r.days !== null && r.days < -staleDays);
  const visible = showStale ? byStatus : byStatus.filter((r) => !stale.includes(r));

  const overdue = visible.filter((r) => r.days !== null && r.days < 0);
  const today = visible.filter((r) => r.days === 0);
  const soon = visible.filter((r) => r.days !== null && r.days > 0);
  const undated = visible.filter((r) => r.days === null);

  const row = (r: DueRow): string[] => [
    `${targets.length > 1 ? r.instance + " " : ""}#${r.id}`,
    r.due_date ?? "—",
    r.days === null ? "—" : r.days < 0 ? `просроч. ${-r.days}д` : `${r.days}д`,
    `${r.done_ratio}%`,
    `${r.estimated_hours != null ? round2(r.estimated_hours) : "—"}/${
      r.spent_hours != null ? round2(r.spent_hours) : "—"
    }`,
    clip(r.status, 14),
    clip(r.subject, 55),
  ];
  const head = ["ЗАДАЧА", "СРОК", "ОСТ.", "ГОТОВ", "ОЦЕН./СПИС.", "СТАТУС", "ТЕМА"];
  const section = (title: string, list: DueRow[]): string =>
    list.length === 0 ? "" : `${title} (${list.length})\n${table([head, ...list.map(row)])}\n\n`;

  emit(
    {
      horizonDays: days,
      staleDays,
      counts: { overdue: overdue.length, today: today.length, soon: soon.length, stale: stale.length },
      issues: visible,
      staleIssues: showStale ? [] : stale,
    },
    () => {
      if (visible.length === 0) {
        return (
          `Задач со сроком в ближайшие ${days} дн. нет.` +
          (stale.length ? ` Скрыто ${stale.length} давно просроченных (--stale).` : "")
        );
      }
      const body =
        section("ПРОСРОЧЕНО", overdue) +
        section("СЕГОДНЯ", today) +
        section(`БЛИЖАЙШИЕ ${days} ДН.`, soon) +
        section("БЕЗ СРОКА", undated);
      const notes: string[] = [];
      if (!showStale && stale.length) notes.push(`скрыто ${stale.length} просроченных больше ${staleDays} дн. (--stale)`);
      if (hiddenByStatus) notes.push(`скрыто ${hiddenByStatus} по --exclude-status`);
      return body.trimEnd() + (notes.length ? `\n\n${notes.join("; ")}.` : "");
    },
  );
}

// ──────────────────────────── трудозатраты ────────────────────────────

type LogInput = {
  issue?: number;
  project?: string;
  hours: number;
  date: string;
  comment: string;
  activityId?: number;
};

async function buildEntryPayload(rm: Resolved, input: LogInput): Promise<Record<string, unknown>> {
  const te: Record<string, unknown> = {
    hours: round2(input.hours),
    spent_on: input.date,
    comments: input.comment,
  };
  if (input.issue !== undefined) te.issue_id = input.issue;
  else if (input.project !== undefined) te.project_id = await resolveProjectKey(rm, input.project);
  else throw new UserError("Нужен --issue <номер> или --project <проект>.");
  if (input.activityId !== undefined) te.activity_id = input.activityId;
  return te;
}

async function postEntry(rm: Resolved, payload: Record<string, unknown>): Promise<TimeEntry> {
  const r = await request<{ time_entry: TimeEntry }>(rm, "POST", "time_entries.json", undefined, {
    time_entry: payload,
  });
  return r.time_entry;
}

function describeEntry(rm: Resolved, e: TimeEntry): string {
  const target = e.issue ? `#${e.issue.id}` : e.project.name;
  const head = `entry ${e.id}: ${e.spent_on} ${h(e.hours)} ${target} [${e.activity.name}] ${e.comments ?? ""}`.trim();
  return e.issue ? `${head}\n  ${issueUrl(rm, e.issue.id)}` : head;
}

async function cmdLog(rm: Resolved, args: Args): Promise<void> {
  const issueRaw = str(args, "issue") ?? args.positional[0];
  const issue = issueRaw === undefined ? undefined : Number(issueRaw.replace("#", ""));
  if (issueRaw !== undefined && !Number.isInteger(issue)) {
    throw new UserError(`Номер задачи должен быть числом, получено "${issueRaw}".`);
  }
  const input: LogInput = {
    issue,
    project: str(args, "project") ?? (issue === undefined ? rm.defaultProject : undefined),
    hours: parseHours(required(args, "hours")),
    date: parseDate(str(args, "date") ?? "today"),
    comment: str(args, "comment") ?? str(args, "message") ?? "",
    activityId: await resolveActivityId(rm, str(args, "activity")),
  };
  const payload = await buildEntryPayload(rm, input);

  if (bool(args, "dry-run")) {
    emit({ dryRun: true, instance: rm.name, time_entry: payload }, () =>
      `ПРЕДПРОСМОТР (ничего не записано), инстанс ${rm.name}:\n${JSON.stringify(payload, null, 2)}`,
    );
    return;
  }
  const entry = await postEntry(rm, payload);
  emit(entry, () => `Записано: ${describeEntry(rm, entry)}`);
}

type BatchItem = {
  issue?: number | string;
  project?: string;
  hours: number | string;
  date?: string;
  comment?: string;
  activity?: string;
};

async function cmdBatch(rm: Resolved, args: Args): Promise<void> {
  const file = str(args, "file") ?? args.positional[0];
  const raw = file ? await Bun.file(file).text() : await new Response(Bun.stdin.stream()).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UserError("Ожидается JSON-массив записей (файл через --file или stdin).");
  }
  if (!Array.isArray(parsed)) throw new UserError("Ожидается JSON-массив записей.");
  const items = parsed as BatchItem[];

  const payloads: Record<string, unknown>[] = [];
  for (const item of items) {
    payloads.push(
      await buildEntryPayload(rm, {
        issue: item.issue === undefined ? undefined : Number(String(item.issue).replace("#", "")),
        project: item.project ?? (item.issue === undefined ? rm.defaultProject : undefined),
        hours: parseHours(String(item.hours)),
        date: parseDate(item.date ?? "today"),
        comment: item.comment ?? "",
        activityId: await resolveActivityId(rm, item.activity),
      }),
    );
  }

  const total = payloads.reduce((sum, p) => sum + Number(p.hours), 0);
  if (bool(args, "dry-run")) {
    emit({ dryRun: true, instance: rm.name, count: payloads.length, totalHours: round2(total), entries: payloads }, () =>
      `ПРЕДПРОСМОТР ${payloads.length} записей, итого ${h(total)} — инстанс ${rm.name}, ничего не записано:\n` +
        table([
          ["ДАТА", "ЦЕЛЬ", "ЧАСЫ", "КОММЕНТАРИЙ"],
          ...payloads.map((p) => [
            String(p.spent_on),
            p.issue_id ? `#${p.issue_id}` : String(p.project_id),
            h(Number(p.hours)),
            clip(String(p.comments ?? ""), 60),
          ]),
        ]),
    );
    return;
  }

  const created: TimeEntry[] = [];
  const failed: { index: number; error: string }[] = [];
  for (const [index, payload] of payloads.entries()) {
    try {
      created.push(await postEntry(rm, payload));
    } catch (e) {
      failed.push({ index, error: e instanceof Error ? e.message : String(e) });
    }
  }
  emit({ created, failed, totalHours: round2(created.reduce((s, e) => s + e.hours, 0)) }, () => {
    const lines = created.map((e) => describeEntry(rm, e));
    if (failed.length) {
      lines.push("", `ОШИБКИ (${failed.length}):`, ...failed.map((f) => `  запись #${f.index}: ${f.error}`));
    }
    lines.push("", `Итого записано: ${h(created.reduce((s, e) => s + e.hours, 0))} в ${created.length} записях.`);
    return lines.join("\n");
  });
  if (failed.length) process.exitCode = 1;
}

async function loadEntries(rm: Resolved, args: Args): Promise<{ from: string; to: string; entries: TimeEntry[] }> {
  const explicitRange = str(args, "from") !== undefined || str(args, "to") !== undefined;
  const period = str(args, "period") ?? (explicitRange ? undefined : "week");
  const [pFrom, pTo] = period ? parsePeriod(period) : ["", ""];
  const from = str(args, "from") ? parseDate(required(args, "from")) : pFrom;
  const to = str(args, "to") ? parseDate(required(args, "to")) : period ? pTo : fmtDate(new Date());

  const query: Query = { from, to };
  const user = str(args, "user") ?? "me";
  if (user !== "all") query.user_id = user === "me" ? (await currentUser(rm)).id : Number(user);
  const project = str(args, "project");
  if (project) query.project_id = await resolveProjectKey(rm, project);
  const issue = str(args, "issue");
  if (issue) query.issue_id = Number(issue.replace("#", ""));

  const entries = await fetchAll<TimeEntry>(rm, "time_entries.json", "time_entries", query, num(args, "limit") ?? 500);
  return { from, to, entries };
}

function groupBy(entries: TimeEntry[], mode: string): Map<string, TimeEntry[]> {
  const out = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const key =
      mode === "date"
        ? e.spent_on
        : mode === "project"
          ? e.project.name
          : mode === "activity"
            ? e.activity.name
            : mode === "user"
              ? e.user.name
              : e.issue
                ? `#${e.issue.id}`
                : `${e.project.name} (без задачи)`;
    const bucket = out.get(key);
    if (bucket) bucket.push(e);
    else out.set(key, [e]);
  }
  return out;
}

async function cmdEntries(rm: Resolved, args: Args): Promise<void> {
  const { from, to, entries } = await loadEntries(rm, args);
  const total = entries.reduce((s, e) => s + e.hours, 0);
  const group = str(args, "group");

  if (!group) {
    emit({ instance: rm.name, from, to, totalHours: round2(total), entries }, () =>
      entries.length === 0
        ? `За ${from}..${to} записей нет.`
        : table([
            ["ID", "ДАТА", "ЧАСЫ", "ЦЕЛЬ", "ВИД", "КОММЕНТАРИЙ"],
            ...entries.map((e) => [
              String(e.id),
              e.spent_on,
              h(e.hours),
              e.issue ? `#${e.issue.id}` : clip(e.project.name, 20),
              clip(e.activity.name, 16),
              clip(e.comments ?? "", 60),
            ]),
          ]) + `\n\nИтого за ${from}..${to}: ${h(total)} в ${entries.length} записях.`,
    );
    return;
  }

  const grouped = [...groupBy(entries, group).entries()]
    .map(([key, list]) => ({
      key,
      hours: round2(list.reduce((s, e) => s + e.hours, 0)),
      count: list.length,
      comments: [...new Set(list.map((e) => e.comments).filter(Boolean))],
    }))
    .sort((a, b) => (group === "date" ? a.key.localeCompare(b.key) : b.hours - a.hours));

  emit({ instance: rm.name, from, to, group, totalHours: round2(total), groups: grouped }, () =>
    grouped.length === 0
      ? `За ${from}..${to} записей нет.`
      : table([
          [group === "date" ? "ДАТА" : group === "project" ? "ПРОЕКТ" : group === "activity" ? "ВИД" : "ЗАДАЧА", "ЧАСЫ", "ЗАП.", "КОММЕНТАРИИ"],
          ...grouped.map((g) => [g.key, h(g.hours), String(g.count), clip(g.comments.join(" | "), 70)]),
        ]) + `\n\nИтого за ${from}..${to}: ${h(total)}.`,
  );
}

async function cmdGaps(rm: Resolved, args: Args): Promise<void> {
  const { from, to, entries } = await loadEntries(rm, args);
  const target = num(args, "target") ?? rm.dailyTargetHours ?? 8;
  const includeWeekends = bool(args, "weekends");

  const perDay = new Map<string, number>();
  for (const e of entries) perDay.set(e.spent_on, (perDay.get(e.spent_on) ?? 0) + e.hours);

  const days: { date: string; hours: number; weekend: boolean; missing: number }[] = [];
  for (let d = new Date(`${from}T00:00:00`); fmtDate(d) <= to; d = shiftDays(d, 1)) {
    const date = fmtDate(d);
    const dow = d.getDay();
    const weekend = dow === 0 || dow === 6;
    if (weekend && !includeWeekends) continue;
    const hours = round2(perDay.get(date) ?? 0);
    days.push({ date, hours, weekend, missing: round2(Math.max(0, target - hours)) });
  }

  const under = days.filter((d) => d.missing > 0);
  const totalLogged = round2(days.reduce((s, d) => s + d.hours, 0));
  const totalMissing = round2(under.reduce((s, d) => s + d.missing, 0));
  const dow = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

  emit({ instance: rm.name, from, to, target, days, under, totalLogged, totalMissing }, () =>
    table([
      ["ДАТА", "ДЕНЬ", "СПИСАНО", "НЕ ХВАТАЕТ"],
      ...days.map((d) => [
        d.date,
        dow[new Date(`${d.date}T00:00:00`).getDay()]!,
        h(d.hours),
        d.missing > 0 ? h(d.missing) : "—",
      ]),
    ]) +
      `\n\nПериод ${from}..${to}: списано ${h(totalLogged)}, недобор ${h(totalMissing)} ` +
      `(норма ${h(target)}/день, дней с недобором: ${under.length}).`,
  );
}

async function cmdEdit(rm: Resolved, args: Args): Promise<void> {
  const id = Number(args.positional[0] ?? required(args, "id"));
  if (!Number.isInteger(id)) throw new UserError("Укажите id записи: redmine.ts edit 4567 --hours 3");
  const patch: Record<string, unknown> = {};
  const hours = str(args, "hours");
  if (hours) patch.hours = round2(parseHours(hours));
  const date = str(args, "date");
  if (date) patch.spent_on = parseDate(date);
  const comment = str(args, "comment");
  if (comment !== undefined) patch.comments = comment;
  const activity = str(args, "activity");
  if (activity) patch.activity_id = await resolveActivityId(rm, activity);
  const issue = str(args, "issue");
  if (issue) patch.issue_id = Number(issue.replace("#", ""));
  if (Object.keys(patch).length === 0) {
    throw new UserError("Нечего менять: задайте --hours/--date/--comment/--activity/--issue.");
  }

  if (bool(args, "dry-run")) {
    emit({ dryRun: true, id, patch }, () => `ПРЕДПРОСМОТР правки записи ${id}:\n${JSON.stringify(patch, null, 2)}`);
    return;
  }
  await request(rm, "PUT", `time_entries/${id}.json`, undefined, { time_entry: patch });
  const r = await request<{ time_entry: TimeEntry }>(rm, "GET", `time_entries/${id}.json`);
  emit(r.time_entry, () => `Обновлено: ${describeEntry(rm, r.time_entry)}`);
}

async function cmdDelete(rm: Resolved, args: Args): Promise<void> {
  const id = Number(args.positional[0] ?? required(args, "id"));
  if (!Number.isInteger(id)) throw new UserError("Укажите id записи: redmine.ts delete 4567 --yes");
  if (!bool(args, "yes")) throw new UserError(`Удаление необратимо. Повторите с --yes: redmine.ts delete ${id} --yes`);
  await request(rm, "DELETE", `time_entries/${id}.json`);
  emit({ deleted: id }, () => `Запись ${id} удалена.`);
}

// ─────────────────────────────── справка ──────────────────────────────

function cmdHelp(): void {
  console.log(`redmine.ts — CLI для Redmine (Bun).

Общие флаги: --instance <имя|хост>  --all-instances (для inbox/due)  --json  --no-cache

Настройка
  instances                         профили из конфига и их состояние
  whoami                            кто я на этом инстансе
  activities | statuses | trackers  виды деятельности / статусы / трекеры и приоритеты
  projects [строка]                 проекты (фильтр по имени/identifier)

Что нового и сроки
  inbox [--since 2026-09-20|-3|12h] [--mark] [--watched] [--authored] [--include-own]
        новые задачи на мне, новые комментарии и изменения; --mark запоминает отметку «просмотрено»
  due [--days 14] [--all] [--project X] [--anyone]
        задачи на мне со сроками: просроченные, сегодня, ближайшие

Задачи
  issue <id> [--comments N]         карточка задачи с последними событиями
  issues [--subject текст] [--project X] [--status open|closed|имя] [--mine|--assignee me|id]
         [--watched] [--due-before дата] [--limit N] [--sort updated_on:desc]
  search "фраза" [--project X]      полнотекстовый поиск
  create-issue --project X --subject "..." [--description "..."|--description-file f]
               [--tracker имя] [--priority имя] [--assignee me] [--start дата] [--due дата]
               [--estimated 8] [--parent N] [--dry-run]
  comment <id> --text "..."|--text-file f [--private] [--dry-run]
  update-issue <id> [--status имя] [--done N] [--note текст] [--assignee me] [--due дата] [--dry-run]

Трудозатраты
  log --issue N --hours 2.5 [--date today|YYYY-MM-DD|-1] [--comment "..."] [--activity имя] [--dry-run]
  batch [--file entries.json | stdin] [--dry-run]
        JSON-массив: [{"issue":1234,"hours":"1h30","date":"2026-09-21","comment":"...","activity":"Разработка"}]
  entries [--period week|last-week|month|last-month|YYYY-MM|A..B] [--from --to]
          [--user me|id|all] [--project X] [--issue N] [--group issue|date|project|activity|user]
  gaps [--period ...] [--target 8] [--weekends]      дни с недобором часов
  edit <entryId> [--hours|--date|--comment|--activity|--issue] [--dry-run]
  delete <entryId> --yes

Форматы: часы 2 | 2.5 | 1h30 | 1:30 | 90m; даты YYYY-MM-DD | DD.MM[.YYYY] | today | yesterday | -3.
Конфиг: ${CONFIG_PATH} (env REDMINE_URL / REDMINE_API_KEY / REDMINE_INSTANCE имеют приоритет).`);
}

// ─────────────────────────────── точка входа ──────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  jsonMode = bool(args, "json");
  noCache = bool(args, "no-cache") || bool(args, "refresh");

  if (args.cmd === "help" || bool(args, "help")) {
    cmdHelp();
    return;
  }
  if (args.cmd === "instances" || args.cmd === "config") {
    await cmdInstances(args);
    return;
  }
  if (args.cmd === "inbox" || args.cmd === "new") {
    await cmdInbox(args);
    return;
  }
  if (args.cmd === "due" || args.cmd === "deadlines") {
    await cmdDue(args);
    return;
  }

  const rm = await resolveInstance(str(args, "instance"));
  const handlers: Record<string, (rm: Resolved, a: Args) => Promise<void>> = {
    whoami: cmdWhoami,
    activities: cmdActivities,
    statuses: cmdStatuses,
    projects: cmdProjects,
    issue: cmdIssue,
    issues: cmdIssues,
    search: cmdSearch,
    trackers: cmdTrackers,
    "create-issue": cmdCreateIssue,
    comment: cmdComment,
    log: cmdLog,
    batch: cmdBatch,
    entries: cmdEntries,
    report: cmdEntries,
    gaps: cmdGaps,
    edit: cmdEdit,
    delete: cmdDelete,
    "update-issue": cmdUpdateIssue,
  };
  const handler = handlers[args.cmd];
  if (!handler) throw new UserError(`Неизвестная команда "${args.cmd}". Список команд: redmine.ts help`);
  await handler(rm, args);
}

try {
  await main();
} catch (error) {
  if (error instanceof UserError) console.error(`Ошибка: ${error.message}`);
  else if (error instanceof ApiError) console.error(`Redmine API: ${error.message}`);
  else console.error(`Сбой: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

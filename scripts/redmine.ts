#!/usr/bin/env bun
/**
 * Redmine CLI — трудозатраты, задачи, входящие события, отчёты.
 * Bun + TypeScript, нулевые зависимости, нативный fetch.
 *
 * Конфиг: ~/.redmine/config.json (профили инстансов), env имеет приоритет.
 * Вывод: человекочитаемый текст, либо --json для машинного разбора.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { guard, scanText, formatFindings, type Audience, type Finding } from "./guard.ts";
import { harvestRepo, isGitRepo, repoName, draftDescription, type RepoBinding } from "./harvest.ts";

// ─────────────────────────────── конфиг ───────────────────────────────

type Instance = {
  url: string;
  apiKey: string;
  defaultActivity?: string;
  defaultProject?: string;
  dailyTargetHours?: number;
  projectAliases?: Record<string, string>;
  /** Разметка описаний и комментариев: textile (по умолчанию), markdown или html. */
  markup?: "textile" | "markdown" | "html";
};

type ConfigFile = {
  default?: string;
  instances: Record<string, Instance>;
  /** Привязка репозиториев к инстансу и проекту: ключ — путь или owner/repo. */
  repos?: Record<string, RepoBinding>;
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
      markup:
        value.markup === "textile" || value.markup === "markdown" || value.markup === "html" ? value.markup : undefined,
    };
  }
  const repos: Record<string, RepoBinding> = {};
  if (isRecord(raw.repos)) {
    for (const [key, value] of Object.entries(raw.repos)) {
      if (!isRecord(value)) continue;
      repos[key] = {
        instance: typeof value.instance === "string" ? value.instance : undefined,
        project: typeof value.project === "string" ? value.project : undefined,
        client: typeof value.client === "string" ? value.client : undefined,
        activity: typeof value.activity === "string" ? value.activity : undefined,
        tracker: typeof value.tracker === "string" ? value.tracker : undefined,
      };
    }
  }

  return {
    default: typeof raw.default === "string" ? raw.default : undefined,
    instances: parsed,
    repos: Object.keys(repos).length > 0 ? repos : undefined,
  };
}

/** Ключи привязки сравниваем без учёта регистра и вида слэшей. */
function normalizeRepoKey(key: string): string {
  return key.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function writeConfigFile(cfg: ConfigFile): Promise<void> {
  await Bun.write(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
type StatusRef = IdName & { is_closed?: boolean };

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
  /** Суммы с учётом подзадач — Redmine считает их сам для родительских задач. */
  total_estimated_hours?: number | null;
  total_spent_hours?: number | null;
  start_date?: string | null;
  due_date?: string | null;
  created_on: string;
  updated_on: string;
  journals?: Journal[];
  /** Переходы, разрешённые рабочим процессом для текущей роли. */
  allowed_statuses?: IdName[];
  /** Связи с другими задачами — приходят при include=relations. */
  relations?: IssueRelation[];
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

type ProjectRef = {
  id: number;
  name: string;
  identifier: string;
  status: number;
  description?: string | null;
  homepage?: string | null;
  is_public?: boolean;
  inherit_members?: boolean;
  parent?: { id: number; name: string };
  trackers?: IdName[];
  enabled_modules?: IdName[];
  custom_fields?: CustomFieldValue[];
};

/** Значение пользовательского поля так, как его отдаёт Redmine в карточке объекта. */
type CustomFieldValue = { id: number; name: string; value: unknown };

/** Описание пользовательского поля из справочника: доступно только администратору. */
type CustomFieldDef = {
  id: number;
  name: string;
  customized_type?: string;
  field_format?: string;
  is_required?: boolean;
  multiple?: boolean;
  possible_values?: (string | { value: string; label?: string })[];
};

type CurrentUser = {
  id: number;
  login: string;
  firstname: string;
  lastname: string;
  mail?: string;
  /** Redmine отдаёт признак администратора только про самого себя — по нему видно, пройдёт ли архивирование. */
  admin?: boolean;
};

/** Роль в членстве. `inherited` — роль пришла от группы или родительского проекта: здесь её не снять. */
export type MemberRole = IdName & { inherited?: boolean };

/** Членство в проекте: участник — пользователь либо группа, у каждого свой набор ролей. */
export type Membership = {
  id: number;
  project: IdName;
  user?: IdName;
  group?: IdName;
  roles: MemberRole[];
};

/**
 * Роль из справочника. Права приходят только из `roles/:id.json` — в общем списке их нет,
 * а без них предпросмотр не скажет, что роль даёт человеку.
 */
export type RoleInfo = {
  id: number;
  name: string;
  /** Можно ли назначать задачи на обладателя роли. */
  assignable?: boolean;
  /** all — все задачи, default — все, кроме приватных, own — только свои. */
  issues_visibility?: string;
  /** all — все списания проекта, own — только свои. */
  time_entries_visibility?: string;
  /** null — права прочитать не удалось; [] — у роли их действительно нет. */
  permissions: string[] | null;
};

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

/** После создания или правки проекта кэш врёт до конца суток — запись сбрасывается сразу. */
async function cacheDrop(rm: Resolved, key: string): Promise<void> {
  if (cacheMemo === null) return;
  delete cacheMemo[`${rm.name}:${key}`];
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

async function statuses(rm: Resolved): Promise<StatusRef[]> {
  return cached(rm, "statuses", async () => {
    const r = await request<{ issue_statuses: StatusRef[] }>(rm, "GET", "issue_statuses.json");
    return r.issue_statuses;
  });
}

async function projects(rm: Resolved): Promise<ProjectRef[]> {
  return cached(rm, "projects", async () =>
    fetchAll<ProjectRef>(rm, "projects.json", "projects", { include: "trackers,enabled_modules" }, 1000),
  );
}

/**
 * Redmine отдаёт в projects.json только действующие проекты, поэтому всё, чего там нет,
 * закрыто или архивировано. Задачи таких проектов доступны только для чтения: закрыть
 * или прокомментировать их нельзя, пока проект не откроют заново.
 */
async function activeProjectIds(rm: Resolved): Promise<Set<number>> {
  return new Set((await projects(rm)).map((p) => p.id));
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

/** Разбор роли из ответа Redmine: поля старых версий бывают пустыми, типам ответа не доверяем. */
function asRole(raw: unknown, fallback: IdName): RoleInfo {
  if (!isRecord(raw)) return { id: fallback.id, name: fallback.name, permissions: null };
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return {
    id: fallback.id,
    name: fallback.name,
    assignable: typeof raw.assignable === "boolean" ? raw.assignable : undefined,
    issues_visibility: text(raw.issues_visibility),
    time_entries_visibility: text(raw.time_entries_visibility),
    permissions: Array.isArray(raw.permissions)
      ? raw.permissions.filter((p): p is string => typeof p === "string")
      : null,
  };
}

async function roles(rm: Resolved): Promise<RoleInfo[]> {
  return cached(rm, "roles", async () => {
    const r = await request<{ roles: IdName[] }>(rm, "GET", "roles.json");
    return mapLimit(r.roles ?? [], 4, async (role) => {
      try {
        const full = await request<{ role: unknown }>(rm, "GET", `roles/${role.id}.json`);
        return asRole(full.role, role);
      } catch (error) {
        // Карточка роли есть не во всех версиях Redmine: без прав роль всё равно назначается по имени.
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return asRole(null, role);
        throw error;
      }
    });
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

const membersMemo = new Map<string, IdName[]>();

/**
 * Участники проекта — единственный доступный нам справочник людей: `/users.json`
 * закрыт правами администратора, а назначить задачу всё равно можно только участнику.
 */
async function projectMembers(rm: Resolved, project: string | number): Promise<IdName[]> {
  const key = `${rm.name}:${project}`;
  const hit = membersMemo.get(key);
  if (hit) return hit;
  const list = (await loadMemberships(rm, project)).flatMap((m) => (m.user ? [m.user] : []));
  membersMemo.set(key, list);
  return list;
}

/**
 * Все членства проекта — постранично и без кэша: у крупного проекта участников больше сотни,
 * а сверка после записи обязана видеть состояние Redmine, а не память скрипта.
 */
async function loadMemberships(rm: Resolved, project: string | number): Promise<Membership[]> {
  return fetchAll<Membership>(rm, `projects/${project}/memberships.json`, "memberships", {}, 2000);
}

/**
 * Исполнитель по «me», номеру или имени.
 *
 * Имя разрешается по участникам проекта. Без этого `Number("Соловьёв")` давал NaN,
 * уходил в JSON как null, Redmine молча оставлял поле как было, а команда отвечала
 * «обновлена» — назначение терялось незаметно.
 */
async function resolveAssignee(
  rm: Resolved,
  value: string,
  project: string | number | undefined,
): Promise<number> {
  const raw = value.trim();
  if (raw === "me") return (await currentUser(rm)).id;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (project === undefined) {
    throw new UserError(
      `Исполнитель "${raw}": не по чему искать — проект не определён. Укажите номер: --assignee <id>.`,
    );
  }
  const members = await projectMembers(rm, project);
  if (members.length === 0) {
    throw new UserError(
      `Исполнитель "${raw}": список участников проекта пуст или закрыт правами. Укажите номер: --assignee <id>.`,
    );
  }
  return matchByName(members, raw, "Исполнитель").id;
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

// ───────────────────────────── проекты ────────────────────────────────

/** Карточка проекта целиком — для предпросмотра и разбора иерархии. */
async function findProject(rm: Resolved, value: string): Promise<ProjectRef> {
  const key = (rm.projectAliases?.[value] ?? value).trim().replace(/^#/, "");
  const list = await projects(rm);
  if (/^\d+$/.test(key)) {
    const byId = list.find((p) => p.id === Number(key));
    if (byId) return byId;
  }
  const byIdent = list.find((p) => p.identifier.toLowerCase() === key.toLowerCase());
  if (byIdent) return byIdent;
  const low = key.toLowerCase();
  const byName = list.filter((p) => p.name.toLowerCase().includes(low));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new UserError(
      `Проект "${value}" неоднозначен: ${byName.map((p) => `${p.name} (${p.identifier})`).join(", ")}.`,
    );
  }
  throw new UserError(`Проект "${value}" не найден. Список: redmine.ts projects`);
}

function projectUrl(rm: Resolved, identifier: string): string {
  return `${rm.base}projects/${identifier}`;
}

/** Транслитерация кириллицы: идентификатор проекта Redmine принимает только латиницу. */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g", ў: "u",
};

export function translit(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) out += TRANSLIT[ch] ?? ch;
  return out;
}

/**
 * Идентификатор из названия: транслитерация, нижний регистр, дефисы вместо остального,
 * не длиннее 100 символов. Результат всё равно проверяется — `identifierProblem`.
 */
export function slugIdentifier(name: string): string {
  return translit(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

/**
 * Что не так с идентификатором, или null — если он годится.
 * Правило ровно то же, что у самого Redmine: строчная латиница, цифры, дефис и подчёркивание,
 * не длиннее 100 символов, и запрещён только идентификатор из одних цифр — он неотличим от id
 * проекта в адресе. Цифра в начале при этом допустима: «33 Решения» → `33-resheniya`.
 */
export function identifierProblem(identifier: string): string | null {
  if (identifier.length === 0) return "он пустой";
  if (identifier.length > 100) return `в нём ${identifier.length} символов, допустимо не больше 100`;
  const bad = [...new Set([...identifier].filter((c) => !/[a-z0-9_-]/.test(c)))];
  if (bad.length > 0) {
    const shown = bad.map((c) => (c === " " ? "пробел" : `«${c}»`)).join(", ");
    return `недопустимые символы: ${shown} — разрешены строчные латинские буквы, цифры, дефис и подчёркивание`;
  }
  if (/^\d+$/.test(identifier)) {
    return "он состоит из одних цифр — Redmine такой не принимает, потому что не отличит его от номера проекта в адресе";
  }
  return null;
}

type IdentifierState = "free" | "taken" | "hidden";

/**
 * Занятость идентификатора проверяется до отправки: Redmine иначе отвечает 422 уже по факту.
 * Проект может быть закрыт или архивирован — тогда его нет в списке, но идентификатор занят.
 */
async function identifierState(rm: Resolved, identifier: string): Promise<IdentifierState> {
  const known = (await projects(rm)).find((p) => p.identifier.toLowerCase() === identifier.toLowerCase());
  if (known) return "taken";
  try {
    await request(rm, "GET", `projects/${identifier}.json`);
    return "taken";
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return "free";
    if (error instanceof ApiError && error.status === 403) return "hidden";
    throw error;
  }
}

/** Штатные модули Redmine: есть на любом инстансе, даже если сейчас нигде не включены. */
const CORE_MODULES = [
  "issue_tracking",
  "time_tracking",
  "news",
  "documents",
  "files",
  "wiki",
  "repository",
  "boards",
  "calendar",
  "gantt",
];

/** Набор модулей инстанса: штатные плюс всё, что реально включено в видимых проектах. */
async function instanceModules(rm: Resolved): Promise<string[]> {
  const seen = new Set(CORE_MODULES);
  for (const p of await projects(rm)) for (const m of p.enabled_modules ?? []) seen.add(m.name);
  return [...seen].sort();
}

/** Разбирает список имён целиком и сообщает обо всех промахах разом, а не о первом. */
function resolveManyByName<T extends IdName>(items: T[], names: string[], kind: string): T[] {
  const picked: T[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const name of names) {
    const low = name.trim().toLowerCase();
    const exact = items.find((i) => i.name.toLowerCase() === low);
    if (exact) {
      if (!picked.includes(exact)) picked.push(exact);
      continue;
    }
    if (/^\d+$/.test(low)) {
      const byId = items.find((i) => i.id === Number(low));
      if (byId) {
        if (!picked.includes(byId)) picked.push(byId);
        continue;
      }
    }
    const partial = items.filter((i) => i.name.toLowerCase().includes(low));
    if (partial.length === 1) {
      if (!picked.includes(partial[0]!)) picked.push(partial[0]!);
      continue;
    }
    if (partial.length > 1) ambiguous.push(`${name} → ${partial.map((i) => i.name).join(", ")}`);
    else unknown.push(name);
  }
  if (unknown.length > 0 || ambiguous.length > 0) {
    throw new UserError(
      [
        unknown.length > 0 ? `${kind}: не найдено — ${unknown.join(", ")}.` : "",
        ambiguous.length > 0 ? `${kind}: неоднозначно — ${ambiguous.join("; ")}.` : "",
        `Доступно на этом инстансе: ${items.map((i) => i.name).join(", ")}.`,
      ]
        .filter(Boolean)
        .join("\n  "),
    );
  }
  return picked;
}

/** То же для модулей: они опознаются техническим именем (issue_tracking, wiki, …). */
function resolveModules(available: string[], names: string[]): string[] {
  const picked: string[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const name of names) {
    const low = name.trim().toLowerCase();
    const exact = available.find((m) => m.toLowerCase() === low);
    if (exact) {
      if (!picked.includes(exact)) picked.push(exact);
      continue;
    }
    const partial = available.filter((m) => m.toLowerCase().includes(low));
    if (partial.length === 1) {
      if (!picked.includes(partial[0]!)) picked.push(partial[0]!);
      continue;
    }
    if (partial.length > 1) ambiguous.push(`${name} → ${partial.join(", ")}`);
    else unknown.push(name);
  }
  if (unknown.length > 0 || ambiguous.length > 0) {
    throw new UserError(
      [
        unknown.length > 0 ? `Модули: не найдено — ${unknown.join(", ")}.` : "",
        ambiguous.length > 0 ? `Модули: неоднозначно — ${ambiguous.join("; ")}.` : "",
        `Известные модули этого инстанса: ${available.join(", ")}.`,
      ]
        .filter(Boolean)
        .join("\n  "),
    );
  }
  return picked;
}

// ─────────────────── пользовательские поля проектов ───────────────────

/**
 * Что скилл знает о пользовательском поле проекта — и откуда узнал.
 * Справочник `custom_fields.json` открыт только администратору, поэтому имена и номера полей
 * собираются ещё и из карточек видимых проектов: без этого `--field` был бы бесполезен
 * на инстансе, где ключ выдан обычному пользователю.
 */
export type ProjectField = {
  id: number;
  name: string;
  /** Формат поля из справочника: list, bool, string, … — пусто, если справочник закрыт. */
  format?: string;
  /** Обязательность известна только из справочника. */
  required?: boolean;
  multiple?: boolean;
  /** Допустимые значения списка; пусто — набор неизвестен. */
  allowed: string[];
  /** Значения, встреченные в видимых проектах: подсказка, когда справочник закрыт. */
  seen: string[];
};

type ProjectFieldsInfo = {
  fields: ProjectField[];
  /** Справочник не отдан: прав администратора нет, полнота набора не гарантируется. */
  adminDenied: boolean;
};

function customFieldValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((v) => customFieldValues(v));
  return [];
}

async function projectFields(rm: Resolved): Promise<ProjectFieldsInfo> {
  const reference = await cached(rm, "project-custom-fields", async () => {
    try {
      const r = await request<{ custom_fields: CustomFieldDef[] }>(rm, "GET", "custom_fields.json");
      const defs = (r.custom_fields ?? []).filter((f) => (f.customized_type ?? "project") === "project");
      return { denied: false, defs };
    } catch (error) {
      // 403 — ключ не администраторский; 404 — эндпоинта нет (Redmine старше 4.1) или закрыт прокси.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return { denied: true, defs: [] as CustomFieldDef[] };
      }
      throw error;
    }
  });

  const observed = new Map<number, { name: string; values: Set<string> }>();
  for (const p of await projects(rm)) {
    for (const f of p.custom_fields ?? []) {
      const slot = observed.get(f.id) ?? { name: f.name, values: new Set<string>() };
      for (const v of customFieldValues(f.value)) slot.values.add(v);
      observed.set(f.id, slot);
    }
  }

  const fields = new Map<number, ProjectField>();
  for (const def of reference.defs) {
    fields.set(def.id, {
      id: def.id,
      name: def.name,
      format: def.field_format,
      required: def.is_required === true,
      multiple: def.multiple === true,
      allowed: (def.possible_values ?? []).map((v) => (typeof v === "string" ? v : v.value)),
      seen: [],
    });
  }
  for (const [id, slot] of observed) {
    const known = fields.get(id);
    const seen = [...slot.values].sort((a, b) => a.localeCompare(b, "ru"));
    if (known) known.seen = seen;
    else fields.set(id, { id, name: slot.name, allowed: [], seen });
  }
  return { fields: [...fields.values()].sort((a, b) => a.id - b.id), adminDenied: reference.denied };
}

/** Разбор одного `--field "имя=значение"`. Значение может содержать запятые и знаки «=». */
export function parseFieldSpec(raw: string): { key: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq === -1) {
    throw new UserError(`Флаг --field ожидает «имя=значение», получено "${raw}". Пример: --field "Статус=Проект".`);
  }
  const key = raw.slice(0, eq).trim();
  if (!key) throw new UserError(`В «--field ${raw}» не указано имя поля.`);
  return { key, value: raw.slice(eq + 1).trim() };
}

export type FieldAssignment = { id: number; name: string; value: string; note: string };

const BOOL_TRUE = ["1", "да", "true", "yes", "истина", "включено"];
const BOOL_FALSE = ["0", "нет", "false", "no", "ложь", "выключено"];

/**
 * Имя поля превращается в номер до отправки: Redmine на неизвестное имя ответит 422 без
 * пояснения, а на неизвестный номер — молча проигнорирует значение.
 */
export function assignProjectFields(
  known: ProjectField[],
  specs: { key: string; value: string }[],
): FieldAssignment[] {
  const out: FieldAssignment[] = [];
  const catalogue = known.map((f) => `«${f.name}» (id=${f.id})`).join(", ");

  for (const { key, value } of specs) {
    let field: ProjectField | undefined;
    if (/^\d+$/.test(key)) {
      field = known.find((f) => f.id === Number(key));
      if (!field && known.length > 0) {
        throw new UserError(
          `Пользовательского поля проекта с номером ${key} на этом инстансе нет.\n` +
            `  Известные поля: ${catalogue}. Полный список — redmine.ts project-fields.`,
        );
      }
      if (!field) {
        out.push({ id: Number(key), name: `поле #${key}`, value, note: "номер задан вручную, имя неизвестно" });
        continue;
      }
    } else {
      const low = key.toLowerCase();
      field = known.find((f) => f.name.toLowerCase() === low);
      if (!field) {
        const partial = known.filter((f) => f.name.toLowerCase().includes(low));
        if (partial.length === 1) field = partial[0];
        else if (partial.length > 1) {
          throw new UserError(
            `Поле "${key}" неоднозначно: ${partial.map((f) => `«${f.name}»`).join(", ")}. Назовите его полностью или номером.`,
          );
        }
      }
      if (!field) {
        throw new UserError(
          known.length > 0
            ? `Пользовательского поля проекта "${key}" на этом инстансе нет.\n` +
              `  Доступно: ${catalogue}. Подробности — redmine.ts project-fields.`
            : `Пользовательские поля проектов на этом инстансе не видны, поэтому имя "${key}" распознать нечем.\n` +
              `  Если поле существует, задайте его номером: --field "12=${value || "значение"}".\n` +
              `  Номер видно в адресе поля в интерфейсе: «Администрирование → Поля → нужное поле».`,
        );
      }
    }

    let normalized = value;
    let note = "";
    if (field.format === "bool") {
      const low = value.toLowerCase();
      if (BOOL_TRUE.includes(low)) normalized = "1";
      else if (BOOL_FALSE.includes(low)) normalized = "0";
      else throw new UserError(`Поле «${field.name}» логическое: допустимо «да» или «нет», получено "${value}".`);
      note = normalized === "1" ? "да" : "нет";
    } else if (field.allowed.length > 0 && value !== "") {
      const hit = field.allowed.find((v) => v.toLowerCase() === value.toLowerCase());
      if (!hit) {
        throw new UserError(
          `Значение "${value}" не подходит полю «${field.name}»: это список.\n` +
            `  Допустимые значения: ${field.allowed.join(", ")}.`,
        );
      }
      normalized = hit;
    } else if (field.allowed.length === 0 && field.seen.length > 0 && value !== "") {
      const seen = field.seen.some((v) => v.toLowerCase() === value.toLowerCase());
      note = seen ? "" : `значение не встречалось в видимых проектах (встречались: ${field.seen.join(", ")})`;
    }
    if (value === "") note = note || "значение пустое — поле будет очищено";

    out.push({ id: field.id, name: field.name, value: normalized, note });
  }
  return out;
}

/** Читает повторяемый `--field` и сразу разворачивает имена в номера. */
async function fieldAssignments(rm: Resolved, args: Args): Promise<{ list: FieldAssignment[]; info: ProjectFieldsInfo }> {
  // values() режет значения по запятым, а значение поля запятую содержать может — берём сырые.
  const raw = (args.repeated.get("field") ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
  const info = await projectFields(rm);
  if (raw.length === 0) return { list: [], info };
  return { list: assignProjectFields(info.fields, raw.map(parseFieldSpec)), info };
}

/**
 * 422 «поле не может быть пустым» — самая частая причина отказа на инстансе с обязательными
 * полями проекта. Разворачиваем её в подсказку: какое поле и чем его заполнить.
 */
function explainRequiredFields(details: string[], info: ProjectFieldsInfo): string | null {
  const flat = details.join("; ").toLowerCase();
  const named = info.fields.filter((f) => flat.includes(f.name.toLowerCase()));
  const candidates = named.length > 0 ? named : info.fields.filter((f) => f.required === true);
  if (candidates.length === 0) return null;
  return candidates
    .map((f) => {
      const allowed = f.allowed.length > 0 ? f.allowed : f.seen;
      return (
        `  Поле «${f.name}» (id=${f.id}) обязательно на этом инстансе. Задайте его: --field "${f.name}=<значение>"` +
        (allowed.length > 0
          ? `\n    ${f.allowed.length > 0 ? "Допустимые значения" : "Значения из других проектов"}: ${allowed.join(", ")}`
          : "")
      );
    })
    .join("\n");
}

/**
 * Отказ Redmine по проекту почти всегда про права владельца ключа, а не про запрос.
 * Голый «403» читателю ничего не объясняет, поэтому называем недостающее разрешение.
 */
async function withProjectRights<T>(
  what: "create" | "update" | "archive",
  context: string,
  fn: () => Promise<T>,
  options: {
    /** Известно ли, что проект существует: от этого зависит, чем на самом деле был 404. */
    projectExists?: boolean;
    /** Чем объяснить 422: обязательные пользовательские поля инстанса. */
    fields?: ProjectFieldsInfo;
  } = {},
): Promise<T> {
  const projectExists = options.projectExists === true;
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 403) {
      const reason: Record<typeof what, string> = {
        create:
          `Создание проекта отклонено: у владельца ключа нет на это права. ${context}\n` +
          `  Верхнеуровневый проект заводит администратор Redmine либо пользователь, которому это разрешено ` +
          `в «Администрирование → Настройки → Проекты».\n` +
          `  Подпроект может завести тот, у кого в родительском проекте есть роль с разрешением ` +
          `«Создание подпроектов».\n` +
          `  Что делать: попросить администратора выдать право или создать проект самому — через интерфейс Redmine.`,
        update:
          `Правка проекта отклонена: не хватает прав. ${context}\n` +
          `  Настройки проекта меняет тот, у кого в проекте есть роль с разрешением «Редактирование проекта».\n` +
          `  Смена родителя доступна администратору или тому, кому разрешено добавлять подпроекты к новому родителю.\n` +
          `  Что делать: попросить администратора изменить настройки либо выдать роль.`,
        archive:
          `Архивирование отклонено: операция доступна только администратору Redmine. ${context}\n` +
          `  Архивирует администратор — в интерфейсе: «Администрирование → Проекты → нужный проект → Архивировать».\n` +
          `  Ключ обычного пользователя прав на это не даёт: просите администратора, обходного пути нет.`,
      };
      throw new UserError(reason[what]);
    }
    if (error.status === 422) {
      const required = options.fields ? explainRequiredFields(error.details, options.fields) : null;
      throw new UserError(
        `Redmine отклонил данные проекта: ${error.details.join("; ") || "без пояснения"}.\n` +
          (required
            ? `${required}\n  Весь список полей инстанса — redmine.ts project-fields.`
            : `  Проверьте идентификатор (должен быть свободен), родителя и обязательные поля проекта на этом инстансе:\n` +
              `  redmine.ts project-fields.`),
      );
    }
    if (error.status === 404 && what === "archive") {
      throw new UserError(
        projectExists
          ? `Инстанс не поддерживает архивирование через API: эндпоинт появился в Redmine 5.0. ${context}\n` +
            `  Архивируйте через интерфейс: «Администрирование → Проекты».`
          : `Redmine ответил «не найдено». ${context}\n` +
            `  Либо проекта с таким идентификатором нет — проверьте списком: redmine.ts projects,\n` +
            `  либо инстанс старше Redmine 5.0: архивирование через API появилось только там.\n` +
            `  Надёжный путь в обоих случаях — интерфейс: «Администрирование → Проекты».`,
      );
    }
    throw error;
  }
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

export function parseDate(input: string): string {
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
export function parsePeriod(input: string): [string, string] {
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
  const month = monthBounds(s);
  if (month) return month;
  // Концы диапазона — дата или месяц: «2026-07..2026-09» — с первого июля по последний день сентября.
  const range = s.match(/^(.+?)\.\.(.+)$/);
  if (range) {
    const from = monthBounds(range[1]!)?.[0] ?? parseDate(range[1]!);
    const to = monthBounds(range[2]!)?.[1] ?? parseDate(range[2]!);
    return [from, to];
  }
  const single = parseDate(s);
  return [single, single];
}

/** YYYY-MM → первый и последний день месяца; не месяц — null. */
function monthBounds(input: string): [string, string] | null {
  const ym = input.trim().match(/^(\d{4})-(\d{2})$/);
  if (!ym) return null;
  const year = Number(ym[1]);
  const month = Number(ym[2]);
  if (month < 1 || month > 12) throw new UserError(`Не понимаю месяц "${input.trim()}": номер месяца — от 01 до 12.`);
  return [fmtDate(new Date(year, month - 1, 1)), fmtDate(new Date(year, month, 0))];
}

export function parseHours(input: string): number {
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

type Args = {
  cmd: string;
  positional: string[];
  flags: Map<string, string | true>;
  /** Флаги, которые можно повторять (--tracker A --tracker B): здесь копятся все значения. */
  repeated: Map<string, string[]>;
};

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const short: Record<string, string> = { i: "instance", q: "query", p: "project", d: "date", n: "limit" };
  const set = (name: string, value: string | true): void => {
    flags.set(name, value);
    if (typeof value === "string") repeated.set(name, [...(repeated.get(name) ?? []), value]);
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        set(body, next);
        index++;
      } else {
        set(body, true);
      }
    } else if (/^-[a-z]$/i.test(token)) {
      const name = short[token[1]!] ?? token[1]!;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        set(name, next);
        index++;
      } else {
        set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  const cmd = positional.shift() ?? "help";
  return { cmd, positional, flags, repeated };
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function bool(args: Args, name: string): boolean {
  return args.flags.has(name) && args.flags.get(name) !== "false";
}

/** Значения повторяемого флага: --tracker A --tracker B, либо одним списком через запятую. */
function values(args: Args, name: string): string[] {
  return (args.repeated.get(name) ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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

// ───────────────── предотправочная проверка и подтверждение ───────────────

/**
 * Любой текст, уходящий в Redmine, проходит проверку на компрометацию.
 * Запрет снимается только явным --override-guard, предупреждения печатаются всегда.
 */
function checkOutgoing(fields: Record<string, string | undefined>, args: Args): Finding[] {
  const audience: Audience = str(args, "audience") === "internal" ? "internal" : "client";
  const result = guard(fields, { audience });
  if (result.findings.length === 0) return [];

  if (result.blocked && !bool(args, "override-guard")) {
    throw new UserError(
      `Отправка остановлена: в тексте есть то, что наружу уходить не должно.\n${result.report}\n` +
        `  Исправьте текст. Если находка ложная — повторите с --override-guard.`,
    );
  }
  console.error(
    (result.blocked ? "ПРОВЕРКА ОБОЙДЕНА (--override-guard):\n" : "Предупреждения проверки:\n") + result.report,
  );
  return result.findings;
}

/**
 * Запись в Redmine требует явного --yes. Без него команда печатает предпросмотр и выходит:
 * так инструмент не может отправить ничего, что пользователь не видел.
 */
function requireConfirmation(args: Args, preview: string, hint: string): boolean {
  if (bool(args, "yes") && !bool(args, "dry-run")) return true;
  const tail = bool(args, "dry-run")
    ? "Предпросмотр: ничего не отправлено."
    : `Ничего не отправлено. Показать это пользователю, дождаться согласия и повторить с --yes:\n  ${hint}`;
  emit({ dryRun: true, preview, command: hint }, () => `${preview}\n\n${tail}`);
  return false;
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
export function plain(text: string): string {
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
  const all = await projects(rm);
  const matches = all.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
  );

  if (bool(args, "flat")) {
    emit(matches, () =>
      matches.length === 0
        ? "Проектов не найдено."
        : table([["ID", "IDENTIFIER", "НАЗВАНИЕ"], ...matches.map((p) => [String(p.id), p.identifier, p.name])]),
    );
    return;
  }

  // Подпроект без родителя в выдаче читается как отдельный проект, поэтому предков совпадений оставляем.
  const byId = new Map(all.map((p) => [p.id, p]));
  const keep = new Set<number>();
  for (const p of matches) {
    let cursor: ProjectRef | undefined = p;
    while (cursor && !keep.has(cursor.id)) {
      keep.add(cursor.id);
      cursor = cursor.parent ? byId.get(cursor.parent.id) : undefined;
    }
  }

  const children = new Map<number, ProjectRef[]>();
  const roots: ProjectRef[] = [];
  for (const p of all) {
    if (!keep.has(p.id)) continue;
    const parentId = p.parent && keep.has(p.parent.id) ? p.parent.id : null;
    if (parentId === null) roots.push(p);
    else children.set(parentId, [...(children.get(parentId) ?? []), p]);
  }
  const byName = (a: ProjectRef, b: ProjectRef): number => a.name.localeCompare(b.name, "ru");

  const rows: string[][] = [];
  const walk = (p: ProjectRef, depth: number): void => {
    rows.push([
      String(p.id),
      p.identifier,
      p.is_public === true ? "публ." : "",
      `${"  ".repeat(depth)}${depth > 0 ? "└ " : ""}${p.name}`,
    ]);
    (children.get(p.id) ?? []).sort(byName).forEach((c) => walk(c, depth + 1));
  };
  roots.sort(byName).forEach((p) => walk(p, 0));

  const nested = [...keep].filter((id) => byId.get(id)?.parent !== undefined).length;
  emit(matches, () =>
    rows.length === 0
      ? "Проектов не найдено."
      : `${table([["ID", "IDENTIFIER", "ДОСТУП", "НАЗВАНИЕ"], ...rows])}\n\n` +
        `Всего ${rows.length}${q ? ` (совпадений ${matches.length}, остальные показаны как родители)` : ""}, ` +
        `из них подпроектов ${nested}. Плоским списком — --flat.`,
  );
}

async function cmdProjectFields(rm: Resolved, _args: Args): Promise<void> {
  const info = await projectFields(rm);
  const denied =
    `Справочник полей (custom_fields.json) отдаётся только администратору Redmine — этому ключу отказано.\n` +
    `  Показано то, что видно по карточкам проектов: номер, имя и значения, которые уже используются.\n` +
    `  Тип поля, обязательность и полный список допустимых значений так не узнать — возьмите их\n` +
    `  из формы создания проекта в интерфейсе («Проекты → Новый проект») или спросите администратора.`;

  emit(info, () => {
    if (info.fields.length === 0) {
      return info.adminDenied
        ? `Пользовательских полей у проектов на инстансе ${rm.name} не видно: в карточках проектов их нет,\n` +
          `  а справочник (custom_fields.json) отдаётся только администратору — этому ключу отказано.\n` +
          `  Если поле всё же есть, возьмите его номер и значения из формы создания проекта в интерфейсе\n` +
          `  («Проекты → Новый проект») и задайте номером: --field "12=значение".`
        : `У проектов на инстансе ${rm.name} пользовательских полей нет.`;
    }
    const rows = info.fields.map((f) => [
      String(f.id),
      f.name,
      f.format ?? "неизвестен",
      f.required === undefined ? "?" : f.required ? "да" : "нет",
      f.allowed.length > 0
        ? f.allowed.join(", ")
        : f.seen.length > 0
          ? `встречались: ${f.seen.join(", ")}`
          : "—",
    ]);
    // Для примера берём поле с понятным значением: «Статус=Контроль» читается, «…=0» — нет.
    const example =
      info.fields.find((f) => f.allowed.length > 0) ?? info.fields.find((f) => f.seen.some((v) => /\p{L}/u.test(v))) ?? info.fields[0]!;
    const value = example.allowed[0] ?? example.seen.find((v) => /\p{L}/u.test(v)) ?? example.seen[0] ?? "значение";
    return (
      `ПОЛЬЗОВАТЕЛЬСКИЕ ПОЛЯ ПРОЕКТОВ · инстанс ${rm.name}\n` +
      table([["ID", "ПОЛЕ", "ТИП", "ОБЯЗАТ.", "ЗНАЧЕНИЯ"], ...rows]) +
      `\n\nЗадать при создании или правке: --field "${example.name}=${value}" (флаг повторяется; ` +
      `вместо имени допустим номер: --field "${example.id}=${value}").` +
      (info.adminDenied ? `\n\n${denied}` : "")
    );
  });
}

/** Состав проекта одинаково нужен и предпросмотру создания, и предпросмотру правки. */
function describeAccess(isPublic: boolean): string {
  return isPublic ? "публичный (виден всем, у кого есть учётная запись)" : "закрытый (только участники проекта)";
}

async function cmdCreateProject(rm: Resolved, args: Args): Promise<void> {
  const name = (str(args, "name") ?? args.positional.join(" ")).trim();
  if (!name) throw new UserError('Нужно название проекта: --name "Название".');

  const explicit = str(args, "identifier")?.trim();
  const identifier = explicit ?? slugIdentifier(name);
  const problem = identifierProblem(identifier);
  if (problem) {
    throw new UserError(
      explicit
        ? `Идентификатор "${identifier}" не подходит: ${problem}.`
        : `Из названия «${name}» получился идентификатор "${identifier}", и он не подходит: ${problem}.\n` +
          `  Задайте его сами: --identifier <строка>.`,
    );
  }
  const state = await identifierState(rm, identifier);
  if (state !== "free") {
    throw new UserError(
      state === "taken"
        ? `Идентификатор "${identifier}" уже занят на инстансе ${rm.name}: ${projectUrl(rm, identifier)}.\n` +
          `  Выберите другой: --identifier <строка>.`
        : `Идентификатор "${identifier}" занят проектом, который вам не виден (закрыт или архивирован).\n` +
          `  Выберите другой: --identifier <строка>.`,
    );
  }

  const parentArg = str(args, "parent");
  const parent = parentArg ? await findProject(rm, parentArg) : undefined;

  const descriptionFile = str(args, "description-file");
  const description = descriptionFile ? await Bun.file(descriptionFile).text() : str(args, "description");

  // Закрытый проект — безопасное умолчание: публичность включается только явным --public.
  const isPublic = bool(args, "public") && !bool(args, "private");
  const inheritMembers = bool(args, "inherit-members");

  const trackerNames = values(args, "tracker");
  const pickedTrackers = trackerNames.length > 0 ? resolveManyByName(await trackers(rm), trackerNames, "Трекеры") : [];
  const moduleNames = values(args, "module");
  const pickedModules = moduleNames.length > 0 ? resolveModules(await instanceModules(rm), moduleNames) : [];
  const { list: fields, info: fieldsInfo } = await fieldAssignments(rm, args);

  checkOutgoing({ "название проекта": name, "описание проекта": description }, args);

  const payload: Record<string, unknown> = { name, identifier, is_public: isPublic };
  if (description?.trim()) payload.description = description;
  if (parent) payload.parent_id = parent.id;
  if (parent && inheritMembers) payload.inherit_members = true;
  if (pickedTrackers.length > 0) payload.tracker_ids = pickedTrackers.map((t) => t.id);
  if (pickedModules.length > 0) payload.enabled_module_names = pickedModules;
  if (fields.length > 0) payload.custom_fields = fields.map((f) => ({ id: f.id, value: f.value }));

  // Redmine сам делает создателя-не-администратора участником нового проекта
  // (роль — из настройки инстанса «роль создателя проекта»), в том числе через REST.
  const me = await currentUser(rm);
  const rows: string[][] = [
    ["Название", name],
    ["Идентификатор", identifier + (explicit ? "" : " (сгенерирован из названия)")],
    ["Родитель", parent ? `${parent.name} (${parent.identifier}, id=${parent.id}) — создаётся подпроект` : "нет — проект верхнего уровня"],
    ["Доступ", describeAccess(isPublic)],
    [
      "Участники",
      (parent
        ? inheritMembers
          ? "наследуются от родителя"
          : "свои (наследование не включено; --inherit-members включит)"
        : "добавляются после создания (add-member)") +
        (me.admin === true
          ? ""
          : "; владелец ключа не администратор — Redmine сразу сделает его участником с ролью, " +
            "которую инстанс назначает создателю проекта"),
    ],
    ["Трекеры", pickedTrackers.length > 0 ? pickedTrackers.map((t) => t.name).join(", ") : "набор инстанса по умолчанию"],
    ["Модули", pickedModules.length > 0 ? pickedModules.join(", ") : "набор инстанса по умолчанию"],
    ["Адрес", projectUrl(rm, identifier)],
  ];
  for (const f of fields) {
    rows.push([`Поле «${f.name}»`, (f.value === "" ? "(пусто)" : f.value) + (f.note ? ` — ${f.note}` : "")]);
  }
  const missing = fieldsInfo.fields.filter((f) => f.required === true && !fields.some((a) => a.id === f.id));
  if (missing.length > 0) {
    rows.push([
      "Не заполнено",
      `обязательные поля инстанса: ${missing.map((f) => `«${f.name}»`).join(", ")} — задайте --field "Имя=значение"`,
    ]);
  }
  if (!parent && inheritMembers) rows.push(["Внимание", "--inherit-members без --parent ничего не делает"]);

  const preview =
    `НОВЫЙ ПРОЕКТ · инстанс ${rm.name}\n${table(rows)}` +
    (description?.trim()
      ? `\n\nОПИСАНИЕ (как уйдёт в Redmine):\n${"─".repeat(60)}\n${description.trim()}\n${"─".repeat(60)}`
      : "\n\nОписание не задано (--description-file <файл>).") +
    `\n\nСоздание проекта требует прав администратора либо роли с разрешением ` +
    (parent ? `«Создание подпроектов» в проекте «${parent.name}».` : "«Создание проекта».");
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  const created = await withProjectRights(
    "create",
    `Проект «${name}» не создан.`,
    async () =>
      (await request<{ project: ProjectRef }>(rm, "POST", "projects.json", undefined, { project: payload })).project,
    { fields: fieldsInfo },
  );
  await cacheDrop(rm, "projects");
  emit(created, () =>
    `Создан проект «${created.name}» (${created.identifier}, id=${created.id})\n${projectUrl(rm, created.identifier)}\n` +
      `Родитель: ${parent ? parent.name : "нет"} | Доступ: ${describeAccess(created.is_public ?? isPublic)}` +
      (pickedTrackers.length > 0 ? ` | Трекеры: ${pickedTrackers.map((t) => t.name).join(", ")}` : "") +
      (pickedModules.length > 0 ? ` | Модули: ${pickedModules.join(", ")}` : "") +
      (fields.length > 0 ? ` | Поля: ${fields.map((f) => `${f.name}=${f.value}`).join(", ")}` : ""),
  );
}

async function cmdUpdateProject(rm: Resolved, args: Args): Promise<void> {
  const target = args.positional[0] ?? str(args, "project");
  if (!target) throw new UserError('Укажите проект: redmine.ts update-project <identifier|id> --name "…"');
  const project = await findProject(rm, target);

  const patch: Record<string, unknown> = {};
  const rows: string[][] = [];
  const name = str(args, "name");
  if (name) {
    patch.name = name;
    rows.push(["Название", `${project.name} → ${name}`]);
  }
  const descriptionFile = str(args, "description-file");
  const description = descriptionFile ? await Bun.file(descriptionFile).text() : str(args, "description");
  if (description !== undefined) patch.description = description;

  const parentArg = str(args, "parent");
  let parent: ProjectRef | undefined;
  if (parentArg !== undefined) {
    if (/^(none|нет|—|-)$/i.test(parentArg.trim())) {
      patch.parent_id = "";
      rows.push(["Родитель", `${project.parent?.name ?? "нет"} → нет (проект верхнего уровня)`]);
    } else {
      parent = await findProject(rm, parentArg);
      if (parent.id === project.id) throw new UserError("Проект не может быть родителем самому себе.");
      patch.parent_id = parent.id;
      rows.push(["Родитель", `${project.parent?.name ?? "нет"} → ${parent.name} (${parent.identifier})`]);
    }
  }
  if (bool(args, "public") || bool(args, "private")) {
    const isPublic = bool(args, "public") && !bool(args, "private");
    patch.is_public = isPublic;
    rows.push(["Доступ", `${describeAccess(project.is_public === true)} → ${describeAccess(isPublic)}`]);
  }
  const trackerNames = values(args, "tracker");
  if (trackerNames.length > 0) {
    const picked = resolveManyByName(await trackers(rm), trackerNames, "Трекеры");
    patch.tracker_ids = picked.map((t) => t.id);
    rows.push([
      "Трекеры",
      `${(project.trackers ?? []).map((t) => t.name).join(", ") || "—"} → ${picked.map((t) => t.name).join(", ")}`,
    ]);
  }
  const moduleNames = values(args, "module");
  if (moduleNames.length > 0) {
    const picked = resolveModules(await instanceModules(rm), moduleNames);
    patch.enabled_module_names = picked;
    rows.push([
      "Модули",
      `${(project.enabled_modules ?? []).map((m) => m.name).join(", ") || "—"} → ${picked.join(", ")}`,
    ]);
  }
  const { list: fields, info: fieldsInfo } = await fieldAssignments(rm, args);
  if (fields.length > 0) {
    patch.custom_fields = fields.map((f) => ({ id: f.id, value: f.value }));
    const current = new Map((project.custom_fields ?? []).map((f) => [f.id, customFieldValues(f.value).join(", ")]));
    for (const f of fields) {
      rows.push([
        `Поле «${f.name}»`,
        `${current.get(f.id) || "—"} → ${f.value === "" ? "(пусто)" : f.value}` + (f.note ? ` — ${f.note}` : ""),
      ]);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new UserError(
      "Нечего менять: задайте --name / --description(-file) / --parent / --public|--private / --tracker / --module / --field.",
    );
  }

  checkOutgoing({ "название проекта": name, "описание проекта": description }, args);

  const preview =
    `ПРАВКА ПРОЕКТА «${project.name}» (${project.identifier}) · инстанс ${rm.name}\n` +
    `${projectUrl(rm, project.identifier)}\n` +
    (rows.length > 0 ? table(rows) : "(меняется только описание)") +
    (description !== undefined
      ? `\n\nНОВОЕ ОПИСАНИЕ (заменит текущее целиком):\n${"─".repeat(60)}\n${description.trim() || "(пусто — описание будет стёрто)"}\n${"─".repeat(60)}` +
        (project.description?.trim()
          ? `\n\nТЕКУЩЕЕ ОПИСАНИЕ:\n${"─".repeat(60)}\n${project.description.trim()}\n${"─".repeat(60)}`
          : "")
      : "");
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  await withProjectRights(
    "update",
    `Проект «${project.name}» не изменён.`,
    () => request(rm, "PUT", `projects/${project.id}.json`, undefined, { project: patch }),
    { projectExists: true, fields: fieldsInfo },
  );
  await cacheDrop(rm, "projects");
  const after = (await request<{ project: ProjectRef }>(rm, "GET", `projects/${project.id}.json`)).project;
  emit(after, () =>
    `Проект «${after.name}» (${after.identifier}) обновлён.\n${projectUrl(rm, after.identifier)}\n` +
      `Родитель: ${after.parent?.name ?? "нет"} | Доступ: ${describeAccess(after.is_public === true)}`,
  );
}

async function cmdArchiveProject(rm: Resolved, args: Args): Promise<void> {
  const unarchive = args.cmd === "unarchive-project";
  const target = args.positional[0] ?? str(args, "project");
  if (!target) {
    throw new UserError(`Укажите проект: redmine.ts ${args.cmd} <identifier|id> --yes`);
  }

  const me = await currentUser(rm);
  // Архивированный проект не виден в списке, поэтому при разархивации имя может не найтись — это нормально.
  let project: ProjectRef | null = null;
  try {
    project = await findProject(rm, target);
  } catch (error) {
    if (!unarchive) throw error;
  }
  const key = project ? String(project.id) : target.replace(/^#/, "");
  const title = project ? `«${project.name}» (${project.identifier})` : `"${target}"`;

  const found = project;
  const nested = found === null ? [] : (await projects(rm)).filter((p) => p.parent?.id === found.id);

  const rows: string[][] = [
    ["Проект", title],
    ["Инстанс", rm.name],
    ["Операция", unarchive ? "разархивировать — проект снова станет рабочим" : "архивировать"],
  ];
  if (!unarchive && nested.length > 0) {
    rows.push(["Подпроекты", `${nested.length} — архивируются вместе с родителем: ${nested.map((p) => p.name).join(", ")}`]);
  }
  rows.push([
    "Права",
    me.admin === true
      ? "владелец ключа — администратор Redmine"
      : "владелец ключа НЕ администратор: Redmine откажет (403), это нормально и не ошибка скилла",
  ]);

  const consequence = unarchive
    ? "После разархивации проект снова доступен: задачи видны в поиске и отчётах, время списывается."
    : "Архив закрывает проект целиком: задачи исчезают из поиска и отчётов, время списать нельзя, правки запрещены. " +
      "Данные не удаляются — проект можно вернуть командой unarchive-project.";

  const preview =
    `${unarchive ? "РАЗАРХИВАЦИЯ" : "АРХИВИРОВАНИЕ"} ПРОЕКТА · инстанс ${rm.name}\n${table(rows)}\n\n${consequence}\n` +
    `Операция доступна только администратору Redmine; через интерфейс — «Администрирование → Проекты».`;
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  await withProjectRights(
    "archive",
    `Проект ${title} не тронут.`,
    () => request(rm, "PUT", `projects/${key}/${unarchive ? "unarchive" : "archive"}.json`),
    { projectExists: found !== null },
  );
  await cacheDrop(rm, "projects");
  emit({ project: key, archived: !unarchive }, () =>
    `Проект ${title} ${unarchive ? "разархивирован" : "архивирован"} на инстансе ${rm.name}.`,
  );
}

// ─────────────────────────── участники проекта ─────────────────────────

/** Проект так, как его называют в предпросмотре: название, идентификатор и номер разом. */
export function projectTitle(p: { id: number; name: string; identifier: string }): string {
  return `«${p.name}» (${p.identifier}, id=${p.id})`;
}

/** Всё о проекте, что нужно предпросмотру участника. `isPublic: null` — проект не виден в списке. */
export type MemberProject = { id: number; name: string; identifier: string; url: string; isPublic: boolean | null };

/**
 * Кого добавляют или меняют: пользователь или группа. Номер принимается как есть, даже если имя
 * узнать не удалось, — но предпросмотр говорит об этом прямо, а не печатает голый номер.
 */
export type Principal = {
  id: number;
  name: string | null;
  kind: "user" | "group" | "unknown";
  /** Видимые проекты, где он уже состоит: по ним различают однофамильцев. */
  projects: string[];
  /** Это владелец ключа: удалить себя или снять с себя управление — значит потерять доступ. */
  self: boolean;
  /** Почему имя неизвестно — для предпросмотра. */
  note?: string;
};

/**
 * Кандидат при поиске по имени. `seen` — когда учётная запись заведена и когда в неё входили:
 * у однофамильцев часто один и тот же набор проектов, и живую запись отличает только это.
 */
export type PersonCandidate = { id: number; name: string; kind: "user" | "group"; projects: string[]; seen?: string };

export type MemberAction = "list" | "add" | "update" | "remove";

const RULE = "─".repeat(60);

// ── роли словами ──

const ISSUE_VISIBILITY: Record<string, string> = {
  all: "видит все",
  default: "видит все, кроме приватных",
  own: "видит только созданные им или назначенные на него",
};

const TIME_VISIBILITY: Record<string, string> = {
  all: "видит все списания",
  own: "видит только свои списания",
};

/** Права управления проектом: их называем отдельно — они дают власть над другими людьми и настройками. */
const PROJECT_POWERS: [string, string][] = [
  ["manage_members", "управляет участниками"],
  ["edit_project", "меняет настройки проекта"],
  ["add_subprojects", "создаёт подпроекты"],
  ["manage_versions", "ведёт версии"],
];

const MODULE_ACCESS: [string, string][] = [
  ["view_wiki_pages", "вики"],
  ["view_documents", "документы"],
  ["view_files", "файлы"],
  ["browse_repository", "репозиторий"],
];

/**
 * Что роль даёт — в общих чертах и словами. Полный список прав Redmine длинный и технический;
 * человеку, который соглашается на добавление участника, нужна суть: что он увидит, что сможет
 * менять и получит ли власть над проектом.
 */
export function describeRole(role: RoleInfo): string {
  const perms = role.permissions;
  if (perms === null) return "права роли не прочитаны — они видны в «Администрирование → Роли и права»";
  const has = (permission: string): boolean => perms.includes(permission);
  const parts: string[] = [];

  if (has("view_issues")) {
    const actions = [
      has("add_issues") ? "создаёт" : "",
      has("edit_issues") ? "редактирует" : has("edit_own_issues") ? "редактирует свои" : "",
      has("add_issue_notes") ? "комментирует" : "",
      has("delete_issues") ? "удаляет" : "",
    ].filter(Boolean);
    parts.push(
      `задачи: ${ISSUE_VISIBILITY[role.issues_visibility ?? ""] ?? "видит"}` +
        (actions.length > 0 ? `; ${actions.join(", ")}` : "; только читает"),
    );
  } else {
    parts.push("задач не видит");
  }

  const time = [
    has("view_time_entries") ? (TIME_VISIBILITY[role.time_entries_visibility ?? ""] ?? "видит списания") : "",
    has("log_time") ? "списывает своё время" : "",
    has("edit_time_entries") ? "правит чужие списания" : "",
    has("log_time_for_other_users") ? "списывает за других" : "",
  ].filter(Boolean);
  parts.push(time.length > 0 ? `трудозатраты: ${time.join(", ")}` : "трудозатрат не видит");

  const powers = PROJECT_POWERS.filter(([p]) => has(p)).map(([, words]) => words);
  if (powers.length > 0) parts.push(powers.join(", "));
  const modules = MODULE_ACCESS.filter(([p]) => has(p)).map(([, words]) => words);
  if (modules.length > 0) parts.push(`также: ${modules.join(", ")}`);
  if (role.assignable === true) parts.push("может быть исполнителем задач");
  if (role.assignable === false) parts.push("исполнителем задач быть не может");
  return parts.join(" · ");
}

/** Роли по имени или номеру; неизвестная останавливает команду и перечисляет доступные. */
export function resolveRoles(all: RoleInfo[], wanted: string[]): RoleInfo[] {
  if (wanted.length === 0) {
    throw new UserError(`Укажите хотя бы одну роль: --role <имя|id>. Доступно: ${all.map((r) => r.name).join(", ")}.`);
  }
  try {
    return resolveManyByName(all, wanted, "Роли");
  } catch (error) {
    if (error instanceof UserError) {
      throw new UserError(`${error.message}\n  Что даёт каждая роль — redmine.ts roles.`);
    }
    throw error;
  }
}

// ── поиск человека по имени ──

/** Слова имени для сравнения: регистр, «ё», знаки препинания и порядок слов не важны. */
function nameWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[\s.,]+/)
    .filter((w) => w.length > 0);
}

export type PersonMatch =
  | { kind: "one"; person: PersonCandidate }
  | { kind: "many"; candidates: PersonCandidate[] }
  | { kind: "none"; similar: PersonCandidate[] };

/**
 * Сопоставление имени без учёта порядка слов: инстанс показывает людей то «Имя Фамилия»,
 * то «Фамилия Имя» — как настроено, а человек пишет так, как помнит.
 * Полное совпадение важнее частичного: «Иван Петров» не должен становиться неоднозначным
 * из-за «Ивана Петровича Сидорова».
 */
export function matchPeople(candidates: PersonCandidate[], needle: string): PersonMatch {
  const want = nameWords(needle);
  if (want.length === 0) return { kind: "none", similar: [] };
  const verdict = (list: PersonCandidate[]): PersonMatch | null =>
    list.length === 1 ? { kind: "one", person: list[0]! } : list.length > 1 ? { kind: "many", candidates: list } : null;

  const full = candidates.filter((c) => {
    const own = nameWords(c.name);
    return own.length === want.length && want.every((w) => own.includes(w));
  });
  const byFull = verdict(full);
  if (byFull) return byFull;

  const partial = candidates.filter((c) => {
    const own = nameWords(c.name);
    return want.every((w) => own.some((o) => o.startsWith(w)));
  });
  const byPartial = verdict(partial);
  if (byPartial) return byPartial;

  // Похожие — только подсказка для ошибки, выбирать из них скилл не вправе.
  const similar = candidates.filter((c) => {
    const own = nameWords(c.name);
    return want.some((w) => w.length >= 3 && own.some((o) => o.startsWith(w.slice(0, 3))));
  });
  return { kind: "none", similar: similar.slice(0, 10) };
}

function shortList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} и ещё ${items.length - max}`;
}

function candidateLine(p: PersonCandidate): string {
  const where = p.projects.length > 0 ? `проекты: ${shortList(p.projects, 4)}` : "в видимых проектах не встречается";
  return `    ${p.name} (id=${p.id}) — ${p.kind === "group" ? "группа" : "пользователь"}; ${where}${p.seen ? `; ${p.seen}` : ""}`;
}

/**
 * Выбор одного человека — или остановка до отправки со списком кандидатов.
 * `serverHits` — ответ справочника пользователей: он ищет ещё по логину и почте,
 * и такие совпадения по имени не видны.
 */
export function pickPerson(
  pool: PersonCandidate[],
  needle: string,
  ctx: { projects: number; directory: "admin" | "closed"; serverHits: PersonCandidate[] },
): PersonCandidate {
  let match = matchPeople(pool, needle);
  if (match.kind === "none" && ctx.serverHits.length > 0) {
    match =
      ctx.serverHits.length === 1
        ? { kind: "one", person: ctx.serverHits[0]! }
        : { kind: "many", candidates: ctx.serverHits };
  }
  if (match.kind === "one") return match.person;
  if (match.kind === "many") {
    throw new UserError(
      `"${needle}" подходит нескольким — уточните имя или укажите номер: --user <id>.\n` +
        `  Кандидаты:\n${match.candidates.map(candidateLine).join("\n")}`,
    );
  }
  const where =
    `среди участников ${ctx.projects} видимых проектов` + (ctx.directory === "admin" ? " и в справочнике пользователей" : "");
  throw new UserError(
    `"${needle}" не найден ${where}.\n` +
      (match.similar.length > 0
        ? `  Похожие:\n${match.similar.map(candidateLine).join("\n")}\n`
        : "  Похожих имён нет.\n") +
      (ctx.directory === "admin"
        ? "  Проверьте написание или укажите номер: --user <id>."
        : "  Человека, который ещё ни в одном видимом вам проекте не состоит, по имени не найти: справочник\n" +
          "  пользователей (/users.json) отдаётся только администратору Redmine. Укажите номер: --user <id> —\n" +
          "  он виден в адресе профиля (…/users/<id>), либо его назовёт администратор."),
  );
}

/**
 * Справочник людей из участников всех видимых проектов — только в памяти, на один запуск.
 * На диск не пишется: это персональные данные, а состав участников меняется этими же
 * командами — вчерашний кэш назвал бы не того человека.
 */
const peopleMemo = new Map<string, { people: PersonCandidate[]; projects: number }>();

async function peopleIndex(rm: Resolved): Promise<{ people: PersonCandidate[]; projects: number }> {
  const hit = peopleMemo.get(rm.name);
  if (hit) return hit;
  const list = await projects(rm);
  const loaded = await mapLimit(list, 6, async (project) => {
    try {
      return { project, memberships: await loadMemberships(rm, project.id) };
    } catch (error) {
      // Участники части проектов бывают закрыты от ключа — поиск по остальным от этого не ломается.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return { project, memberships: [] as Membership[] };
      }
      throw error;
    }
  });
  const byId = new Map<number, PersonCandidate>();
  for (const { project, memberships } of loaded) {
    for (const m of memberships) {
      const principal = m.user ?? m.group;
      if (!principal) continue;
      const kind: PersonCandidate["kind"] = m.user ? "user" : "group";
      const slot = byId.get(principal.id) ?? { id: principal.id, name: principal.name, kind, projects: [] };
      if (!slot.projects.includes(project.name)) slot.projects.push(project.name);
      byId.set(principal.id, slot);
    }
  }
  const result = { people: [...byId.values()], projects: list.length };
  peopleMemo.set(rm.name, result);
  return result;
}

type DirectoryUser = {
  id: number;
  firstname?: string;
  lastname?: string;
  login?: string;
  created_on?: string;
  last_login_on?: string | null;
};

function directoryName(u: DirectoryUser): string {
  return [u.firstname, u.lastname].filter(Boolean).join(" ") || u.login || `#${u.id}`;
}

/** Даты учётной записи для различения однофамильцев. Почту не берём: это лишние персональные данные. */
export function accountSeen(u: { created_on?: string; last_login_on?: string | null }): string | undefined {
  // null — Redmine прямо говорит «не входил»; отсутствие поля — только то, что дату нам не показали.
  const parts = [
    u.created_on ? `заведён ${u.created_on.slice(0, 10)}` : "",
    typeof u.last_login_on === "string"
      ? `последний вход ${u.last_login_on.slice(0, 10)}`
      : u.last_login_on === null
        ? "не входил ни разу"
        : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Однофамильцев дополняем датами из карточек: по одинаковым спискам проектов их не различить. */
async function annotateNamesakes(rm: Resolved, candidates: PersonCandidate[]): Promise<void> {
  const users = candidates.filter((c) => c.kind === "user" && c.seen === undefined).slice(0, 10);
  await mapLimit(users, 4, async (c) => {
    try {
      const r = await request<{ user?: DirectoryUser }>(rm, "GET", `users/${c.id}.json`);
      if (r.user) c.seen = accountSeen(r.user);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  });
}

/** Справочник пользователей — только у администратора; null значит «закрыт», а не «пусто». */
async function searchUserDirectory(rm: Resolved, name: string): Promise<PersonCandidate[] | null> {
  try {
    const r = await request<{ users?: DirectoryUser[] }>(rm, "GET", "users.json", { name, limit: 25 });
    return (r.users ?? []).map((u) => ({ id: u.id, name: directoryName(u), kind: "user" as const, projects: [] }));
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

/** Имя по номеру: карточка пользователя видна не только администратору, если человек ему «виден». */
async function directoryUserName(rm: Resolved, id: number): Promise<string | null> {
  try {
    const r = await request<{ user?: DirectoryUser }>(rm, "GET", `users/${id}.json`);
    return r.user ? directoryName(r.user) : null;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

async function resolvePrincipal(rm: Resolved, raw: string): Promise<Principal> {
  const value = raw.trim();
  const me = await currentUser(rm);
  if (/^(me|я)$/i.test(value)) {
    return { id: me.id, name: `${me.firstname} ${me.lastname}`.trim(), kind: "user", projects: [], self: true };
  }

  if (/^#?\d+$/.test(value)) {
    const id = Number(value.replace("#", ""));
    const self = id === me.id;
    const direct = await directoryUserName(rm, id);
    if (direct) return { id, name: direct, kind: "user", projects: [], self };
    const index = await peopleIndex(rm);
    const known = index.people.find((p) => p.id === id);
    if (known) return { ...known, self };
    return {
      id,
      name: null,
      kind: "unknown",
      projects: [],
      self,
      note:
        `имя узнать не удалось: в ${index.projects} видимых проектах такого участника нет, а карточка ` +
        `пользователя закрыта от ключа. Номер уйдёт как есть — сверьте его с профилем (…/users/${id})`,
    };
  }

  const index = await peopleIndex(rm);
  const directory = await searchUserDirectory(rm, value);
  const pool = new Map(index.people.map((p) => [p.id, p]));
  for (const u of directory ?? []) if (!pool.has(u.id)) pool.set(u.id, u);
  const hits = (directory ?? []).map((u) => pool.get(u.id) ?? u);
  const probe = matchPeople([...pool.values()], value);
  if (probe.kind === "many") await annotateNamesakes(rm, probe.candidates);
  const person = pickPerson([...pool.values()], value, {
    projects: index.projects,
    directory: directory === null ? "closed" : "admin",
    serverHits: hits,
  });
  return { ...person, self: person.id === me.id };
}

// ── членства ──

/** Членство, в котором состоит пользователь или группа: у одного участника в проекте оно одно. */
export function findMembership(list: Membership[], principalId: number): Membership | undefined {
  return list.find((m) => (m.user?.id ?? m.group?.id) === principalId);
}

/** Собственные роли: их задают и снимают здесь. */
export function ownRoles(m: Membership): MemberRole[] {
  return m.roles.filter((r) => r.inherited !== true);
}

/** Унаследованные роли — от группы или родительского проекта; меняются там, откуда пришли. */
export function inheritedRoles(m: Membership): MemberRole[] {
  return m.roles.filter((r) => r.inherited === true);
}

/**
 * Роли участника одной строкой: сначала собственные, затем унаследованные. Унаследованная роль
 * приходит от каждой группы отдельно, и без схлопывания «Исполнитель» повторялся бы по разу на группу.
 */
export function describeMemberRoles(roles: MemberRole[]): string {
  const unique = (list: MemberRole[]): string[] => [...new Set(list.map((r) => r.name))];
  const own = unique(roles.filter((r) => r.inherited !== true));
  const inherited = unique(roles.filter((r) => r.inherited === true));
  if (own.length === 0 && inherited.length === 0) return "—";
  return [own.join(", "), inherited.length > 0 ? `унасл.: ${inherited.join(", ")}` : ""].filter(Boolean).join(" + ");
}

function principalOf(m: Membership, meId: number): Principal {
  if (m.user) return { id: m.user.id, name: m.user.name, kind: "user", projects: [], self: m.user.id === meId };
  if (m.group) return { id: m.group.id, name: m.group.name, kind: "group", projects: [], self: false };
  throw new UserError(`Членство ${m.id} не называет ни пользователя, ни группу — такой ответ Redmine разобрать нельзя.`);
}

/** Как называть участника в тексте: имя и номер, либо честное «имя неизвестно». */
export function principalName(p: Principal): string {
  if (p.kind === "group") return `группа «${p.name ?? `#${p.id}`}» (id=${p.id})`;
  return p.name ? `${p.name} (id=${p.id})` : `пользователь id=${p.id}`;
}

function principalRow(p: Principal): string[] {
  const title = p.kind === "group" ? "Группа" : "Пользователь";
  const extra = [
    p.self ? "это вы — владелец ключа" : "",
    p.projects.length > 0 ? `уже состоит в: ${shortList(p.projects, 4)}` : "",
    p.note ?? "",
  ].filter(Boolean);
  return [title, `${p.kind === "group" ? `«${p.name ?? `#${p.id}`}» (id=${p.id})` : principalName(p)}${extra.length > 0 ? ` — ${extra.join("; ")}` : ""}`];
}

function projectRows(project: MemberProject): string[][] {
  const access =
    project.isPublic === null ? "" : project.isPublic ? " — публичный" : " — закрытый, виден только участникам";
  return [
    ["Проект", `${projectTitle(project)}${access}`],
    ["Адрес", project.url],
  ];
}

function roleLines(list: RoleInfo[]): string {
  return list.map((r) => `  ${r.name} (id=${r.id}): ${describeRole(r)}`).join("\n");
}

/** Главное предупреждение: членство — это видимость и почта, а не пометка в списке. */
export const CLIENT_NOTICE =
  "Участник клиентского проекта видит задачи проекта в объёме своей роли и получает уведомления по ним\n" +
  "(сколько писем — зависит от его настроек почты в Redmine). Проверьте, что роль открывает ровно то,\n" +
  "что этому человеку положено видеть.";

const MANAGE_NOTE = "Операция требует у владельца ключа права «Управление участниками» в этом проекте.";

const GROUP_NOTE =
  "Это группа: роли получат все её участники — и нынешние, и те, кого добавят в группу позже.";

export const SEPARATE_CONFIRMATION =
  "Удаление участника — отдельное подтверждение. Согласие на другие операции его не покрывает:\n" +
  "нужно явное «да» именно на это удаление, и только после него — повтор с --yes.";

export function addMemberPreview(ctx: {
  instance: string;
  project: MemberProject;
  principal: Principal;
  roles: RoleInfo[];
  memberCount: number;
}): string {
  const rows = [
    ...projectRows(ctx.project),
    principalRow(ctx.principal),
    ["Роли", ctx.roles.map((r) => r.name).join(", ")],
    ["Участников", `сейчас ${ctx.memberCount}, станет ${ctx.memberCount + 1}`],
  ];
  const notes = [
    ctx.principal.kind === "group" ? GROUP_NOTE : "",
    ctx.project.isPublic === true
      ? "Проект публичный: задачи и так видны всем с учётной записью, членство добавляет права роли и уведомления."
      : "",
    CLIENT_NOTICE,
    MANAGE_NOTE,
  ].filter(Boolean);
  return (
    `НОВЫЙ УЧАСТНИК ПРОЕКТА · инстанс ${ctx.instance}\n${table(rows)}\n${RULE}\n` +
    `Что дают роли:\n${roleLines(ctx.roles)}\n${RULE}\n${notes.join("\n")}`
  );
}

export function updateMemberPreview(ctx: {
  instance: string;
  project: MemberProject;
  principal: Principal;
  membership: Membership;
  roles: RoleInfo[];
  /** Владелец ключа снимает с себя последнюю роль с правом управлять участниками. */
  selfLosesManage: boolean;
}): string {
  const own = ownRoles(ctx.membership);
  const inherited = inheritedRoles(ctx.membership);
  const wanted = new Set(ctx.roles.map((r) => r.id));
  const had = new Set(own.map((r) => r.id));
  const added = ctx.roles.filter((r) => !had.has(r.id));
  const removed = own.filter((r) => !wanted.has(r.id));

  const rows = [
    ...projectRows(ctx.project),
    principalRow(ctx.principal),
    ["Роли сейчас", describeMemberRoles(ctx.membership.roles)],
    [
      "Станут",
      ctx.roles.map((r) => r.name).join(", ") +
        (inherited.length > 0 ? ` + унаследованные: ${inherited.map((r) => r.name).join(", ")}` : ""),
    ],
    ["Добавляются", added.length > 0 ? added.map((r) => r.name).join(", ") : "—"],
    ["Снимаются", removed.length > 0 ? removed.map((r) => r.name).join(", ") : "—"],
  ];
  const notes = [
    inherited.length > 0
      ? `Унаследованные роли (${inherited.map((r) => r.name).join(", ")}) пришли от группы или родительского ` +
        "проекта — этой командой они не снимаются."
      : "",
    ctx.principal.kind === "group" ? "Это членство группы: изменение коснётся всех её участников в проекте." : "",
    removed.length > 0
      ? "Снятая роль перестаёт действовать сразу: пропадают её права, а с ними — доступ к задачам и уведомления, которые она давала."
      : "",
    ctx.selfLosesManage
      ? "ВНИМАНИЕ: вы снимаете с себя последнюю роль с правом «Управление участниками» — вернуть её себе сами не сможете."
      : "",
    added.length > 0 ? CLIENT_NOTICE : "",
    MANAGE_NOTE,
  ].filter(Boolean);
  return (
    `ИЗМЕНЕНИЕ РОЛЕЙ УЧАСТНИКА · инстанс ${ctx.instance} · членство ${ctx.membership.id}\n${table(rows)}\n${RULE}\n` +
    `Что дают роли после изменения:\n${roleLines(ctx.roles)}\n${RULE}\n${notes.join("\n")}`
  );
}

export function removeMemberPreview(ctx: {
  instance: string;
  project: MemberProject;
  principal: Principal;
  membership: Membership;
  /** Открытые задачи участника в проекте; null — посчитать не удалось или это группа. */
  openIssues: number | null;
}): string {
  const rows = [...projectRows(ctx.project), principalRow(ctx.principal), ["Роли", describeMemberRoles(ctx.membership.roles)]];
  if (ctx.openIssues !== null) {
    rows.push([
      "Открытые задачи на нём",
      ctx.openIssues > 0
        ? `${ctx.openIssues} — останутся назначенными на человека вне проекта: переназначьте их`
        : "нет",
    ]);
  }
  const notes = [
    "После удаления права ролей в проекте пропадают сразу, а с ними — уведомления, которые давало членство;\n" +
      "задачи закрытого проекта станут ему не видны. Списанные часы, комментарии и авторство задач остаются.",
    ctx.principal.kind === "group"
      ? "Это членство группы: её участники, которые состоят в проекте только через группу, потеряют доступ вместе с ней."
      : "",
    ctx.principal.self
      ? "ВНИМАНИЕ: это ваше собственное членство. После удаления владелец ключа потеряет роль в проекте и вернуть\n" +
        "себя сам не сможет — только администратор или менеджер проекта."
      : "",
    MANAGE_NOTE,
  ].filter(Boolean);
  return (
    `УДАЛЕНИЕ УЧАСТНИКА ИЗ ПРОЕКТА · инстанс ${ctx.instance} · членство ${ctx.membership.id}\n${table(rows)}\n` +
    `${RULE}\n${notes.join("\n")}\n${RULE}\n${SEPARATE_CONFIRMATION}`
  );
}

// ── запросы ──

export type MembershipRequest = {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: { membership: { user_id?: number; role_ids: number[] } };
};

function roleIdList(ids: number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new UserError("Нужна хотя бы одна роль: без роли Redmine членство не принимает.");
  const bad = unique.filter((id) => !Number.isInteger(id) || id <= 0);
  if (bad.length > 0) throw new UserError(`Номер роли должен быть положительным целым, получено: ${bad.join(", ")}.`);
  return unique;
}

function positiveId(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new UserError(`${what} должен быть положительным целым, получено ${value}.`);
  return value;
}

/** `user_id` принимает и пользователя, и группу — у Redmine это один «участник». */
export function addMemberRequest(projectId: number, principalId: number, roleIds: number[]): MembershipRequest {
  return {
    method: "POST",
    path: `projects/${positiveId(projectId, "Номер проекта")}/memberships.json`,
    body: { membership: { user_id: positiveId(principalId, "Номер пользователя"), role_ids: roleIdList(roleIds) } },
  };
}

/** PUT заменяет собственные роли целиком; унаследованные Redmine оставляет сам. */
export function updateMemberRequest(membershipId: number, roleIds: number[]): MembershipRequest {
  return {
    method: "PUT",
    path: `memberships/${positiveId(membershipId, "Номер членства")}.json`,
    body: { membership: { role_ids: roleIdList(roleIds) } },
  };
}

export function removeMemberRequest(membershipId: number): MembershipRequest {
  return { method: "DELETE", path: `memberships/${positiveId(membershipId, "Номер членства")}.json` };
}

async function sendMembership(rm: Resolved, req: MembershipRequest): Promise<void> {
  await request(rm, req.method, req.path, undefined, req.body);
}

// ── отказы и сверка ──

/** 403 — про права владельца ключа, а не про запрос: называем разрешение и того, кто его выдаёт. */
export function explainMemberForbidden(action: MemberAction, project: string): string {
  if (action === "list") {
    return (
      `Список участников проекта ${project} закрыт от владельца ключа: нужна роль с правом «Просмотр участников»\n` +
      "  или «Управление участниками». Роль в проекте назначает администратор Redmine или менеджер проекта."
    );
  }
  const head =
    action === "add" ? "Участник не добавлен" : action === "update" ? "Роли не изменены" : "Участник не удалён";
  return (
    `${head}: у владельца ключа нет права «Управление участниками» в проекте ${project}.\n` +
    "  Право входит в роль проекта. Какие роли его дают — «Администрирование → Роли и права»; назначает\n" +
    "  такую роль администратор Redmine или менеджер этого проекта, у которого право уже есть.\n" +
    "  Что делать: попросить их выдать право либо внести изменение самим. Обходного пути нет."
  );
}

/**
 * Отказ 422 по членству — почти всегда одна из немногих понятных ситуаций. Пользователю нужна
 * причина словами, а не код ответа. DELETE при унаследованной роли Redmine отклоняет без текста.
 */
export function explainMembershipRejection(
  details: string[],
  ctx: { action: "add" | "update" | "remove"; project: string; who: string },
): string {
  const flat = details.join("; ").toLowerCase();
  const head =
    ctx.action === "add"
      ? `Redmine не добавил ${ctx.who} в проект ${ctx.project}.`
      : ctx.action === "update"
        ? `Redmine не изменил роли ${ctx.who} в проекте ${ctx.project}.`
        : `Redmine не удалил ${ctx.who} из проекта ${ctx.project}.`;

  if (/taken|already|уже существует|уже использ|уже есть/.test(flat)) {
    return (
      `${head}\n  Он уже участник проекта: Redmine держит одно членство на человека в проекте.\n` +
      "  Роли меняются командой update-member — номер членства видно в redmine.ts members <проект>."
    );
  }
  if (/role|рол/.test(flat) && /blank|empty|пуст|не может/.test(flat)) {
    return (
      `${head}\n  Ни одна из ролей не легла. Обычно так бывает, когда владельцу ключа разрешено назначать не все роли:\n` +
      "  у права «Управление участниками» есть ограничение «только эти роли», и остальные Redmine отбрасывает молча.\n" +
      "  Назначить такую роль может администратор или менеджер проекта без этого ограничения."
    );
  }
  if (/user|principal|пользовател|имя/.test(flat) && /blank|empty|invalid|пуст|неверн|не найден/.test(flat)) {
    return (
      `${head}\n  Пользователя с таким номером на инстансе нет или он заблокирован.\n` +
      "  Проверьте номер по профилю (…/users/<id>) или найдите человека по имени: --user \"Имя Фамилия\"."
    );
  }
  if (ctx.action === "remove" && details.length === 0) {
    return (
      `${head}\n  Это членство нельзя удалить: у него есть роли, унаследованные от группы или родительского проекта.\n` +
      "  Удалять нужно там, откуда роль пришла, — членство группы или наследование участников в настройках проекта.\n" +
      "  Собственные роли можно сократить командой update-member."
    );
  }
  return (
    `${head}\n  Redmine ответил: ${details.join("; ") || "без пояснения"}.\n` +
    "  Проверьте состав и роли: redmine.ts members <проект>, redmine.ts roles."
  );
}

async function withMemberErrors<T>(
  ctx: { action: MemberAction; project: string; who: string },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 403) throw new UserError(explainMemberForbidden(ctx.action, ctx.project));
    if (error.status === 422 && ctx.action !== "list") {
      throw new UserError(explainMembershipRejection(error.details, { action: ctx.action, project: ctx.project, who: ctx.who }));
    }
    if (error.status === 404) {
      throw new UserError(
        ctx.action === "list" || ctx.action === "add"
          ? `Проект ${ctx.project} не найден на инстансе либо закрыт от владельца ключа. Список: redmine.ts projects`
          : "Такого членства нет: его уже удалили либо номер с другого инстанса. Номера — redmine.ts members <проект>.",
      );
    }
    throw error;
  }
}

export type RoleCheck = { ok: boolean; absent: boolean; missing: IdName[]; extra: IdName[] };

/**
 * Сверка после записи. Redmine молча отбрасывает роли, которые владельцу ключа не разрешено
 * назначать или снимать, и всё равно отвечает успехом — верить ответу нельзя, только перечитанному.
 */
export function checkMemberRoles(after: Membership | undefined, expected: IdName[]): RoleCheck {
  if (!after) return { ok: false, absent: true, missing: expected, extra: [] };
  const own = ownRoles(after);
  const ownIds = new Set(own.map((r) => r.id));
  const wantIds = new Set(expected.map((r) => r.id));
  const missing = expected.filter((r) => !ownIds.has(r.id)).map(({ id, name }) => ({ id, name }));
  const extra = own.filter((r) => !wantIds.has(r.id)).map(({ id, name }) => ({ id, name }));
  return { ok: missing.length === 0 && extra.length === 0, absent: false, missing, extra };
}

export function roleCheckText(check: RoleCheck, who: string): string {
  if (check.ok) return `Сверка: собственные роли ${who} в проекте совпадают с запрошенными.`;
  if (check.absent) {
    return `РАСХОЖДЕНИЕ: Redmine ответил успехом, но ${who} среди участников проекта нет. Проверьте: redmine.ts members <проект>.`;
  }
  const parts = [
    check.missing.length > 0 ? `не легли роли ${check.missing.map((r) => r.name).join(", ")}` : "",
    check.extra.length > 0 ? `остались роли ${check.extra.map((r) => r.name).join(", ")}` : "",
  ].filter(Boolean);
  return (
    `РАСХОЖДЕНИЕ: ${parts.join("; ")}.\n` +
    "  Redmine молча пропускает роли, которые владельцу ключа не разрешено назначать или снимать (ограничение\n" +
    "  «только эти роли» у права «Управление участниками»). Их меняет администратор или менеджер проекта без ограничения."
  );
}

// ── разбор аргументов ──

function noExtraWords(args: Args, used: number, example: string): void {
  const extra = args.positional.slice(used);
  if (extra.length > 0) {
    throw new UserError(
      `Лишние слова в команде: ${extra.map((x) => `"${x}"`).join(" ")}. Имя из нескольких слов берите в кавычки: ${example}.`,
    );
  }
}

export function readAddMember(args: Args): { project: string; user: string; roles: string[] } {
  const fromPositional = args.positional[0];
  const project = (fromPositional ?? str(args, "project"))?.trim();
  if (!project) {
    throw new UserError('Укажите проект: redmine.ts add-member <проект> --user <id|имя|me> --role <роль>.');
  }
  noExtraWords(args, fromPositional === undefined ? 0 : 1, '--user "Имя Фамилия"');
  const user = str(args, "user")?.trim();
  if (!user) throw new UserError('Укажите, кого добавить: --user <id|"Имя Фамилия"|me>.');
  const roleNames = values(args, "role");
  if (roleNames.length === 0) {
    throw new UserError('Укажите хотя бы одну роль: --role "<роль>" (флаг повторяется; справочник — redmine.ts roles).');
  }
  return { project, user, roles: roleNames };
}

function readMembershipId(args: Args, cmd: string): number {
  const raw = args.positional[0] ?? str(args, "membership") ?? str(args, "id");
  if (!raw) {
    throw new UserError(`Укажите номер членства: redmine.ts ${cmd} <членство> (номера — в redmine.ts members <проект>).`);
  }
  const id = Number(raw.trim().replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) {
    throw new UserError(
      `Номер членства — целое число, получено "${raw}". Это не номер пользователя и не проект: ` +
        "его видно в первой колонке redmine.ts members <проект>.",
    );
  }
  return id;
}

export function readUpdateMember(args: Args): { membershipId: number; roles: string[] } {
  const membershipId = readMembershipId(args, "update-member");
  noExtraWords(args, args.positional.length > 0 ? 1 : 0, '--role "Имя роли"');
  const roleNames = values(args, "role");
  if (roleNames.length === 0) {
    throw new UserError(
      "Укажите новый набор ролей целиком: --role <роль> [--role …]. Роли, которых в списке нет, будут сняты.",
    );
  }
  return { membershipId, roles: roleNames };
}

export function readRemoveMember(args: Args): { membershipId: number } {
  const membershipId = readMembershipId(args, "remove-member");
  noExtraWords(args, args.positional.length > 0 ? 1 : 0, "remove-member <членство>");
  return { membershipId };
}

// ── команды ──

async function memberProjectOf(rm: Resolved, ref: IdName): Promise<MemberProject> {
  const known = (await projects(rm)).find((p) => p.id === ref.id);
  if (known) {
    return {
      id: known.id,
      name: known.name,
      identifier: known.identifier,
      url: projectUrl(rm, known.identifier),
      isPublic: known.is_public === true,
    };
  }
  return { id: ref.id, name: ref.name, identifier: String(ref.id), url: projectUrl(rm, String(ref.id)), isPublic: null };
}

function toMemberProject(rm: Resolved, p: ProjectRef): MemberProject {
  return { id: p.id, name: p.name, identifier: p.identifier, url: projectUrl(rm, p.identifier), isPublic: p.is_public === true };
}

/** После записи всё, что скрипт помнит об участниках, устарело. */
function forgetMembers(rm: Resolved): void {
  for (const key of [...membersMemo.keys()]) if (key.startsWith(`${rm.name}:`)) membersMemo.delete(key);
  peopleMemo.delete(rm.name);
}

async function loadMembership(rm: Resolved, id: number, action: "update" | "remove"): Promise<Membership> {
  return withMemberErrors({ action, project: "(ещё не определён)", who: `членство ${id}` }, async () => {
    try {
      return (await request<{ membership: Membership }>(rm, "GET", `memberships/${id}.json`)).membership;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        throw new UserError(
          `Членство ${id} закрыто от владельца ключа: нужна роль с правом «Просмотр участников» или «Управление участниками» ` +
            "в его проекте.",
        );
      }
      throw error;
    }
  });
}

/** Открытые задачи на участнике: после удаления они повиснут на человеке вне проекта. */
async function openAssignedCount(rm: Resolved, projectId: number, userId: number): Promise<number | null> {
  try {
    const r = await request<{ total_count?: number }>(rm, "GET", "issues.json", {
      project_id: projectId,
      subproject_id: "!*",
      assigned_to_id: userId,
      status_id: "open",
      limit: 1,
    });
    return typeof r.total_count === "number" ? r.total_count : null;
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

async function cmdMembers(rm: Resolved, args: Args): Promise<void> {
  const target = args.positional[0] ?? str(args, "project") ?? rm.defaultProject;
  if (!target) throw new UserError("Укажите проект: redmine.ts members <identifier|id|часть названия>");
  const project = await findProject(rm, target);
  const title = projectTitle(project);
  const list = await withMemberErrors({ action: "list", project: title, who: "" }, () =>
    loadMemberships(rm, project.id),
  );
  // Группы сверху: их роли расходятся на всех участников группы, это первое, что стоит увидеть.
  const sorted = [...list].sort(
    (a, b) =>
      Number(Boolean(b.group)) - Number(Boolean(a.group)) ||
      ((a.user ?? a.group)?.name ?? "").localeCompare((b.user ?? b.group)?.name ?? "", "ru"),
  );
  const users = list.filter((m) => m.user).length;
  const groups = list.filter((m) => m.group).length;
  const anyInherited = list.some((m) => m.roles.some((r) => r.inherited === true));

  emit(
    {
      instance: rm.name,
      project: { id: project.id, identifier: project.identifier, name: project.name },
      memberships: sorted,
    },
    () =>
      `УЧАСТНИКИ ПРОЕКТА ${title} · инстанс ${rm.name}\n${projectUrl(rm, project.identifier)}\n` +
      (sorted.length === 0
        ? "Участников нет."
        : table([
            ["ЧЛЕНСТВО", "ВИД", "КТО", "РОЛИ"],
            ...sorted.map((m) => [
              String(m.id),
              m.group ? "группа" : "пользователь",
              `${(m.user ?? m.group)?.name ?? "—"} (id=${(m.user ?? m.group)?.id ?? "?"})`,
              describeMemberRoles(m.roles),
            ]),
          ]) + `\n\nВсего ${list.length}: пользователей ${users}, групп ${groups}.`) +
      (anyInherited
        ? "\n«унасл.» — роли, пришедшие от группы или родительского проекта: снимаются там, откуда пришли."
        : "") +
      `\nРоли: redmine.ts update-member <членство> --role <роль> · удалить: redmine.ts remove-member <членство>` +
      ` · справочник ролей: redmine.ts roles`,
  );
}

async function cmdRoles(rm: Resolved, _args: Args): Promise<void> {
  const list = await roles(rm);
  emit(
    list.map((r) => ({ ...r, summary: describeRole(r) })),
    () =>
      `РОЛИ · инстанс ${rm.name}\n` +
      table([["ID", "РОЛЬ", "ЧТО ДАЁТ"], ...list.map((r) => [String(r.id), r.name, describeRole(r)])]) +
      `\n\nНазначить: redmine.ts add-member <проект> --user <id|имя|me> --role <имя|id>.` +
      `\nПолный перечень прав роли — «Администрирование → Роли и права».`,
  );
}

async function cmdAddMember(rm: Resolved, args: Args): Promise<void> {
  const input = readAddMember(args);
  const project = await findProject(rm, input.project);
  const title = projectTitle(project);
  const picked = resolveRoles(await roles(rm), input.roles);
  const principal = await resolvePrincipal(rm, input.user);
  const who = principalName(principal);

  const current = await withMemberErrors({ action: "list", project: title, who }, () =>
    loadMemberships(rm, project.id),
  );
  const existing = findMembership(current, principal.id);
  if (existing) {
    const allInherited = ownRoles(existing).length === 0;
    throw new UserError(
      `${who} уже участник проекта ${title}: роли ${describeMemberRoles(existing.roles)}, членство ${existing.id}.\n` +
        "  Добавить второй раз нельзя — Redmine держит одно членство на человека в проекте.\n" +
        (allInherited
          ? "  Все его роли сейчас унаследованы (от группы или родительского проекта); собственные роли поверх них задаёт update-member.\n"
          : "") +
        `  Изменить роли: redmine.ts update-member ${existing.id} --role <роль> --instance ${rm.name}`,
    );
  }

  const req = addMemberRequest(project.id, principal.id, picked.map((r) => r.id));
  const preview = addMemberPreview({
    instance: rm.name,
    project: toMemberProject(rm, project),
    principal,
    roles: picked,
    memberCount: current.length,
  });
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  await withMemberErrors({ action: "add", project: title, who }, () => sendMembership(rm, req));
  forgetMembers(rm);
  const placed = findMembership(await loadMemberships(rm, project.id), principal.id);
  const check = checkMemberRoles(placed, picked);
  emit({ membership: placed ?? null, check }, () =>
    (placed
      ? `Участник добавлен: ${who} → проект ${title}, членство ${placed.id}\n` +
        `${projectUrl(rm, project.identifier)}\nРоли: ${describeMemberRoles(placed.roles)}\n`
      : "") + roleCheckText(check, who),
  );
  if (!check.ok) process.exitCode = 1;
}

async function cmdUpdateMember(rm: Resolved, args: Args): Promise<void> {
  const input = readUpdateMember(args);
  const membership = await loadMembership(rm, input.membershipId, "update");
  const project = await memberProjectOf(rm, membership.project);
  const title = projectTitle(project);
  const catalogue = await roles(rm);
  const picked = resolveRoles(catalogue, input.roles);
  const me = await currentUser(rm);
  const principal = principalOf(membership, me.id);
  const who = principalName(principal);

  const own = ownRoles(membership);
  const same = own.length === picked.length && picked.every((r) => own.some((o) => o.id === r.id));
  if (same) {
    throw new UserError(`У ${who} в проекте ${title} уже ровно эти роли: ${describeMemberRoles(own)}. Менять нечего.`);
  }

  const manages = (ids: number[]): boolean =>
    ids.some((id) => catalogue.find((r) => r.id === id)?.permissions?.includes("manage_members") === true);
  const selfLosesManage =
    principal.self &&
    manages(membership.roles.map((r) => r.id)) &&
    !manages([...picked.map((r) => r.id), ...inheritedRoles(membership).map((r) => r.id)]);

  const req = updateMemberRequest(membership.id, picked.map((r) => r.id));
  const preview = updateMemberPreview({ instance: rm.name, project, principal, membership, roles: picked, selfLosesManage });
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  await withMemberErrors({ action: "update", project: title, who }, () => sendMembership(rm, req));
  forgetMembers(rm);
  const after = (await request<{ membership: Membership }>(rm, "GET", `memberships/${membership.id}.json`)).membership;
  const check = checkMemberRoles(after, picked);
  emit({ membership: after, check }, () =>
    `Роли изменены: ${who} в проекте ${title}, членство ${after.id}\n${project.url}\n` +
      `Было: ${describeMemberRoles(membership.roles)}\nСтало: ${describeMemberRoles(after.roles)}\n` +
      roleCheckText(check, who),
  );
  if (!check.ok) process.exitCode = 1;
}

async function cmdRemoveMember(rm: Resolved, args: Args): Promise<void> {
  const input = readRemoveMember(args);
  const membership = await loadMembership(rm, input.membershipId, "remove");
  const project = await memberProjectOf(rm, membership.project);
  const title = projectTitle(project);
  const me = await currentUser(rm);
  const principal = principalOf(membership, me.id);
  const who = principalName(principal);

  // Redmine не удаляет членство с унаследованной ролью и отвечает на это пустым отказом — говорим заранее.
  const inherited = inheritedRoles(membership);
  if (inherited.length > 0) {
    throw new UserError(
      `Удалить ${who} из проекта ${title} этой командой нельзя: роли ${inherited.map((r) => r.name).join(", ")} ` +
        "унаследованы — от группы, в которой он состоит, или от родительского проекта.\n" +
        "  Удалять нужно там, откуда роль пришла: членство группы (redmine.ts members — строка группы) либо\n" +
        "  наследование участников в настройках проекта." +
        (ownRoles(membership).length > 0
          ? `\n  Собственные роли (${ownRoles(membership).map((r) => r.name).join(", ")}) можно сократить: update-member ${membership.id}.`
          : ""),
    );
  }

  const openIssues = principal.kind === "user" ? await openAssignedCount(rm, project.id, principal.id) : null;
  const preview = removeMemberPreview({ instance: rm.name, project, principal, membership, openIssues });
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes — только после отдельного «да» на удаление")) {
    return;
  }

  await withMemberErrors({ action: "remove", project: title, who }, () =>
    sendMembership(rm, removeMemberRequest(membership.id)),
  );
  forgetMembers(rm);

  let verdict: string;
  let gone: boolean;
  try {
    const after = await loadMemberships(rm, project.id);
    gone = !after.some((m) => m.id === membership.id);
    verdict = gone
      ? `Сверка: членства ${membership.id} в проекте больше нет.`
      : `РАСХОЖДЕНИЕ: Redmine ответил успехом, но членство ${membership.id} на месте. Проверьте: redmine.ts members ${project.identifier}.`;
  } catch (error) {
    // Удалив себя из закрытого проекта, ключ теряет право читать его участников — это и есть подтверждение.
    if (!(error instanceof ApiError) || !principal.self || (error.status !== 403 && error.status !== 404)) throw error;
    gone = true;
    verdict = "Сверка: проект больше не виден владельцу ключа — удаление себя из него подтверждено этим.";
  }
  emit({ removed: membership.id, verified: gone }, () =>
    `Участник удалён: ${who} больше не в проекте ${title} (членство ${membership.id}).\n${verdict}`,
  );
  if (!gone) process.exitCode = 1;
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

// ──────────────────────── связи между задачами ────────────────────────

/**
 * Типы связей Redmine. `relation_type` хранится от лица задачи `issue_id`, поэтому при взгляде
 * со стороны второй задачи тип разворачивается: «#A блокирует #B» читается как «#B заблокирована #A».
 */
export type RelationType =
  | "relates"
  | "duplicates"
  | "duplicated"
  | "blocks"
  | "blocked"
  | "precedes"
  | "follows"
  | "copied_to"
  | "copied_from";

type IssueRelation = {
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type: string;
  delay?: number | null;
};

const RELATION_OPPOSITE: Record<RelationType, RelationType> = {
  relates: "relates",
  duplicates: "duplicated",
  duplicated: "duplicates",
  blocks: "blocked",
  blocked: "blocks",
  precedes: "follows",
  follows: "precedes",
  copied_to: "copied_from",
  copied_from: "copied_to",
};

const RELATION_TYPES = Object.keys(RELATION_OPPOSITE) as RelationType[];

/** Тип связи глазами второй задачи. */
export function invertRelationType(type: RelationType): RelationType {
  return RELATION_OPPOSITE[type];
}

/** Строка из ответа Redmine в тип, или null — если инстанс прислал незнакомое. */
export function asRelationType(raw: string): RelationType | null {
  const key = raw.trim().toLowerCase();
  return (RELATION_TYPES as string[]).includes(key) ? (key as RelationType) : null;
}

const RELATION_LABEL: Record<RelationType, string> = {
  relates: "связана с",
  duplicates: "дублирует",
  duplicated: "продублирована в",
  blocks: "блокирует",
  blocked: "заблокирована задачей",
  precedes: "предшествует",
  follows: "следует за",
  copied_to: "скопирована в",
  copied_from: "скопирована из",
};

/** Короткое имя связи — для таблиц и заголовков. */
export function relationLabel(type: RelationType): string {
  return RELATION_LABEL[type];
}

/**
 * Синонимы типов связи. Пользователь говорит «заблокирована», а не `blocked`, и оба варианта
 * должны попадать в одно значение API. Ключи — в нормализованном виде: нижний регистр,
 * «ё» → «е», подчёркивания и дефисы → пробел.
 */
const RELATION_SYNONYMS: Record<string, RelationType> = {
  relates: "relates",
  relate: "relates",
  related: "relates",
  relation: "relates",
  "related to": "relates",
  связана: "relates",
  связан: "relates",
  связано: "relates",
  связь: "relates",
  "связана с": "relates",
  смежная: "relates",
  смежные: "relates",

  duplicates: "duplicates",
  duplicate: "duplicates",
  дублирует: "duplicates",
  дубль: "duplicates",
  дубликат: "duplicates",

  duplicated: "duplicated",
  "duplicated by": "duplicated",
  дублируется: "duplicated",
  продублирована: "duplicated",
  продублировано: "duplicated",
  "продублирована в": "duplicated",

  blocks: "blocks",
  block: "blocks",
  блокирует: "blocks",
  блокер: "blocks",

  blocked: "blocked",
  "blocked by": "blocked",
  заблокирована: "blocked",
  заблокирован: "blocked",
  заблокировано: "blocked",
  блокируется: "blocked",

  precedes: "precedes",
  precede: "precedes",
  предшествует: "precedes",
  перед: "precedes",
  раньше: "precedes",

  follows: "follows",
  follow: "follows",
  следует: "follows",
  "следует за": "follows",
  после: "follows",
  позже: "follows",

  "copied to": "copied_to",
  copiedto: "copied_to",
  "скопирована в": "copied_to",
  "копия в": "copied_to",

  "copied from": "copied_from",
  copiedfrom: "copied_from",
  "скопирована из": "copied_from",
  "копия из": "copied_from",
};

export function parseRelationType(raw: string): RelationType {
  const key = raw.trim().toLowerCase().replace(/ё/g, "е").replace(/[\s_-]+/g, " ").trim();
  const hit = RELATION_SYNONYMS[key];
  if (hit) return hit;
  throw new UserError(
    `Тип связи "${raw}" не распознан. Типы Redmine: relates (связана), duplicates (дублирует), ` +
      `duplicated (продублирована), blocks (блокирует), blocked (заблокирована), precedes (предшествует), ` +
      `follows (следует), copied_to (скопирована в), copied_from (скопирована из).`,
  );
}

/** Отсрочка имеет смысл только там, где Redmine двигает даты: в порядке выполнения. */
export function delayApplies(type: RelationType): boolean {
  return type === "precedes" || type === "follows";
}

/**
 * Что связь означает словами. Читателю предпросмотра нужен не код типа, а последствие:
 * что нельзя будет сделать и какие даты сдвинутся.
 */
export function describeRelation(
  type: RelationType,
  from: number | string,
  to: number | string,
  delay?: number | null,
): string {
  const a = `#${from}`;
  const b = `#${to}`;
  const gap = (after: string): string =>
    delay != null && delay > 0
      ? `через ${delay} дн. после окончания ${after}`
      : `на следующий день после окончания ${after}`;

  switch (type) {
    case "relates":
      return `${a} связана с ${b}: задачи об одном, но ни порядок, ни сроки, ни закрытие друг от друга не зависят.`;
    case "duplicates":
      return `${a} дублирует ${b}: это одна и та же работа; когда закроют ${b}, задача ${a} закроется вместе с ней.`;
    case "duplicated":
      return `${a} продублирована в ${b}: это одна и та же работа; когда закроют ${a}, задача ${b} закроется вместе с ней.`;
    case "blocks":
      return `${a} блокирует ${b}: пока ${a} не закрыта, ${b} выполнять нельзя — Redmine не даст перевести её в закрывающий статус.`;
    case "blocked":
      return `${a} заблокирована задачей ${b}: пока ${b} не закрыта, ${a} выполнять нельзя — Redmine не даст перевести её в закрывающий статус.`;
    case "precedes":
      return `${a} предшествует ${b}: ${b} начинается ${gap(a)}; при переносе сроков ${a} Redmine сдвинет даты ${b} сам.`;
    case "follows":
      return `${a} следует за ${b}: ${a} начинается ${gap(b)}; при переносе сроков ${b} Redmine сдвинет даты ${a} сам.`;
    case "copied_to":
      return `${a} скопирована в ${b}: ${b} заведена копированием ${a}, дальше задачи живут независимо.`;
    case "copied_from":
      return `${a} скопирована из ${b}: ${a} заведена копированием ${b}, дальше задачи живут независимо.`;
  }
}

/**
 * Отказ `422` по связи — это почти всегда одна из четырёх понятных ситуаций.
 * Показывать пользователю код ответа бессмысленно: ему нужно знать, что именно не сходится.
 */
export function explainRelationRejection(
  details: string[],
  ctx: { from: number; to: number; type: RelationType },
): string {
  const flat = details.join("; ").toLowerCase();
  const head = `Redmine отказался создать связь: ${describeRelation(ctx.type, ctx.from, ctx.to)}`;

  if (ctx.from === ctx.to || /itself|сама с собой|самой с собой/.test(flat)) {
    return (
      `${head}\n` +
      `  Задачу нельзя связать саму с собой: связь описывает отношение двух разных задач.\n` +
      `  Проверьте номера — скорее всего, вторая задача указана неверно.`
    );
  }
  if (/circular|цикл/.test(flat)) {
    return (
      `${head}\n` +
      `  Такая связь замкнула бы круг: #${ctx.to} уже прямо или через цепочку зависит от #${ctx.from}.\n` +
      `  Порядок выполнения должен быть линейным. Посмотрите цепочку — redmine.ts relations ${ctx.to} — ` +
      `и снимите лишнее звено (unrelate), либо свяжите задачи типом relates: он ничего не упорядочивает.`
    );
  }
  if (/descendant|subtask|подзадач|потомк|дочерн/.test(flat)) {
    return (
      `${head}\n` +
      `  Одна из задач — подзадача другой. Внутри дерева порядок задаёт иерархия, и Redmine ` +
      `запрещает дублировать её связями.\n` +
      `  Если порядок нужен между соседними подзадачами — связывайте их между собой, а не с родителем: ` +
      `redmine.ts tree ${ctx.from}`
    );
  }
  if (/taken|already|exists|существует|занят/.test(flat)) {
    return (
      `${head}\n` +
      `  Такая связь между этими задачами уже есть. Посмотреть: redmine.ts relations ${ctx.from}.\n` +
      `  Чтобы заменить её другой — сначала удалите прежнюю: redmine.ts unrelate <номер связи> --yes`
    );
  }
  return (
    `${head}\n` +
    `  Redmine ответил: ${details.join("; ") || "без пояснения"}.\n` +
    `  Обычные причины: задача в закрытом проекте, у владельца ключа нет права «Управление связями задач», ` +
    `либо тип связи запрещён рабочим процессом. Проверьте доступ: redmine.ts issue ${ctx.to}`
  );
}

/** Отказы по связям разворачиваются в объяснение — так же, как отказы по проектам. */
async function withRelationErrors<T>(
  ctx: { from: number; to: number; type: RelationType },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 422) throw new UserError(explainRelationRejection(error.details, ctx));
    if (error.status === 403) {
      throw new UserError(
        `Связь не создана: у владельца ключа нет права «Управление связями задач» в одном из проектов.\n` +
          `  Право выдаёт администратор в «Администрирование → Роли и права». Обходного пути нет.`,
      );
    }
    if (error.status === 404) {
      throw new UserError(
        `Одна из задач недоступна: #${ctx.from} или #${ctx.to} нет на инстансе либо она закрыта от владельца ключа.\n` +
          `  Если номер точно верный — проверьте второй инстанс: связи работают только внутри одного Redmine.`,
      );
    }
    throw error;
  }
}

// ──────────────── ссылки на задачи и второй инстанс ───────────────────

export type InstanceRef = { name: string; base: string };

export type IssueRef = {
  id: number;
  /** Профиль, явно названный в ссылке; не задан — значит, текущий инстанс. */
  instance?: string;
  /** Хост, не принадлежащий ни одному профилю из конфига. */
  foreignHost?: string;
  raw: string;
};

/** Имя профиля по названию, однозначному началу имени или подстроке адреса. */
function matchInstanceName(known: InstanceRef[], wanted: string): string | null {
  const needle = wanted.toLowerCase();
  const exact = known.find((k) => k.name.toLowerCase() === needle);
  if (exact) return exact.name;
  const byPrefix = known.filter((k) => k.name.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1) return byPrefix[0]!.name;
  const byUrl = known.filter((k) => k.base.toLowerCase().includes(needle));
  return byUrl.length === 1 ? byUrl[0]!.name : null;
}

/**
 * Ссылка на задачу в любом виде, в каком её называет человек: `1234`, `#1234`, `ru:25185`
 * или полный адрес. Адрес сверяется с профилями конфига — так становится видно,
 * что задача лежит на другом инстансе, где связи Redmine уже не работают.
 */
export function parseIssueRef(raw: string, known: InstanceRef[] = []): IssueRef {
  const value = raw.trim();
  if (!value) throw new UserError("Пустая ссылка на задачу.");

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new UserError(`Адрес «${value}» не разбирается как ссылка.`);
    }
    const found = url.pathname.match(/\/issues\/(\d+)/);
    if (!found) throw new UserError(`В адресе «${value}» нет номера задачи: ожидается …/issues/NNNN.`);
    const id = Number(found[1]);
    const low = value.toLowerCase();
    const hit = known.find((k) => low.startsWith(k.base.toLowerCase()));
    return hit ? { id, instance: hit.name, raw: value } : { id, foreignHost: url.host, raw: value };
  }

  const prefixed = value.match(/^([A-Za-z0-9_.-]+)\s*:\s*#?(\d+)$/);
  if (prefixed) {
    const name = matchInstanceName(known, prefixed[1]!);
    if (!name) {
      throw new UserError(
        `Инстанс "${prefixed[1]}" не найден. Профили: ${known.map((k) => k.name).join(", ") || "нет"} ` +
          `(список — redmine.ts instances).`,
      );
    }
    return { id: Number(prefixed[2]), instance: name, raw: value };
  }

  const bare = value.match(/^#?(\d+)$/);
  if (bare) return { id: Number(bare[1]), raw: value };

  throw new UserError(
    `Ссылка на задачу "${raw}" не разобрана. Форматы: 1234, #1234, ru:25185, https://…/issues/25185.`,
  );
}

export type CrossRef = { instance: string; id: number; url: string };

/**
 * Ссылки на задачи другого инстанса, спрятанные в описании или комментарии.
 * Связей Redmine между инстансами не бывает, поэтому такая ссылка — единственный вид связи,
 * и теряться в тексте она не должна.
 */
export function findCrossInstanceRefs(text: string, others: InstanceRef[]): CrossRef[] {
  if (!text || others.length === 0) return [];
  const out: CrossRef[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? []) {
    const low = raw.toLowerCase();
    const hit = others.find((o) => low.startsWith(o.base.toLowerCase()));
    if (!hit) continue;
    const found = raw.match(/\/issues\/(\d+)/);
    if (!found) continue;
    const id = Number(found[1]);
    const key = `${hit.name}#${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ instance: hit.name, id, url: `${hit.base}issues/${id}` });
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Подпись перекрёстной ссылки: проект отвечает на вопрос «чья это задача». */
export function xrefLabel(project: string, id: number, subject: string): string {
  return `${project} #${id} — ${subject}`;
}

/**
 * Готовая строка для вставки в текст на другом инстансе. Номером `#NNNN` её писать нельзя:
 * там этот номер указывает на чужую задачу, и читатель уходит не туда.
 */
export function formatXref(
  ref: { url: string; id: number; project: string; subject: string },
  markup: "html" | "textile" | "markdown" = "html",
): string {
  const label = xrefLabel(ref.project, ref.id, ref.subject);
  if (markup === "markdown") return `[${label}](${ref.url})`;
  if (markup === "textile") return `"${label}":${ref.url}`;
  return `<a href="${ref.url}">${escapeHtml(label)}</a>`;
}

/** Профили конфига как «имя + адрес»: ключи здесь не нужны, поэтому берутся и профили без них. */
async function instanceRefs(): Promise<InstanceRef[]> {
  const cfg = await readConfigFile();
  const out: InstanceRef[] = [];
  for (const [name, inst] of Object.entries(cfg?.instances ?? {})) {
    if (!inst.url) continue;
    try {
      out.push({ name, base: normalizeBase(inst.url) });
    } catch {
      // Кривой url в конфиге не должен ронять чтение задачи.
    }
  }
  return out;
}

/** Задача, которой может не быть или которая закрыта от владельца ключа. */
async function tryIssue(rm: Resolved, id: number): Promise<Issue | null> {
  try {
    return (await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`)).issue;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

type RelationView = { relation: IssueRelation; type: RelationType; otherId: number };

/** Связи задачи, развёрнутые от её лица. */
function viewRelations(relations: IssueRelation[], id: number): RelationView[] {
  const out: RelationView[] = [];
  for (const relation of relations) {
    const stored = asRelationType(relation.relation_type);
    if (!stored) continue;
    const mine = relation.issue_id === id ? stored : invertRelationType(stored);
    const otherId = relation.issue_id === id ? relation.issue_to_id : relation.issue_id;
    out.push({ relation, type: mine, otherId });
  }
  return out;
}

/** Блок связей для карточки задачи: тип, вторая задача, её статус и номер самой связи. */
function relationLines(views: RelationView[], others: Map<number, Issue | null>): string[] {
  return views.map(({ relation, type, otherId }) => {
    const other = others.get(otherId) ?? null;
    const delay = delayApplies(type) && relation.delay ? `, отсрочка ${relation.delay} дн.` : "";
    return (
      `  ${relationLabel(type)} #${otherId}` +
      (other ? ` — ${clip(other.subject, 60)} (${other.status.name})` : " — нет доступа или задача удалена") +
      ` · связь ${relation.id}${delay}`
    );
  });
}

/** Подтягивает вторые задачи связей одним заходом: без них список связей нечитаем. */
async function loadRelatedIssues(rm: Resolved, views: RelationView[]): Promise<Map<number, Issue | null>> {
  const ids = [...new Set(views.map((v) => v.otherId))];
  const loaded = await mapLimit(ids, 4, (id) => tryIssue(rm, id));
  return new Map(ids.map((id, index) => [id, loaded[index] ?? null]));
}

/** Текст задачи целиком — описание и все комментарии: перекрёстные ссылки ищутся по нему. */
function issueFullText(issue: Issue): string {
  return [issue.description ?? "", ...(issue.journals ?? []).map((j) => j.notes ?? "")].join("\n");
}

function crossRefLines(refs: CrossRef[]): string[] {
  return refs.map(
    (r) => `  ${r.instance} #${r.id} — ${r.url}  (подробнее: redmine.ts issue ${r.id} --instance ${r.instance})`,
  );
}

async function cmdRelations(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? str(args, "issue");
  if (!raw) throw new UserError("Укажите номер задачи: redmine.ts relations 25185");
  const id = Number(raw.replace("#", ""));
  if (!Number.isInteger(id)) throw new UserError("Укажите номер задачи: redmine.ts relations 25185");

  const issue = (await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`, { include: "relations,journals" }))
    .issue;
  const views = viewRelations(issue.relations ?? [], id);
  const others = await loadRelatedIssues(rm, views);
  const cross = findCrossInstanceRefs(
    issueFullText(issue),
    (await instanceRefs()).filter((x) => x.name !== rm.name),
  );

  emit(
    {
      instance: rm.name,
      issue: { id, subject: issue.subject },
      relations: views.map((v) => ({ id: v.relation.id, type: v.type, issue: v.otherId, delay: v.relation.delay })),
      crossInstanceRefs: cross,
    },
    () => {
      const lines = [`СВЯЗИ #${id} — ${issue.subject}`, issueUrl(rm, id), ""];
      if (views.length === 0) lines.push("Связей в Redmine нет.");
      else {
        lines.push(...relationLines(views, others), "");
        lines.push("Что это значит:");
        for (const v of views) lines.push(`  ${describeRelation(v.type, id, v.otherId, v.relation.delay)}`);
        lines.push("", `Удалить связь: redmine.ts unrelate <номер связи> --instance ${rm.name} --yes`);
      }
      if (cross.length > 0) {
        lines.push(
          "",
          "Связано на другом инстансе (ссылкой в тексте — связей Redmine между инстансами не бывает):",
          ...crossRefLines(cross),
        );
      }
      return lines.join("\n");
    },
  );
}

/** Ровно та ситуация, ради которой команда отказывается работать: задача на другом Redmine. */
async function reportCrossInstance(rm: Resolved, ref: IssueRef, fromId: number): Promise<void> {
  if (ref.foreignHost) {
    throw new UserError(
      `Адрес ${ref.raw} не принадлежит ни одному профилю из конфига (хост ${ref.foreignHost}).\n` +
        `  Связи Redmine существуют только внутри одного инстанса. Если это наш второй Redmine — ` +
        `добавьте его профиль в конфиг (redmine.ts instances), иначе вставьте ссылку в текст руками.`,
    );
  }

  const target = await resolveInstance(ref.instance);
  const issue = await tryIssue(target, ref.id);
  const url = issueUrl(target, ref.id);
  // Строка вставляется в #fromId на исходном инстансе — значит, и разметка нужна его, а не инстанса задачи.
  const markup = rm.markup ?? "html";
  const line = issue
    ? formatXref({ url, id: ref.id, project: issue.project.name, subject: issue.subject }, markup)
    : null;

  emit(
    {
      crossInstance: true,
      created: false,
      from: { instance: rm.name, issue: fromId },
      to: { instance: target.name, issue: ref.id, url },
      xref: line,
    },
    () =>
      [
        `СВЯЗЬ НЕ СОЗДАНА: #${fromId} лежит на инстансе ${rm.name}, а #${ref.id} — на ${target.name}.`,
        "",
        "Связи Redmine живут внутри одного инстанса: у второго Redmine своя нумерация задач, и объекта,",
        "который связал бы две базы, в API не существует. Обходного пути нет — и придумывать его не надо.",
        "",
        `Связывают такие задачи перекрёстной ссылкой в тексте обеих. Готовая строка для #${fromId}:`,
        "─".repeat(60),
        line ?? `${url}  (тему задачи прочитать не удалось: нет доступа к #${ref.id} на ${target.name})`,
        "─".repeat(60),
        "",
        `Вставьте её в описание или комментарий #${fromId} (redmine.ts comment ${fromId} --text-file …),`,
        `а в #${ref.id} на ${target.name} — встречную: redmine.ts xref ${fromId} --instance ${rm.name}.`,
        "Связь нужна с обеих сторон, иначе её найдёт только тот, кто и так знает, где искать.",
      ].join("\n"),
  );
}

async function cmdRelate(rm: Resolved, args: Args): Promise<void> {
  const rawFrom = args.positional[0] ?? str(args, "from") ?? str(args, "issue");
  if (!rawFrom) throw new UserError("Укажите задачу: redmine.ts relate 25185 --to 25190 --type blocks");
  const fromId = Number(rawFrom.replace("#", ""));
  if (!Number.isInteger(fromId)) throw new UserError("Первый аргумент — номер задачи: redmine.ts relate 25185 --to …");

  const rawTo = str(args, "to") ?? args.positional[1];
  if (!rawTo) throw new UserError("Укажите вторую задачу: --to 25190 (либо --to ru:25185, либо полный адрес).");

  const known = await instanceRefs();
  const ref = parseIssueRef(rawTo, known);
  if (ref.foreignHost || (ref.instance && ref.instance !== rm.name)) {
    await reportCrossInstance(rm, ref, fromId);
    return;
  }

  const type = parseRelationType(required(args, "type"));
  const delay = num(args, "delay");
  if (delay !== undefined && !delayApplies(type)) {
    throw new UserError(
      `Отсрочка --delay имеет смысл только у precedes и follows: там Redmine двигает даты второй задачи. ` +
        `Для связи «${relationLabel(type)}» она ничего не значит — уберите флаг.`,
    );
  }
  if (fromId === ref.id) {
    throw new UserError(
      `#${fromId} нельзя связать саму с собой: связь описывает отношение двух разных задач. Проверьте --to.`,
    );
  }

  const [from, to] = await Promise.all([tryIssue(rm, fromId), tryIssue(rm, ref.id)]);
  const missing = [from ? null : fromId, to ? null : ref.id].filter((x): x is number => x !== null);
  if (missing.length > 0) {
    throw new UserError(
      `На инстансе ${rm.name} недоступны: ${missing.map((id) => `#${id}`).join(", ")} — задачи нет либо она закрыта от ключа.\n` +
        `  Если номер верный, проверьте второй инстанс: redmine.ts issue ${missing[0]} --instance <профиль>.\n` +
        `  Связать задачи с разных инстансов нельзя — там нужна перекрёстная ссылка: ` +
        `redmine.ts xref ${missing[0]} --instance <профиль>.`,
    );
  }

  const existing = viewRelations(
    (await request<{ relations: IssueRelation[] }>(rm, "GET", `issues/${fromId}/relations.json`)).relations ?? [],
    fromId,
  ).filter((v) => v.otherId === ref.id);
  if (existing.length > 0) {
    const shown = existing.map((v) => `  ${relationLabel(v.type)} #${v.otherId} · связь ${v.relation.id}`).join("\n");
    throw new UserError(
      `#${fromId} и #${ref.id} уже связаны:\n${shown}\n` +
        `  Redmine держит одну связь на пару задач. Чтобы заменить тип — сначала удалите прежнюю: ` +
        `redmine.ts unrelate ${existing[0]!.relation.id} --instance ${rm.name} --yes`,
    );
  }

  const preview =
    `СВЯЗЬ ЗАДАЧ · инстанс ${rm.name} · тип ${relationLabel(type)} (${type})` +
    (delay !== undefined ? ` · отсрочка ${delay} дн.` : "") +
    `\n` +
    `  #${from!.id} — ${from!.subject}\n` +
    `    ${from!.project.name} · ${from!.status.name} · срок ${from!.due_date ?? "—"} · ${issueUrl(rm, from!.id)}\n` +
    `  #${to!.id} — ${to!.subject}\n` +
    `    ${to!.project.name} · ${to!.status.name} · срок ${to!.due_date ?? "—"} · ${issueUrl(rm, to!.id)}\n` +
    `${"─".repeat(60)}\n` +
    `${describeRelation(type, from!.id, to!.id, delay)}\n` +
    `${"─".repeat(60)}\n` +
    (delayApplies(type) ? "Redmine пересчитает даты второй задачи по сроку первой — проверьте, что это ожидаемо.\n" : "") +
    (type === "duplicates" || type === "duplicated"
      ? "Закрытие одной из задач закроет вторую автоматически.\n"
      : "") +
    "Участники обеих задач получат уведомление.";

  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  const body: Record<string, unknown> = { issue_to_id: ref.id, relation_type: type };
  if (delay !== undefined) body.delay = delay;
  const created = await withRelationErrors({ from: fromId, to: ref.id, type }, () =>
    request<{ relation: IssueRelation }>(rm, "POST", `issues/${fromId}/relations.json`, undefined, { relation: body }),
  );

  emit(
    { created: created.relation },
    () =>
      `Связь ${created.relation.id} создана: ${describeRelation(type, fromId, ref.id, delay)}\n${issueUrl(rm, fromId)}`,
  );
}

async function cmdUnrelate(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? str(args, "relation") ?? str(args, "id");
  if (!raw) throw new UserError("Укажите номер связи: redmine.ts unrelate 812 --yes (номера видно в relations).");
  const relationId = Number(raw.replace("#", ""));
  if (!Number.isInteger(relationId)) {
    throw new UserError("Номер связи — число: redmine.ts unrelate 812 --yes (номера видно в relations).");
  }

  let relation: IssueRelation;
  try {
    relation = (await request<{ relation: IssueRelation }>(rm, "GET", `relations/${relationId}.json`)).relation;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new UserError(
        `Связи ${relationId} на инстансе ${rm.name} нет: её уже удалили либо номер с другого инстанса.\n` +
          `  Номера связей видно в карточке задачи: redmine.ts relations <номер задачи>`,
      );
    }
    throw error;
  }

  const stored = asRelationType(relation.relation_type) ?? "relates";
  const [from, to] = await Promise.all([tryIssue(rm, relation.issue_id), tryIssue(rm, relation.issue_to_id)]);
  const name = (id: number, issue: Issue | null): string =>
    `#${id}${issue ? ` — ${issue.subject} (${issue.status.name})` : ""}`;

  const preview =
    `УДАЛЕНИЕ СВЯЗИ ${relationId} · инстанс ${rm.name}\n` +
    `  ${name(relation.issue_id, from)}\n` +
    `  ${name(relation.issue_to_id, to)}\n` +
    `${"─".repeat(60)}\n` +
    `Сейчас: ${describeRelation(stored, relation.issue_id, relation.issue_to_id, relation.delay)}\n` +
    `После удаления задачи останутся сами по себе; тексты и часы не затрагиваются.\n` +
    `${"─".repeat(60)}`;

  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  await request(rm, "DELETE", `relations/${relationId}.json`);
  emit(
    { deleted: relationId },
    () => `Связь ${relationId} удалена: #${relation.issue_id} и #${relation.issue_to_id} больше не связаны.`,
  );
}

async function cmdXref(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? str(args, "issue");
  if (!raw) throw new UserError("Укажите задачу: redmine.ts xref 25185 --instance ru");
  const known = await instanceRefs();
  const ref = parseIssueRef(raw, known);
  if (ref.foreignHost) {
    throw new UserError(
      `Адрес ${ref.raw} не принадлежит ни одному профилю из конфига (хост ${ref.foreignHost}). ` +
        `Перекрёстную ссылку скилл строит только по известным инстансам.`,
    );
  }

  const source = ref.instance && ref.instance !== rm.name ? await resolveInstance(ref.instance) : rm;
  const issue = await tryIssue(source, ref.id);
  if (!issue) {
    throw new UserError(
      `#${ref.id} на инстансе ${source.name} недоступна: задачи нет либо она закрыта от владельца ключа.\n` +
        `  Проверьте номер и профиль: redmine.ts instances`,
    );
  }

  const url = issueUrl(source, ref.id);
  // Строка вставляется в текст на другом инстансе — значит, и разметка нужна его.
  const elsewhere = known.filter((k) => k.name !== source.name);
  const cfg = await readConfigFile();
  const guessed = elsewhere.length === 1 ? cfg?.instances[elsewhere[0]!.name]?.markup : undefined;
  const requested = str(args, "markup");
  const markup: "html" | "textile" | "markdown" =
    requested === "textile" || requested === "markdown" || requested === "html"
      ? requested
      : (guessed ?? source.markup ?? "html");

  const line = formatXref({ url, id: ref.id, project: issue.project.name, subject: issue.subject }, markup);
  const label = xrefLabel(issue.project.name, ref.id, issue.subject);

  emit(
    {
      instance: source.name,
      issue: { id: ref.id, project: issue.project.name, subject: issue.subject },
      url,
      markup,
      label,
      xref: line,
    },
    () =>
      [
        `ПЕРЕКРЁСТНАЯ ССЫЛКА на #${ref.id} · инстанс ${source.name}`,
        label,
        url,
        "",
        `Вставить в текст на другом инстансе (разметка ${markup}${requested ? "" : ", задаётся флагом --markup"}):`,
        "─".repeat(60),
        line,
        "─".repeat(60),
        "",
        `Без разметки: ${label} (${url})`,
        "",
        `На инстансе ${source.name} эта задача пишется просто #${ref.id}. На другом так писать нельзя:`,
        `там #${ref.id} — чужая задача, и читатель уйдёт не туда. Правило — references/editorial.md,`,
        "раздел «Ссылки между задачами».",
      ].join("\n"),
  );
}

async function cmdIssue(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? str(args, "issue");
  if (!raw) throw new UserError("Укажите номер задачи: redmine.ts issue 1234");
  const id = Number(raw.replace("#", ""));
  const r = await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`, { include: "journals,relations" });
  const i = r.issue;
  const journals = (i.journals ?? []).filter((j) => j.notes?.trim() || j.details.length > 0);
  const tail = journals.slice(-(num(args, "comments") ?? 5));

  // Связь, которой не видно в карточке, связью не работает: показываем обе разновидности.
  const views = viewRelations(i.relations ?? [], i.id);
  const related = await loadRelatedIssues(rm, views);
  const cross = findCrossInstanceRefs(
    issueFullText(i),
    (await instanceRefs()).filter((x) => x.name !== rm.name),
  );

  emit({ ...i, crossInstanceRefs: cross }, () => {
    const lines = [
      `#${i.id} — ${i.subject}`,
      issueUrl(rm, i.id),
      `Проект: ${i.project.name} | Трекер: ${i.tracker.name} | Статус: ${i.status.name} | Приоритет: ${i.priority.name}`,
      `Исполнитель: ${i.assigned_to?.name ?? "—"} | Автор: ${i.author.name} | Готовность: ${i.done_ratio}%`,
      `Оценка: ${i.estimated_hours != null ? h(i.estimated_hours) : "—"} | Списано: ${
        i.spent_hours != null ? h(i.spent_hours) : "—"
      }` +
        (i.total_estimated_hours != null && i.total_estimated_hours !== (i.estimated_hours ?? 0)
          ? ` | С подзадачами: оценка ${h(i.total_estimated_hours)}, списано ${h(i.total_spent_hours ?? 0)}`
          : ""),
      `Начало: ${i.start_date ?? "—"} | Срок: ${i.due_date ?? "—"}${
        i.due_date ? ` (${daysUntil(i.due_date)} дн.)` : ""
      } | Обновлена: ${i.updated_on}`,
    ];
    if (i.description?.trim()) lines.push("", "Описание:", clipBlock(i.description, 2000));
    if (views.length) lines.push("", "Связи:", ...relationLines(views, related));
    if (cross.length) lines.push("", "Связано на другом инстансе:", ...crossRefLines(cross));
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

  // Задачи закрытых проектов только зашумляют выдачу: изменить их всё равно нельзя.
  const { visible, hidden } = await splitByProjectState(rm, r.issues, bool(args, "include-closed-projects"));

  emit({ instance: rm.name, total_count: r.total_count, hiddenInClosedProjects: hidden, issues: visible }, () =>
    visible.length === 0
      ? `Задач не найдено.${hidden > 0 ? ` Скрыто ${hidden} в закрытых проектах (--include-closed-projects).` : ""}`
      : `Найдено ${r.total_count}, показано ${visible.length}:\n` +
        table([
          ["ID", "СТАТУС", "ГОТОВ", "СРОК", "ПРОЕКТ", "ТЕМА"],
          ...visible.map((i) => [
            `#${i.id}`,
            clip(i.status.name, 14),
            `${i.done_ratio}%`,
            i.due_date ?? "—",
            clip(i.project.name, 20),
            clip(i.subject, 60),
          ]),
        ]) +
        (hidden > 0 ? `\n\nСкрыто ${hidden} задач в закрытых проектах — показать: --include-closed-projects` : ""),
  );
}

/** Делит задачи на доступные для изменения и те, что лежат в закрытых проектах. */
async function splitByProjectState(
  rm: Resolved,
  issues: Issue[],
  includeClosed: boolean,
): Promise<{ visible: Issue[]; hidden: number }> {
  if (includeClosed) return { visible: issues, hidden: 0 };
  const active = await activeProjectIds(rm);
  const visible = issues.filter((i) => active.has(i.project.id));
  return { visible, hidden: issues.length - visible.length };
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

/** Предпросмотр должен читаться человеком: идентификаторы разворачиваем в названия. */
async function previewIssuePayload(
  rm: Resolved,
  payload: Record<string, unknown>,
  subject: string,
  description: string | undefined,
  title = "НОВАЯ ЗАДАЧА",
): Promise<string> {
  const nameOf = async (list: Promise<IdName[]>, id: unknown): Promise<string> =>
    (await list).find((x) => x.id === Number(id))?.name ?? String(id);

  const rows: string[][] = [
    ["Проект", String(payload.project_id ?? "—")],
    ["Тема", subject],
  ];
  if (payload.tracker_id) rows.push(["Трекер", await nameOf(trackers(rm), payload.tracker_id)]);
  if (payload.parent_issue_id) rows.push(["Родительская", `#${payload.parent_issue_id}`]);
  if (payload.assigned_to_id) {
    const me = await currentUser(rm);
    rows.push([
      "Исполнитель",
      Number(payload.assigned_to_id) === me.id
        ? `${me.firstname} ${me.lastname} (вы)`
        : String(payload.assigned_to_id),
    ]);
  }
  if (payload.start_date) rows.push(["Начало", String(payload.start_date)]);
  if (payload.due_date) rows.push(["Срок", String(payload.due_date)]);
  if (payload.estimated_hours) rows.push(["Оценка", h(Number(payload.estimated_hours))]);
  if (payload.priority_id) rows.push(["Приоритет", await nameOf(priorities(rm), payload.priority_id)]);
  if (payload.status_id) rows.push(["Статус", await nameOf(statuses(rm), payload.status_id)]);

  // Задача заводится задним числом: сказать про created_on заранее, а не дать обнаружить самому.
  const today = fmtDate(new Date());
  const retro = [payload.start_date, payload.due_date].some((d) => typeof d === "string" && d < today);
  if (retro) {
    rows.push([
      "Дата создания",
      `${today} — created_on через API не задаётся ни при каких флагах. ` +
        `Реальный период читается по полям начала и срока, датам списаний и тексту задачи.`,
    ]);
  }

  const head = `${title} · инстанс ${rm.name}\n${table(rows)}`;
  if (!description?.trim()) return head;
  return `${head}\n\nОПИСАНИЕ (как уйдёт в Redmine):\n${"─".repeat(60)}\n${description.trim()}\n${"─".repeat(60)}`;
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
  if (assignee) {
    payload.assigned_to_id = await resolveAssignee(rm, assignee, payload.project_id as string | number);
  }
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

  checkOutgoing({ тема: subject, описание: description }, args);

  const preview = await previewIssuePayload(rm, payload, subject, description);
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

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
  const noteFile = str(args, "note-file");
  const note = noteFile ? await Bun.file(noteFile).text() : str(args, "note");
  if (note) patch.notes = note;
  const descriptionFile = str(args, "description-file");
  const description = descriptionFile ? await Bun.file(descriptionFile).text() : str(args, "description");
  if (description) patch.description = description;
  const subject = str(args, "subject");
  if (subject) patch.subject = subject;
  const parent = str(args, "parent");
  if (parent) patch.parent_issue_id = Number(parent.replace("#", ""));
  const estimated = str(args, "estimated");
  // «none» и «0» снимают оценку: Redmine очищает поле пустой строкой.
  if (estimated) {
    patch.estimated_hours = /^(none|нет|0)$/i.test(estimated.trim()) ? "" : round2(parseHours(estimated));
  }
  const assignee = str(args, "assignee");
  if (assignee) {
    // Проект задачи нужен, чтобы разрешить имя исполнителя по участникам.
    const project = /^(me|\d+)$/.test(assignee.trim())
      ? undefined
      : (await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`)).issue.project.id;
    patch.assigned_to_id = await resolveAssignee(rm, assignee, project);
  }
  const due = str(args, "due");
  if (due) patch.due_date = parseDate(due);
  if (Object.keys(patch).length === 0) {
    throw new UserError("Нечего менять: задайте --status/--done/--note/--description/--subject/--assignee/--due/--parent/--estimated.");
  }

  checkOutgoing({ комментарий: note, описание: description, тема: subject }, args);

  const rows = Object.entries(patch)
    .filter(([k]) => k !== "notes" && k !== "description")
    .map(([k, v]) => [k, clip(String(v), 70)]);
  const preview =
    `ИЗМЕНЕНИЕ #${id} · инстанс ${rm.name}\n${issueUrl(rm, id)}\n` +
    (rows.length ? table(rows) : "(только текст)") +
    (description
      ? `\n\nНОВОЕ ОПИСАНИЕ (заменит текущее целиком):\n${"─".repeat(60)}\n${description.trim()}\n${"─".repeat(60)}`
      : "") +
    (note ? `\n\nКОММЕНТАРИЙ:\n${"─".repeat(60)}\n${note.trim()}\n${"─".repeat(60)}` : "");
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  await request(rm, "PUT", `issues/${id}.json`, undefined, { issue: patch });
  const r = await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`);
  const i = r.issue;
  emit(i, () => `#${i.id} обновлена: статус ${i.status.name}, готовность ${i.done_ratio}%\n${issueUrl(rm, i.id)}`);
}

// ─────────────────── разбор зависших задач и закрытие ─────────────────

export type StaleCategory = "done-not-closed" | "on-hold" | "no-movement" | "active";

/** Статусы, означающие «работа сделана», но задача ещё не закрыта. */
const DONE_LIKE = ["выполнена", "принята", "resolved", "сдача работ", "решена", "готова"];
/** Статусы сознательной паузы. */
const HOLD_LIKE = ["отложена", "on hold", "приостановлена", "заморожена"];

export function monthsSince(date: string, now: Date): number {
  return Math.round((now.getTime() - new Date(date).getTime()) / 2_592_000_000);
}

/**
 * Категория зависшей задачи. Различать важно: «выполнена, но не закрыта» — это уборка,
 * а «новая без движения» — отказ от работы, и решать его должен человек.
 */
export function categorize(
  issue: { status: { name: string }; updated_on: string },
  now: Date,
  staleMonths: number,
): StaleCategory {
  const status = issue.status.name.toLowerCase();
  if (DONE_LIKE.some((s) => status.includes(s))) return "done-not-closed";
  if (HOLD_LIKE.some((s) => status.includes(s))) return "on-hold";
  return monthsSince(issue.updated_on, now) >= staleMonths ? "no-movement" : "active";
}

const CATEGORY_TITLES: Record<StaleCategory, string> = {
  "done-not-closed": "завершены, но не закрыты",
  "on-hold": "отложены",
  "no-movement": "без движения",
  active: "в работе",
};

async function loadStale(rm: Resolved, args: Args): Promise<{ issues: Issue[]; hidden: number }> {
  const query: Query = {
    status_id: await resolveStatusFilter(rm, str(args, "status") ?? "open"),
    sort: "updated_on:asc",
    limit: num(args, "limit") ?? 300,
  };
  if (bool(args, "mine") || !str(args, "assignee")) query.assigned_to_id = "me";
  const assignee = str(args, "assignee");
  if (assignee && assignee !== "me") query.assigned_to_id = assignee;
  if (assignee === "all") delete query.assigned_to_id;
  const project = str(args, "project");
  if (project) query.project_id = await resolveProjectKey(rm, project);

  const issues = await fetchAll<Issue>(rm, "issues.json", "issues", query, num(args, "limit") ?? 300);
  return splitByProjectState(rm, issues, bool(args, "include-closed-projects")).then((r) => ({
    issues: r.visible,
    hidden: r.hidden,
  }));
}

async function cmdStale(rm: Resolved, args: Args): Promise<void> {
  const now = new Date(str(args, "now") ?? new Date().toISOString());
  const staleMonths = num(args, "months") ?? 6;
  const size = num(args, "size") ?? 10;
  const page = num(args, "page") ?? 1;
  const wanted = str(args, "category");

  const { issues, hidden } = await loadStale(rm, args);
  const enriched = issues
    .map((i) => ({ issue: i, category: categorize(i, now, staleMonths), age: monthsSince(i.updated_on, now) }))
    .filter((x) => x.category !== "active")
    .filter((x) => !wanted || wanted === "all" || x.category.startsWith(wanted));

  if (bool(args, "summary")) {
    const byCategory = new Map<StaleCategory, number>();
    const byProject = new Map<string, number>();
    for (const x of enriched) {
      byCategory.set(x.category, (byCategory.get(x.category) ?? 0) + 1);
      byProject.set(x.issue.project.name, (byProject.get(x.issue.project.name) ?? 0) + 1);
    }
    emit({ instance: rm.name, total: enriched.length, hidden, byCategory: [...byCategory], byProject: [...byProject] }, () =>
      `ЗАВИСШИЕ ЗАДАЧИ · инстанс ${rm.name} · всего ${enriched.length}` +
        (hidden ? `, скрыто в закрытых проектах ${hidden}` : "") +
        "\n\n" +
        table([
          ["КАТЕГОРИЯ", "ЗАДАЧ"],
          ...[...byCategory].map(([c, n]) => [CATEGORY_TITLES[c], String(n)]),
        ]) +
        "\n\nПО ПРОЕКТАМ\n" +
        table([
          ["ПРОЕКТ", "ЗАДАЧ"],
          ...[...byProject].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => [clip(p, 30), String(n)]),
        ]),
    );
    return;
  }

  const totalPages = Math.max(1, Math.ceil(enriched.length / size));
  const slice = enriched.slice((page - 1) * size, page * size);

  emit(
    { instance: rm.name, page, totalPages, total: enriched.length, hidden, issues: slice },
    () =>
      `ПАЧКА ${page} из ${totalPages} · к разбору ${enriched.length} задач` +
      (hidden ? ` · в закрытых проектах пропущено ${hidden}` : "") +
      "\n\n" +
      slice
        .map(({ issue: i, category, age }, index) => {
          const number = (page - 1) * size + index + 1;
          const description = clip(i.description ?? "", 200);
          return (
            `${String(number).padStart(3)}. #${i.id} — ${i.subject}\n` +
            `     ${i.project.name} · ${i.status.name} · готовность ${i.done_ratio}% · ` +
            `списано ${Math.round(i.spent_hours ?? 0)}ч` +
            (i.estimated_hours ? ` из ${Math.round(i.estimated_hours)}ч` : "") +
            `\n     ${CATEGORY_TITLES[category]} · без движения ${age} мес. · ${issueUrl(rm, i.id)}` +
            (description ? `\n     ${description}` : "\n     (описания нет)")
          );
        })
        .join("\n\n") +
      (page < totalPages ? `\n\nСледующая пачка: --page ${page + 1}` : "\n\nЭто последняя пачка."),
  );
}

/** Статус, которым закрывают задачи на этом инстансе. */
async function closingStatus(rm: Resolved, preferred: string | undefined): Promise<IdName> {
  const list = await statuses(rm);
  if (preferred) return matchByName(list, preferred, "Статус");
  const byName = list.find((s) => ["закрыта", "closed", "закрыт"].includes(s.name.toLowerCase()));
  if (byName) return byName;
  throw new UserError(
    `Не удалось определить статус закрытия. Укажите его явно: --status "<имя>". Доступны: ${list
      .map((s) => s.name)
      .join(", ")}`,
  );
}

async function cmdClose(rm: Resolved, args: Args): Promise<void> {
  const ids = args.positional
    .flatMap((token) => token.split(","))
    .map((token) => Number(token.replace("#", "").trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw new UserError("Укажите номера задач: close 123 456 --note-file note.html --yes");

  const noteFile = str(args, "note-file");
  const note = noteFile ? await Bun.file(noteFile).text() : str(args, "note");
  if (!note?.trim()) {
    throw new UserError(
      "Нужен комментарий: закрытие без объяснения оставляет читателя в недоумении. --note-file <файл> или --note \"…\"",
    );
  }
  checkOutgoing({ комментарий: note }, args);

  const status = await closingStatus(rm, str(args, "status"));
  const loaded = await mapLimit(ids, 4, async (id) => {
    try {
      return (
        await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`, { include: "allowed_statuses" })
      ).issue;
    } catch {
      return null;
    }
  });
  const found = loaded.filter((i): i is Issue => i !== null);
  const missing = ids.filter((id) => !found.some((i) => i.id === id));

  const active = await activeProjectIds(rm);
  const closable = found.filter((i) => active.has(i.project.id));
  const locked = found.filter((i) => !active.has(i.project.id));

  const preview =
    `ЗАКРЫТИЕ ЗАДАЧ · инстанс ${rm.name} · статус «${status.name}»\n` +
    table([
      ["ЗАДАЧА", "ПРОЕКТ", "СТАТУС СЕЙЧАС", "ТЕМА"],
      ...closable.map((i) => [`#${i.id}`, clip(i.project.name, 20), clip(i.status.name, 14), clip(i.subject, 50)]),
    ]) +
    (locked.length
      ? `\n\nНЕ БУДУТ ЗАКРЫТЫ — проект закрыт, задачи доступны только для чтения:\n` +
        locked.map((i) => `  #${i.id} — ${clip(i.project.name, 24)} — ${clip(i.subject, 50)}`).join("\n")
      : "") +
    (missing.length ? `\n\nНЕ НАЙДЕНЫ: ${missing.map((id) => `#${id}`).join(", ")}` : "") +
    `\n\nКОММЕНТАРИЙ (уйдёт в каждую задачу, участники получат уведомление):\n${"─".repeat(60)}\n${note.trim()}\n${"─".repeat(60)}`;

  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  /**
   * Redmine проверяет все поля задачи, а не только изменяемые. Если категорию или версию
   * удалили из проекта, задача перестаёт сохраняться целиком — и закрыть её нельзя,
   * пока битое значение не сброшено.
   */
  const STALE_FIELDS: { probe: RegExp; field: string; label: string }[] = [
    { probe: /категори|category/i, field: "category_id", label: "категория" },
    { probe: /верси|version/i, field: "fixed_version_id", label: "версия" },
  ];

  const closed: number[] = [];
  const cleared: { id: number; fields: string[] }[] = [];
  const failed: { id: number; error: string }[] = [];

  /**
   * Redmine молча игнорирует переход, запрещённый рабочим процессом: отвечает 200,
   * сохраняет комментарий и оставляет прежний статус. Поэтому сверяем результат по факту,
   * а до записи смотрим список разрешённых переходов.
   */
  const currentStatus = async (id: number): Promise<string> =>
    (await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`)).issue.status.name;

  for (const issue of closable) {
    const allowed = issue.allowed_statuses;
    if (allowed && allowed.length > 0 && !allowed.some((s) => s.id === status.id)) {
      const closers = (await statuses(rm)).filter((s) => s.is_closed).map((s) => s.name);
      const possible = allowed.filter((s) => closers.includes(s.name)).map((s) => s.name);
      failed.push({
        id: issue.id,
        error:
          `рабочий процесс не разрешает переход «${issue.status.name}» → «${status.name}» для вашей роли.\n` +
          `      закрывающие статусы, доступные этой задаче: ${possible.join(", ") || "нет ни одного"}` +
          (possible.length > 0 ? ` — укажите явно: --status "${possible[0]}"` : " — потребуется администратор Redmine"),
      });
      continue;
    }

    const payload: Record<string, unknown> = { status_id: status.id, notes: note };
    try {
      await request(rm, "PUT", `issues/${issue.id}.json`, undefined, { issue: payload });
      const now = await currentStatus(issue.id);
      if (now.toLowerCase() !== status.name.toLowerCase()) {
        failed.push({
          id: issue.id,
          error: `Redmine принял запрос, но статус остался «${now}»: переход запрещён рабочим процессом (комментарий сохранён).`,
        });
        continue;
      }
      closed.push(issue.id);
      continue;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const broken = STALE_FIELDS.filter((f) => f.probe.test(message));
      if (broken.length === 0 || !bool(args, "clear-invalid")) {
        failed.push({
          id: issue.id,
          error:
            broken.length > 0
              ? `${message}\n      поле «${broken.map((b) => b.label).join(", ")}» ссылается на значение, ` +
                `удалённое из проекта; сбросить его при закрытии — флаг --clear-invalid`
              : message,
        });
        continue;
      }
      for (const f of broken) payload[f.field] = "";
      try {
        await request(rm, "PUT", `issues/${issue.id}.json`, undefined, { issue: payload });
        const now = await currentStatus(issue.id);
        if (now.toLowerCase() !== status.name.toLowerCase()) {
          failed.push({ id: issue.id, error: `статус остался «${now}»: переход запрещён рабочим процессом.` });
          continue;
        }
        closed.push(issue.id);
        cleared.push({ id: issue.id, fields: broken.map((b) => b.label) });
      } catch (retry) {
        failed.push({ id: issue.id, error: retry instanceof Error ? retry.message : String(retry) });
      }
    }
  }

  emit({ closed, cleared, failed, locked: locked.map((i) => i.id), missing }, () =>
    `Закрыто: ${closed.length} из ${ids.length} (${closed.map((id) => `#${id}`).join(", ") || "—"})` +
      (cleared.length
        ? `\nСброшены недействительные поля: ${cleared.map((c) => `#${c.id} (${c.fields.join(", ")})`).join(", ")}`
        : "") +
      (locked.length ? `\nПропущено в закрытых проектах: ${locked.map((i) => `#${i.id}`).join(", ")}` : "") +
      (missing.length ? `\nНе найдены: ${missing.map((id) => `#${id}`).join(", ")}` : "") +
      (failed.length ? `\nОшибки:\n${failed.map((f) => `  #${f.id}: ${f.error}`).join("\n")}` : ""),
  );
  if (failed.length) process.exitCode = 1;
}

// ───────────────────────── дерево задач ───────────────────────────────

type TreeNode = { issue: Issue; children: TreeNode[] };

async function loadTree(rm: Resolved, rootId: number): Promise<TreeNode> {
  const root = (await request<{ issue: Issue }>(rm, "GET", `issues/${rootId}.json`)).issue;
  const build = async (node: Issue, depth: number): Promise<TreeNode> => {
    if (depth > 4) return { issue: node, children: [] };
    const kids = await fetchAll<Issue>(rm, "issues.json", "issues", { parent_id: node.id, status_id: "*" }, 100);
    const children = await mapLimit(kids, 4, (k) => build(k, depth + 1));
    return { issue: node, children };
  };
  return build(root, 0);
}

type TreeTotals = { estimated: number; spent: number; done: number; count: number; closedLike: number };

function sumTree(node: TreeNode): TreeTotals {
  const self: TreeTotals = {
    estimated: node.issue.estimated_hours ?? 0,
    spent: node.issue.spent_hours ?? 0,
    done: node.issue.done_ratio,
    count: 1,
    closedLike: node.issue.done_ratio === 100 ? 1 : 0,
  };
  for (const child of node.children) {
    const sub = sumTree(child);
    self.estimated += sub.estimated;
    self.spent += sub.spent;
    self.count += sub.count;
    self.closedLike += sub.closedLike;
  }
  return self;
}

/** Взвешенная готовность: по оценкам, а при их отсутствии — по числу подзадач. */
function weightedDone(node: TreeNode): number {
  const leaves: Issue[] = [];
  const walk = (n: TreeNode): void => {
    if (n.children.length === 0) leaves.push(n.issue);
    else n.children.forEach(walk);
  };
  node.children.forEach(walk);
  if (leaves.length === 0) return node.issue.done_ratio;
  const totalWeight = leaves.reduce((s, i) => s + (i.estimated_hours ?? 0), 0);
  if (totalWeight > 0) {
    return Math.round(leaves.reduce((s, i) => s + (i.estimated_hours ?? 0) * i.done_ratio, 0) / totalWeight);
  }
  return Math.round(leaves.reduce((s, i) => s + i.done_ratio, 0) / leaves.length);
}

async function cmdTree(rm: Resolved, args: Args): Promise<void> {
  const raw = args.positional[0] ?? required(args, "issue");
  const rootId = Number(raw.replace("#", ""));
  if (!Number.isInteger(rootId)) throw new UserError("Укажите номер задачи: redmine.ts tree 25127");
  const tree = await loadTree(rm, rootId);
  const totals = sumTree(tree);
  const computedDone = weightedDone(tree);

  const rows: string[][] = [];
  const walk = (node: TreeNode, depth: number): void => {
    const i = node.issue;
    rows.push([
      `${"  ".repeat(depth)}${depth > 0 ? "└ " : ""}#${i.id}`,
      clip(i.status.name, 14),
      `${i.done_ratio}%`,
      i.estimated_hours != null ? h(i.estimated_hours) : "—",
      i.spent_hours != null ? h(i.spent_hours) : "—",
      i.due_date ?? "—",
      clip(i.subject, 52 - depth * 2),
    ]);
    node.children
      .slice()
      .sort((a, b) => (a.issue.due_date ?? "9999").localeCompare(b.issue.due_date ?? "9999") || a.issue.id - b.issue.id)
      .forEach((c) => walk(c, depth + 1));
  };
  walk(tree, 0);

  emit({ root: rootId, totals: { ...totals, computedDone }, tree }, () => {
    const root = tree.issue;
    const overrun = totals.estimated > 0 ? Math.round((totals.spent / totals.estimated) * 100) : null;
    return (
      `${table([["ЗАДАЧА", "СТАТУС", "ГОТОВ", "ОЦЕНКА", "СПИСАНО", "СРОК", "ТЕМА"], ...rows])}\n\n` +
      `Дерево #${root.id}: ${totals.count - 1} подзадач, закрыто по готовности ${totals.closedLike}/${totals.count}.\n` +
      (root.total_estimated_hours != null
        ? `По данным Redmine: оценка ${h(root.total_estimated_hours)}, списано ${h(root.total_spent_hours ?? 0)}.\n`
        : "") +
      `Оценка ${h(totals.estimated)} · списано ${h(totals.spent)}` +
      (overrun !== null ? ` (${overrun}% от оценки)` : "") +
      ` · готовность по весам ${computedDone}%, в карточке родителя ${root.done_ratio}%.\n` +
      `${issueUrl(rm, root.id)}`
    );
  });
}

type TreePlan = {
  project?: string;
  tracker?: string;
  assignee?: string;
  parent: {
    subject: string;
    description?: string;
    descriptionFile?: string;
    tracker?: string;
    priority?: string;
    start?: string;
    due?: string;
    estimated?: string | number;
  };
  children: {
    subject: string;
    description?: string;
    descriptionFile?: string;
    tracker?: string;
    priority?: string;
    assignee?: string;
    start?: string;
    due?: string;
    estimated?: string | number;
  }[];
};

/** Операции с путями — платформенные по умолчанию; самопроверка подставляет win32 или posix явно. */
type PathApi = Pick<typeof import("node:path"), "dirname" | "isAbsolute" | "join">;
const NATIVE_PATH: PathApi = { dirname, isAbsolute, join };

/**
 * Каталог, от которого считаются `descriptionFile` плана. Прежняя регулярка «отрезать всё после
 * последнего слэша» на голом `plan.json` ничего не отрезала, каталогом становился сам файл,
 * и описания искались как `plan.json\parent.html`.
 */
export function planBaseDir(
  file: string | undefined,
  base: string | undefined,
  path: PathApi = NATIVE_PATH,
): string | undefined {
  if (base !== undefined && base !== "") return base;
  return file === undefined ? undefined : path.dirname(file);
}

/**
 * Путь к описанию из плана: абсолютный берётся как есть, относительный — от каталога плана.
 * Абсолютность определяет `isAbsolute`: проверка «есть двоеточие» путала диск Windows
 * с чем угодно, где двоеточие встретилось.
 */
export function planTextPath(base: string | undefined, file: string, path: PathApi = NATIVE_PATH): string {
  return base !== undefined && base !== "" && !path.isAbsolute(file) ? path.join(base, file) : file;
}

async function readPlanText(base: string | undefined, inline: string | undefined, file: string | undefined): Promise<string | undefined> {
  if (inline !== undefined) return inline;
  if (file === undefined) return undefined;
  return Bun.file(planTextPath(base, file)).text();
}

async function cmdCreateTree(rm: Resolved, args: Args): Promise<void> {
  const file = str(args, "file") ?? args.positional[0];
  const raw = file ? await Bun.file(file).text() : await new Response(Bun.stdin.stream()).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UserError("Ожидается JSON-план дерева (--file plan.json или stdin). Структура: {project, parent, children[]}.");
  }
  if (!isRecord(parsed)) throw new UserError("План должен быть объектом {project, parent, children}.");
  const plan = parsed as unknown as TreePlan;
  if (!isRecord(plan.parent) || !Array.isArray(plan.children)) {
    throw new UserError("В плане нужны поля parent (объект) и children (массив).");
  }
  const baseDir = planBaseDir(file, str(args, "base"));

  const project = str(args, "project") ?? plan.project ?? rm.defaultProject;
  if (!project) throw new UserError("Не задан проект: --project или поле project в плане.");
  const projectKey = await resolveProjectKey(rm, project);
  const me = await currentUser(rm);

  const build = async (
    node: TreePlan["parent"] | TreePlan["children"][number],
    fallbackTracker: string | undefined,
  ): Promise<{ payload: Record<string, unknown>; description?: string }> => {
    const description = await readPlanText(baseDir, node.description, node.descriptionFile);
    const payload: Record<string, unknown> = { project_id: projectKey, subject: node.subject };
    if (description) payload.description = description;
    const trackerName = node.tracker ?? fallbackTracker;
    if (trackerName) payload.tracker_id = matchByName(await trackers(rm), trackerName, "Трекер").id;
    if (node.priority) payload.priority_id = matchByName(await priorities(rm), node.priority, "Приоритет").id;
    const assignee = "assignee" in node ? node.assignee : undefined;
    const who = assignee ?? plan.assignee;
    if (who) payload.assigned_to_id = who === "me" ? me.id : await resolveAssignee(rm, who, projectKey);
    if (node.start) payload.start_date = parseDate(node.start);
    if (node.due) payload.due_date = parseDate(node.due);
    if (node.estimated !== undefined) payload.estimated_hours = round2(parseHours(String(node.estimated)));
    return { payload, description };
  };

  const parent = await build(plan.parent, plan.tracker);
  const children = await mapLimit(plan.children, 1, (c) => build(c, plan.tracker));

  const guardFields: Record<string, string | undefined> = {
    "тема родителя": plan.parent.subject,
    "описание родителя": parent.description,
  };
  children.forEach((c, i) => {
    guardFields[`тема подзадачи ${i + 1}`] = plan.children[i]!.subject;
    guardFields[`описание подзадачи ${i + 1}`] = c.description;
  });
  checkOutgoing(guardFields, args);

  const totalEstimate = children.reduce((s, c) => s + Number(c.payload.estimated_hours ?? 0), 0);
  const parts = [
    await previewIssuePayload(rm, parent.payload, plan.parent.subject, parent.description, "РОДИТЕЛЬСКАЯ ЗАДАЧА"),
  ];
  for (const [i, child] of children.entries()) {
    parts.push(
      await previewIssuePayload(
        rm,
        child.payload,
        plan.children[i]!.subject,
        child.description,
        `ПОДЗАДАЧА ${i + 1}/${children.length}`,
      ),
    );
  }
  parts.push(`ИТОГО: 1 родительская + ${children.length} подзадач, суммарная оценка ${h(totalEstimate)}.`);
  const preview = parts.join("\n\n");
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  const created: Issue[] = [];
  const parentIssue = (await request<{ issue: Issue }>(rm, "POST", "issues.json", undefined, { issue: parent.payload }))
    .issue;
  created.push(parentIssue);
  const failed: { subject: string; error: string }[] = [];
  for (const child of children) {
    try {
      const issue = (
        await request<{ issue: Issue }>(rm, "POST", "issues.json", undefined, {
          issue: { ...child.payload, parent_issue_id: parentIssue.id },
        })
      ).issue;
      created.push(issue);
    } catch (e) {
      failed.push({ subject: String(child.payload.subject), error: e instanceof Error ? e.message : String(e) });
    }
  }

  emit({ parent: parentIssue, children: created.slice(1), failed }, () => {
    const lines = [
      `Создано дерево #${parentIssue.id} — ${parentIssue.subject}`,
      issueUrl(rm, parentIssue.id),
      ...created.slice(1).map((i) => `  └ #${i.id} — ${i.subject}`),
    ];
    if (failed.length) lines.push("", `ОШИБКИ (${failed.length}):`, ...failed.map((f) => `  ${f.subject}: ${f.error}`));
    return lines.join("\n");
  });
  if (failed.length) process.exitCode = 1;
}

// ─────────────── репозитории и сбор сделанного по истории ─────────────

/** Находит привязку репозитория: по пути или по owner/repo из origin. */
async function findBinding(path: string): Promise<{ key: string; binding: RepoBinding } | null> {
  const cfg = await readConfigFile();
  if (!cfg?.repos) return null;
  const candidates = [normalizeRepoKey(path), normalizeRepoKey(await repoName(path))];
  for (const [key, binding] of Object.entries(cfg.repos)) {
    if (candidates.includes(normalizeRepoKey(key))) return { key, binding };
  }
  return null;
}

async function cmdRepos(args: Args): Promise<void> {
  const action = args.positional[0] ?? "list";
  const cfg = (await readConfigFile()) ?? { instances: {} };

  if (action === "list") {
    const rows = Object.entries(cfg.repos ?? {});
    emit({ repos: cfg.repos ?? {} }, () =>
      rows.length === 0
        ? `Репозитории не привязаны. Привязать текущий:\n  redmine.ts repos add --instance <профиль> --project <проект> --client "<организация>"`
        : table([
            ["РЕПОЗИТОРИЙ", "ИНСТАНС", "ПРОЕКТ", "ОРГАНИЗАЦИЯ", "ВИД ДЕЯТЕЛЬНОСТИ"],
            ...rows.map(([key, b]) => [key, b.instance ?? "—", b.project ?? "—", b.client ?? "—", b.activity ?? "—"]),
          ]),
    );
    return;
  }

  const path = resolve(str(args, "path") ?? args.positional[1] ?? ".");
  if (!(await isGitRepo(path))) throw new UserError(`${path} — не репозиторий git.`);
  const key = str(args, "key") ?? (await repoName(path));

  if (action === "remove" || action === "rm") {
    if (!cfg.repos?.[key]) throw new UserError(`Привязка "${key}" не найдена. Список: redmine.ts repos list`);
    delete cfg.repos[key];
    await writeConfigFile(cfg);
    emit({ removed: key }, () => `Привязка "${key}" удалена.`);
    return;
  }

  if (action !== "add" && action !== "set") {
    throw new UserError('Доступно: repos list | repos add [--path .] | repos remove --key <ключ>');
  }

  const binding: RepoBinding = {
    instance: str(args, "instance") ?? (await readConfigFile())?.default,
    project: str(args, "project"),
    client: str(args, "client"),
    activity: str(args, "activity"),
    tracker: str(args, "tracker"),
  };
  if (!binding.instance) throw new UserError("Укажите --instance <профиль>.");
  if (!binding.project) throw new UserError("Укажите --project <identifier проекта Redmine>.");

  cfg.repos = { ...(cfg.repos ?? {}), [key]: binding };
  await writeConfigFile(cfg);
  emit({ key, binding }, () =>
    `Репозиторий "${key}" привязан: ${binding.instance} / ${binding.project}` +
      (binding.client ? ` (${binding.client})` : "") +
      `\nСобрать сделанное: redmine.ts harvest --repo "${path}" --period week`,
  );
}

async function cmdHarvest(args: Args): Promise<void> {
  const path = resolve(str(args, "repo") ?? args.positional[0] ?? ".");
  if (!(await isGitRepo(path))) {
    throw new UserError(`${path} — не репозиторий git. Укажите путь: harvest --repo <путь>`);
  }

  const found = await findBinding(path);
  const binding: RepoBinding = {
    ...(found?.binding ?? {}),
    instance: str(args, "instance") ?? found?.binding.instance,
    project: str(args, "project") ?? found?.binding.project,
  };
  const rm = await resolveInstance(binding.instance);

  const [from, to] = parsePeriod(str(args, "period") ?? "week");
  const authorFlag = str(args, "author") ?? "me";
  const author = authorFlag === "all" ? null : authorFlag === "me" ? (await currentUser(rm)).mail ?? null : authorFlag;

  const result = await harvestRepo(path, binding, {
    from,
    to,
    author,
    gap: num(args, "gap") ?? 90,
    warmup: num(args, "warmup") ?? 30,
    min: num(args, "min") ?? 0.5,
  });

  if (result.commits.length === 0) {
    emit(result, () => `За ${from}..${to} коммитов${author ? ` автора ${author}` : ""} в ${result.repo} нет.`);
    return;
  }

  // Проверяем, существуют ли задачи, на которые ссылаются коммиты.
  const referenced = [...new Set(result.groups.map((g) => g.issue).filter((n): n is number => n !== null))];
  const known = new Map<number, Issue | null>();
  await mapLimit(referenced, 4, async (id) => {
    try {
      known.set(id, (await request<{ issue: Issue }>(rm, "GET", `issues/${id}.json`)).issue);
    } catch {
      known.set(id, null);
    }
  });

  const markup = rm.markup ?? "textile";
  const linked = result.groups.filter((g) => g.issue !== null && known.get(g.issue) !== null);
  const orphanRefs = result.groups.filter((g) => g.issue !== null && known.get(g.issue) === null);
  const fresh = result.groups.filter((g) => g.issue === null);

  const entries = linked.map((g) => ({
    issue: g.issue,
    hours: String(g.hours),
    comment: `${g.commits.length} коммитов: ${[...new Set(g.commits.map((c) => c.subject))].slice(0, 3).join("; ")}`,
    activity: binding.activity ?? rm.defaultActivity,
  }));

  const newIssues = fresh.map((g) => ({
    subject: g.title,
    description: draftDescription(g, markup === "markdown" ? "markdown" : markup === "html" ? "html" : "textile"),
    estimated: String(g.hours),
    hours: String(g.hours),
    commits: g.commits.map((c) => c.short),
  }));

  const outDir = str(args, "out");
  const written: string[] = [];
  if (outDir) {
    await Bun.write(join(outDir, "entries.json"), JSON.stringify(entries, null, 2));
    written.push(join(outDir, "entries.json"));
    for (const [i, issue] of newIssues.entries()) {
      const file = join(outDir, `issue-${i + 1}.html`);
      await Bun.write(file, issue.description);
      written.push(file);
    }
    await Bun.write(
      join(outDir, "plan.json"),
      JSON.stringify({ instance: rm.name, project: binding.project, entries, newIssues }, null, 2),
    );
    written.push(join(outDir, "plan.json"));
  }

  emit(
    { ...result, instance: rm.name, project: binding.project ?? null, entries, newIssues, written },
    () => {
      const lines = [
        `РЕПОЗИТОРИЙ ${result.repo} → ${rm.name}${binding.project ? ` / ${binding.project}` : " / проект не задан"}` +
          (binding.client ? ` · ${binding.client}` : ""),
        `Период ${from}..${to}${author ? `, автор ${author}` : ", все авторы"}`,
        `Коммитов ${result.commits.length}, сессий ${result.sessions.length}, черновая оценка ${h(result.totalHours)}`,
        "",
      ];

      if (linked.length) {
        lines.push("СПИСАТЬ В СУЩЕСТВУЮЩИЕ ЗАДАЧИ");
        lines.push(
          table([
            ["ЗАДАЧА", "ЧАСЫ", "КОММИТОВ", "ТЕМА ЗАДАЧИ"],
            ...linked.map((g) => [
              `#${g.issue}`,
              h(g.hours),
              String(g.commits.length),
              clip(known.get(g.issue!)?.subject ?? "", 50),
            ]),
          ]),
        );
        lines.push("");
      }

      if (fresh.length) {
        lines.push("ПРЕДЛОЖЕНИЕ: ЗАВЕСТИ ЗАДАЧИ");
        for (const [i, g] of fresh.entries()) {
          lines.push(
            `${i + 1}. ${g.title}\n   ${h(g.hours)} · ${g.commits.length} коммитов · +${g.insertions}/−${g.deletions} · ` +
              `${[...new Set(g.files.map((f) => f.split("/")[0]))].slice(0, 4).join(", ")}`,
          );
        }
        lines.push("");
      }

      if (orphanRefs.length) {
        lines.push(
          `Ссылки на задачи, которых нет в ${rm.name}: ${orphanRefs.map((g) => `#${g.issue}`).join(", ")} — ` +
            `возможно, это другой инстанс.`,
          "",
        );
      }

      if (written.length) lines.push(`Черновики записаны: ${written.join(", ")}`, "");
      lines.push(
        "Оценка часов — ЧЕРНОВИК по времени коммитов, а не факт. Проверьте цифры и тексты, прежде чем отправлять.",
      );
      if (!outDir) lines.push("Сохранить черновики для правки: добавьте --out <каталог>");
      return lines.join("\n");
    },
  );
}

// ───────────────────── проверка текста и разметка ─────────────────────

async function cmdScan(rm: Resolved | null, args: Args): Promise<void> {
  const file = str(args, "file");
  const text = file ? await Bun.file(file).text() : (str(args, "text") ?? args.positional.join(" "));
  if (!text.trim()) throw new UserError('Нечего проверять: --text "..." или --file <файл>.');
  const audience: Audience = str(args, "audience") === "internal" ? "internal" : "client";
  const findings = scanText(text, { audience });
  const blocked = findings.some((f) => f.severity === "block");
  emit({ audience, blocked, findings }, () =>
    findings.length === 0
      ? `Проверка пройдена (аудитория: ${audience === "client" ? "заказчик" : "внутренняя"}). Отправлять можно.`
      : `${blocked ? "ОТПРАВЛЯТЬ НЕЛЬЗЯ" : "Замечания"} (аудитория: ${audience === "client" ? "заказчик" : "внутренняя"}):\n` +
        formatFindings(findings),
  );
  if (blocked) process.exitCode = 2;
}

/** Определяет, какую разметку понимает инстанс: textile или markdown. */
async function cmdDetectMarkup(rm: Resolved, args: Args): Promise<void> {
  const project = str(args, "project");
  const query: Query = { status_id: "*", sort: "updated_on:desc", limit: 50 };
  if (project) query.project_id = await resolveProjectKey(rm, project);
  const issues = await fetchAll<Issue>(rm, "issues.json", "issues", query, 50);
  const texts = await mapLimit(issues.slice(0, 12), 4, async (i) => {
    const r = await request<{ issue: Issue }>(rm, "GET", `issues/${i.id}.json`);
    return r.issue.description ?? "";
  });

  let textile = 0;
  let markdown = 0;
  let html = 0;
  for (const t of texts) {
    if (/^h[1-6]\.\s/m.test(t) || /(?:^|\s)\*[^*\n]+\*(?:\s|$)/m.test(t) || /%\{color:/.test(t)) textile++;
    if (/^#{1,6}\s/m.test(t) || /\*\*[^*\n]+\*\*/.test(t) || /^[-*]\s+\S/m.test(t)) markdown++;
    if (/<(?:p|br|div|strong|ul|li)\b/i.test(t)) html++;
  }
  const verdict = html > textile && html >= markdown ? "html" : markdown > textile ? "markdown" : "textile";
  emit({ instance: rm.name, sampled: texts.length, votes: { textile, markdown, html }, verdict }, () =>
    `Инстанс ${rm.name}: по ${texts.length} описаниям — textile ${textile}, markdown ${markdown}, html ${html}.\n` +
      `Вывод: ${verdict}. Пропишите "markup": "${verdict}" в профиль ${CONFIG_PATH}, чтобы не гадать.`,
  );
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
  checkOutgoing({ комментарий: text }, args);

  const preview =
    `КОММЕНТАРИЙ К #${id} · инстанс ${rm.name}${patch.private_notes ? " · приватный" : " · видим заказчику"}\n` +
    `${issueUrl(rm, id)}\n${"─".repeat(60)}\n${text.trim()}\n${"─".repeat(60)}`;
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

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

/** Сумма часов по каждому календарному дню: ретроспективу читают по дням, а не по записям. */
export function dayTotals(entries: { date: string; hours: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.date, round2((out.get(e.date) ?? 0) + e.hours));
  return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Проверка правдоподобия перед отправкой: день длиннее суток не бывает, будущее не списывают.
 * Это предупреждение, а не запрет: бывают дежурства и переносы, решает человек.
 */
export function loadWarnings(
  entries: { date: string; hours: number }[],
  options: { limit?: number; today?: string } = {},
): string[] {
  const limit = options.limit ?? 12;
  const today = options.today ?? fmtDate(new Date());
  const out: string[] = [];
  for (const [date, hours] of dayTotals(entries)) {
    if (hours > limit) {
      out.push(
        `${date}: ${h(hours)} за один день — больше ${limit}. ` +
          `Если это период, а не день, разнесите списание по дням фактической работы.`,
      );
    }
    if (date > today) out.push(`${date}: дата в будущем (сегодня ${today}) — часы списываются задним числом, не вперёд.`);
  }
  return out;
}

/**
 * Сверка сумм до и после переразноса. Redmine хранит часы с потерей точности — 1,99 возвращается
 * как 1,98, — поэтому допуск растёт с числом записей, а не сравнивается «в ноль».
 */
export function reconcileHours(
  before: number,
  after: number,
  expectedDelta: number,
  entries: number,
): { ok: boolean; diff: number; tolerance: number } {
  const tolerance = round2(0.01 * Math.max(1, entries)) + 1e-9;
  const diff = round2(after - (before + expectedDelta));
  return { ok: Math.abs(diff) <= tolerance, diff, tolerance };
}

/** Сумма всех часов задачи — по всем авторам: для сверки «до» и «после». */
async function issueHours(rm: Resolved, issueId: number): Promise<number> {
  const entries = await fetchAll<TimeEntry>(rm, "time_entries.json", "time_entries", { issue_id: issueId }, 500);
  return round2(entries.reduce((sum, e) => sum + e.hours, 0));
}

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
  checkOutgoing({ комментарий: input.comment }, args);

  const target = payload.issue_id ? `#${payload.issue_id}` : `проект ${payload.project_id}`;
  const activityName = input.activityId
    ? ((await activities(rm)).find((a) => a.id === input.activityId)?.name ?? String(input.activityId))
    : "по умолчанию";
  const warnings = loadWarnings([{ date: String(payload.spent_on), hours: Number(payload.hours) }]);
  const preview =
    `СПИСАНИЕ ЧАСОВ · инстанс ${rm.name}\n` +
    table([
      ["Дата", String(payload.spent_on)],
      ["Цель", target],
      ["Часы", h(Number(payload.hours))],
      ["Вид деятельности", activityName],
      ["Комментарий", String(payload.comments || "—")],
    ]) +
    (warnings.length > 0 ? `\n\nПРОВЕРКА ПРАВДОПОДОБИЯ:\n${warnings.map((w) => `  ${w}`).join("\n")}` : "");
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

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
  checkOutgoing(
    Object.fromEntries(payloads.map((p, i) => [`запись ${i + 1}`, String(p.comments ?? "")])),
    args,
  );

  const byDay = dayTotals(payloads.map((p) => ({ date: String(p.spent_on), hours: Number(p.hours) })));
  const warnings = loadWarnings(payloads.map((p) => ({ date: String(p.spent_on), hours: Number(p.hours) })));
  const preview =
    `СПИСАНИЕ ЧАСОВ ПАЧКОЙ · инстанс ${rm.name} · ${payloads.length} записей, итого ${h(total)}\n` +
    table([
      ["ДАТА", "ЦЕЛЬ", "ЧАСЫ", "КОММЕНТАРИЙ"],
      ...payloads.map((p) => [
        String(p.spent_on),
        p.issue_id ? `#${p.issue_id}` : String(p.project_id),
        h(Number(p.hours)),
        clip(String(p.comments ?? ""), 60),
      ]),
    ]) +
    (byDay.size > 1
      ? `\n\nПО ДНЯМ: ${[...byDay].map(([d, hrs]) => `${d} — ${h(hrs)}`).join(", ")}`
      : `\n\nВсё списание приходится на один день (${[...byDay.keys()][0] ?? "—"}). ` +
        `Если работа шла несколько дней, разнесите её по дням: одна запись на период — огрубление.`) +
    (warnings.length > 0 ? `\n\nПРОВЕРКА ПРАВДОПОДОБИЯ:\n${warnings.map((w) => `  ${w}`).join("\n")}` : "");
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

  // Сверка «до и после» имеет смысл только по задачам: суммы проекта меняют и чужие записи.
  const targets = [...new Set(payloads.map((p) => p.issue_id).filter((id): id is number => typeof id === "number"))];
  const before = new Map<number, number>();
  for (const id of targets) before.set(id, await issueHours(rm, id));

  const created: TimeEntry[] = [];
  const failed: { index: number; error: string }[] = [];
  for (const [index, payload] of payloads.entries()) {
    try {
      created.push(await postEntry(rm, payload));
    } catch (e) {
      failed.push({ index, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Сумма по задаче должна сойтись: иначе часть часов легла не туда, и это видно сразу, а не через месяц.
  const audit: { issue: number; before: number; after: number; expected: number; diff: number; ok: boolean }[] = [];
  for (const id of targets) {
    const planned = round2(
      created.filter((e) => e.issue?.id === id).reduce((sum, e) => sum + e.hours, 0),
    );
    const after = await issueHours(rm, id);
    const wasBefore = before.get(id) ?? 0;
    const check = reconcileHours(wasBefore, after, planned, created.length);
    audit.push({ issue: id, before: wasBefore, after, expected: round2(wasBefore + planned), diff: check.diff, ok: check.ok });
  }

  emit({ created, failed, audit, totalHours: round2(created.reduce((s, e) => s + e.hours, 0)) }, () => {
    const lines = created.map((e) => describeEntry(rm, e));
    if (failed.length) {
      lines.push("", `ОШИБКИ (${failed.length}):`, ...failed.map((f) => `  запись #${f.index}: ${f.error}`));
    }
    lines.push("", `Итого записано: ${h(created.reduce((s, e) => s + e.hours, 0))} в ${created.length} записях.`);
    if (audit.length > 0) {
      lines.push(
        "",
        "СВЕРКА ПО ЗАДАЧАМ (было → стало):",
        ...audit.map(
          (a) =>
            `  #${a.issue}: ${h(a.before)} → ${h(a.after)} (ожидалось ${h(a.expected)})` +
            (a.ok ? "" : ` — РАСХОЖДЕНИЕ ${h(a.diff)}, проверьте записи задачи`),
        ),
      );
    }
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

// ───────────────────── ретроспективное заполнение ─────────────────────

/**
 * С чего начинается разговор о прошлом: где в проекте дыры. Команда только читает —
 * задачи без списаний, месяцы без часов, дни с нечеловеческой нагрузкой.
 */
async function cmdBackfillCheck(rm: Resolved, args: Args): Promise<void> {
  const projectArg = str(args, "project") ?? args.positional[0] ?? rm.defaultProject;
  if (!projectArg) throw new UserError("Нужен --project <identifier|часть названия>.");
  const project = await findProject(rm, projectArg);

  const issues = await fetchAll<Issue>(
    rm,
    "issues.json",
    "issues",
    { project_id: project.id, status_id: "*", subproject_id: "!*" },
    1000,
  );
  const explicitRange = str(args, "from") !== undefined || str(args, "to") !== undefined;
  const period = str(args, "period");
  const [pFrom, pTo] = period ? parsePeriod(period) : ["", ""];
  const earliest = issues.map((i) => i.created_on.slice(0, 10)).sort()[0];
  const today = fmtDate(new Date());
  const from = str(args, "from") ? parseDate(required(args, "from")) : period ? pFrom : (earliest ?? today);
  const to = str(args, "to") ? parseDate(required(args, "to")) : period ? pTo : today;

  const entries = await fetchAll<TimeEntry>(
    rm,
    "time_entries.json",
    "time_entries",
    { project_id: project.id, from, to },
    2000,
  );

  const hoursByIssue = new Map<number, number>();
  for (const e of entries) {
    if (!e.issue) continue;
    hoursByIssue.set(e.issue.id, round2((hoursByIssue.get(e.issue.id) ?? 0) + e.hours));
  }
  // Задача относится к периоду, если она в нём заведена или в нём же ещё двигалась.
  const inPeriod = issues.filter((i) => i.created_on.slice(0, 10) <= to && i.updated_on.slice(0, 10) >= from);
  const silent = inPeriod.filter((i) => !hoursByIssue.has(i.id) && (i.spent_hours ?? 0) === 0);

  const byMonth = new Map<string, number>();
  for (let d = new Date(`${from}T00:00:00`); fmtDate(d) <= to; d = shiftDays(d, 1)) {
    byMonth.set(fmtDate(d).slice(0, 7), byMonth.get(fmtDate(d).slice(0, 7)) ?? 0);
  }
  for (const e of entries) {
    const key = e.spent_on.slice(0, 7);
    if (byMonth.has(key)) byMonth.set(key, round2((byMonth.get(key) ?? 0) + e.hours));
  }
  const emptyMonths = [...byMonth].filter(([, hours]) => hours === 0).map(([month]) => month);

  const warnings = loadWarnings(entries.map((e) => ({ date: e.spent_on, hours: e.hours })), { today });
  const totalHours = round2(entries.reduce((s, e) => s + e.hours, 0));
  const workedDays = new Set(entries.map((e) => e.spent_on)).size;

  emit(
    { project: project.identifier, from, to, totalHours, issues: issues.length, silent: silent.map((i) => i.id), emptyMonths, warnings },
    () =>
      `ПРОБЕЛЫ ПО ПРОЕКТУ «${project.name}» (${project.identifier}) · инстанс ${rm.name}\n` +
      table([
        ["Период", `${from} .. ${to}`],
        ["Задач в проекте", `${issues.length} всего, из них в периоде ${inPeriod.length} (без подпроектов)`],
        ["Списано", `${h(totalHours)} в ${entries.length} записях, дней с часами ${workedDays}`],
        [
          "Задач без списаний",
          inPeriod.length === 0
            ? "в периоде задач нет"
            : silent.length > 0
              ? String(silent.length)
              : "нет — по каждой задаче периода есть часы",
        ],
        ["Месяцев без часов", emptyMonths.length > 0 ? emptyMonths.join(", ") : "нет"],
      ]) +
      (silent.length > 0
        ? `\n\nЗАДАЧИ БЕЗ СПИСАНИЙ (${silent.length}, показаны первые 15):\n` +
          table(
            silent
              .slice(0, 15)
              .map((i) => [`#${i.id}`, i.status.name, (i.start_date ?? i.created_on.slice(0, 10)), clip(i.subject, 60)]),
          )
        : "") +
      (warnings.length > 0 ? `\n\nПОДОЗРИТЕЛЬНАЯ НАГРУЗКА:\n${warnings.map((w) => `  ${w}`).join("\n")}` : "") +
      `\n\nЧем заполнять: готовые отчёты и история git (redmine.ts harvest).`,
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

  checkOutgoing({ комментарий: comment }, args);

  const preview =
    `ПРАВКА ЗАПИСИ ${id} · инстанс ${rm.name}\n` +
    table(Object.entries(patch).map(([k, v]) => [k, String(v)]));
  if (!requireConfirmation(args, preview, "та же команда с флагом --yes")) return;

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

ЗАПИСЬ ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ: команды log, batch, comment, create-issue, create-tree,
update-issue, edit, create-project, update-project, archive-project, relate, unrelate,
add-member, update-member, remove-member без --yes печатают полный предпросмотр
и ничего не отправляют.
Любой уходящий текст проверяется на компрометацию (секреты, ПДн, внутренние адреса,
самооговор). Запрет снимается только флагом --override-guard.
  scan --text "..."|--file f [--audience client|internal]   проверить текст отдельно

Настройка
  instances                         профили из конфига и их состояние
  whoami                            кто я на этом инстансе
  activities | statuses | trackers  виды деятельности / статусы / трекеры и приоритеты
  projects [строка] [--flat]        проекты деревом: родитель → подпроекты (--flat — плоским списком)

Проекты и подпроекты
  project-fields                    пользовательские поля проектов: номер, тип, обязательность, значения
  create-project --name "..." [--identifier <строка>] [--parent <identifier|id>]
                 [--description "..."|--description-file f] [--public|--private] [--inherit-members]
                 [--tracker <имя> ...] [--module <имя> ...] [--field "<имя|id>=<значение>" ...] [--yes]
        идентификатор без --identifier генерируется из названия транслитерацией и проверяется
        на занятость; без --public проект создаётся закрытым
  update-project <identifier|id> [--name "..."] [--description "..."|--description-file f]
                 [--parent <identifier|id>|none] [--public|--private] [--tracker <имя> ...]
                 [--module <имя> ...] [--field "<имя|id>=<значение>" ...] [--yes]
  archive-project <identifier|id> --yes | unarchive-project <identifier|id> --yes
        только для администратора Redmine; обычному ключу инстанс ответит отказом

Участники проекта
  members <проект>                  участники: пользователь или группа, роли, номер членства
  roles                             справочник ролей и что каждая даёт словами
  add-member <проект> --user <id|"Имя Фамилия"|me> --role <имя|id> [--role …] [--yes]
        имя ищется среди участников видимых проектов (и в /users.json, если ключ администраторский);
        неоднозначное или ненайденное имя — остановка со списком кандидатов;
        уже состоящего в проекте не добавляет — для него update-member
  update-member <членство> --role <имя|id> [--role …] [--yes]
        задаёт собственные роли целиком; унаследованные от группы или родителя остаются
  remove-member <членство> [--yes]  убрать из проекта: отдельное подтверждение, как у delete
        после записи участники перечитываются и сверяются с запрошенным

Что нового и сроки
  inbox [--since 2026-09-20|-3|12h] [--mark] [--watched] [--authored] [--include-own]
        новые задачи на мне, новые комментарии и изменения; --mark запоминает отметку «просмотрено»
  due [--days 14] [--all] [--project X] [--anyone]
        задачи на мне со сроками: просроченные, сегодня, ближайшие

Сделанное по истории git
  repos list | repos add [--path .] --instance <профиль> --project <проект> [--client "<организация>"]
              [--activity <вид>] [--tracker <трекер>] | repos remove --key <ключ>
  harvest [--repo <путь>] [--period week] [--author me|all|<почта>] [--gap 90] [--min 0.5] [--out <каталог>]
        коммиты за период → куда списать часы и какие задачи завести (черновик, требует правки)

Задачи
  issue <id> [--comments N]         карточка задачи с последними событиями
  issues [--subject текст] [--project X] [--status open|closed|имя] [--mine|--assignee me|id]
         [--watched] [--due-before дата] [--limit N] [--sort updated_on:desc]
         задачи закрытых проектов скрыты: они доступны только для чтения (--include-closed-projects)

Разбор зависших задач
  stale [--summary] [--page 1] [--size 10] [--months 6] [--category done|on-hold|no-movement]
        [--mine|--assignee all] [--project X]
        зависшие задачи пачками: категория, готовность, списанное время, срок молчания, описание
  close <id> [<id> …] (--note-file f | --note "…") [--status "Закрыта"] [--yes]
        закрыть пачкой с общим комментарием; задачи закрытых проектов пропускаются с пояснением
  search "фраза" [--project X]      полнотекстовый поиск
  create-issue --project X --subject "..." [--description "..."|--description-file f]
               [--tracker имя] [--priority имя] [--assignee me|id|имя] [--start дата] [--due дата]
               [--estimated 8] [--parent N] [--yes]
  create-tree --file plan.json [--project X] [--yes]
               родитель + подзадачи одной операцией; тексты описаний — из descriptionFile
  tree <id>                         дерево задачи с агрегатами оценок, списаний и готовности

Связи между задачами (только внутри одного инстанса)
  relations <id>                    связи задачи: тип, номер, тема и статус второй задачи
  relate <id> --to <id|профиль:id|адрес> --type <тип> [--delay N] [--yes]
        типы: relates duplicates duplicated blocks blocked precedes follows copied_to copied_from;
        русские синонимы: связана, дублирует, блокирует, заблокирована, предшествует, следует
        --delay только для precedes/follows; задача другого инстанса — не связь, а перекрёстная ссылка
  unrelate <id связи> [--yes]       удалить связь; номера связей видно в relations
  xref <id> [--instance <профиль>] [--markup html|textile|markdown]
        готовая строка со ссылкой на задачу — для вставки в текст на другом инстансе
  detect-markup [--project X]       какая разметка принята на инстансе (textile/markdown/html)
  comment <id> --text "..."|--text-file f [--private] [--dry-run]
  update-issue <id> [--status имя] [--done N] [--note текст] [--assignee me|id|имя] [--due дата] [--dry-run]

Трудозатраты
  log --issue N --hours 2.5 [--date today|YYYY-MM-DD|-1] [--comment "..."] [--activity имя] [--dry-run]
  batch [--file entries.json | stdin] [--dry-run]
        JSON-массив: [{"issue":1234,"hours":"1h30","date":"2026-09-21","comment":"...","activity":"Разработка"}]
  entries [--period week|last-week|month|last-month|YYYY-MM|A..B] [--from --to]
          [--user me|id|all] [--project X] [--issue N] [--group issue|date|project|activity|user]
  gaps [--period ...] [--target 8] [--weekends]      дни с недобором часов

Ретроспектива: заполнить прошлое
  backfill-check --project X [--period 2026-07..2026-09|--from --to]
        пробелы: задачи без списаний, месяцы без часов, дни с нечеловеческой нагрузкой
  edit <entryId> [--hours|--date|--comment|--activity|--issue] [--dry-run]
  delete <entryId> --yes

Форматы: часы 2 | 2.5 | 1h30 | 1:30 | 90m; даты YYYY-MM-DD | DD.MM[.YYYY] | today | yesterday | -3;
         периоды week | last-week | month | last-month | YYYY-MM | A..B (концы — даты или месяцы: 2026-07..2026-09).
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
  if (args.cmd === "scan" || args.cmd === "check") {
    await cmdScan(null, args);
    return;
  }
  if (args.cmd === "repos") {
    await cmdRepos(args);
    return;
  }
  if (args.cmd === "harvest") {
    await cmdHarvest(args);
    return;
  }

  const rm = await resolveInstance(str(args, "instance"));
  const handlers: Record<string, (rm: Resolved, a: Args) => Promise<void>> = {
    whoami: cmdWhoami,
    activities: cmdActivities,
    statuses: cmdStatuses,
    projects: cmdProjects,
    "project-fields": cmdProjectFields,
    "create-project": cmdCreateProject,
    "update-project": cmdUpdateProject,
    "archive-project": cmdArchiveProject,
    "unarchive-project": cmdArchiveProject,
    members: cmdMembers,
    roles: cmdRoles,
    "add-member": cmdAddMember,
    "update-member": cmdUpdateMember,
    "remove-member": cmdRemoveMember,
    issue: cmdIssue,
    issues: cmdIssues,
    search: cmdSearch,
    trackers: cmdTrackers,
    stale: cmdStale,
    cleanup: cmdStale,
    close: cmdClose,
    "create-issue": cmdCreateIssue,
    "create-tree": cmdCreateTree,
    tree: cmdTree,
    relations: cmdRelations,
    relate: cmdRelate,
    unrelate: cmdUnrelate,
    xref: cmdXref,
    "detect-markup": cmdDetectMarkup,
    comment: cmdComment,
    log: cmdLog,
    batch: cmdBatch,
    entries: cmdEntries,
    report: cmdEntries,
    gaps: cmdGaps,
    "backfill-check": cmdBackfillCheck,
    edit: cmdEdit,
    delete: cmdDelete,
    "update-issue": cmdUpdateIssue,
  };
  const handler = handlers[args.cmd];
  if (!handler) throw new UserError(`Неизвестная команда "${args.cmd}". Список команд: redmine.ts help`);
  await handler(rm, args);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof UserError) console.error(`Ошибка: ${error.message}`);
    else if (error instanceof ApiError) console.error(`Redmine API: ${error.message}`);
    else console.error(`Сбой: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Импорт модуля (тесты) не должен запускать CLI.
if (import.meta.main) await run();

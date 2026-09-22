/**
 * Сбор выполненной работы из истории git.
 *
 * Репозиторий привязывается к инстансу и проекту Redmine (секция "repos" в конфиге),
 * после чего коммиты за период превращаются в черновик: какие часы куда списать и
 * какие задачи завести на то, что делалось без задачи.
 *
 * Оценка времени — ЧЕРНОВИК по времени коммитов, а не факт. Пользователь правит её до отправки.
 */

export type RepoBinding = {
  /** Профиль инстанса из конфига. */
  instance?: string;
  /** Проект Redmine: identifier, id или часть названия. */
  project?: string;
  /** Клиент или организация — для человекочитаемых сводок. */
  client?: string;
  /** Вид деятельности по умолчанию для списаний из этого репозитория. */
  activity?: string;
  /** Трекер для создаваемых задач. */
  tracker?: string;
};

export type Commit = {
  hash: string;
  short: string;
  date: string;
  author: string;
  email: string;
  subject: string;
  body: string;
  files: string[];
  insertions: number;
  deletions: number;
  issues: number[];
};

export type Session = { start: string; end: string; hours: number; commits: Commit[] };

export type Group = {
  key: string;
  issue: number | null;
  title: string;
  commits: Commit[];
  files: string[];
  hours: number;
  insertions: number;
  deletions: number;
};

export type HarvestResult = {
  repo: string;
  binding: RepoBinding;
  from: string;
  to: string;
  author: string;
  commits: Commit[];
  sessions: Session[];
  groups: Group[];
  totalHours: number;
};

const ISSUE_REF = /#(\d{2,7})\b/g;
const CONVENTIONAL = /^(?:feat|fix|refactor|perf|docs|test|chore|build|ci|style)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

async function git(repo: string, argv: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${argv.slice(0, 2).join(" ")} → ${err.trim() || `код ${code}`}`);
  return out;
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** Имя репозитория: по origin, иначе по каталогу. */
export async function repoName(path: string): Promise<string> {
  try {
    const url = (await git(path, ["remote", "get-url", "origin"])).trim();
    const match = url.match(/([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  } catch {
    /* без origin — падать незачем */
  }
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

const SEP = "\u0001";
const REC = "\u0002";
/** Конец заголовочной части записи: после него git печатает numstat. */
const END = "\u0003";

export async function readCommits(repo: string, from: string, to: string, author: string | null): Promise<Commit[]> {
  // REC стоит в начале записи, END — после многострочного тела: иначе numstat
  // предыдущего коммита попадает в начало следующей записи.
  const format = REC + ["%H", "%h", "%aI", "%an", "%ae", "%s", "%b"].join(SEP) + END;
  const argv = [
    "log",
    `--pretty=format:${format}`,
    "--numstat",
    `--since=${from} 00:00:00`,
    `--until=${to} 23:59:59`,
    "--no-merges",
  ];
  if (author) argv.push(`--author=${author}`);

  const raw = await git(repo, argv);
  const commits: Commit[] = [];

  for (const chunk of raw.split(REC)) {
    if (!chunk.trim()) continue;
    const endAt = chunk.indexOf(END);
    if (endAt === -1) continue;
    const parts = chunk.slice(0, endAt).split(SEP);
    if (parts.length < 6) continue;

    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    const body = (parts[6] ?? "").trim();

    for (const line of chunk.slice(endAt + END.length).split("\n")) {
      const stat = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!stat) continue;
      insertions += stat[1] === "-" ? 0 : Number(stat[1]);
      deletions += stat[2] === "-" ? 0 : Number(stat[2]);
      files.push(stat[3]!);
    }

    const text = `${parts[5] ?? ""}\n${body}`;
    const issues = [...text.matchAll(ISSUE_REF)].map((m) => Number(m[1])).filter((n) => n > 0);

    commits.push({
      hash: parts[0] ?? "",
      short: parts[1] ?? "",
      date: parts[2] ?? "",
      author: parts[3] ?? "",
      email: parts[4] ?? "",
      subject: parts[5] ?? "",
      body,
      files,
      insertions,
      deletions,
      issues: [...new Set(issues)],
    });
  }

  return commits.reverse(); // от старых к новым
}

/**
 * Рабочие сессии: коммиты, идущие плотно друг за другом, — это один заход.
 * Длительность = интервал между первым и последним коммитом плюс разогрев перед первым.
 */
export function buildSessions(commits: Commit[], gapMinutes: number, warmupMinutes: number, minHours: number): Session[] {
  const sorted = [...commits].sort((a, b) => a.date.localeCompare(b.date));
  const sessions: Session[] = [];
  let current: Commit[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const start = new Date(current[0]!.date).getTime();
    const end = new Date(current[current.length - 1]!.date).getTime();
    const span = (end - start) / 3_600_000 + warmupMinutes / 60;
    sessions.push({
      start: current[0]!.date,
      end: current[current.length - 1]!.date,
      hours: Math.max(minHours, Math.round(span * 4) / 4),
      commits: current,
    });
    current = [];
  };

  for (const commit of sorted) {
    if (current.length === 0) {
      current.push(commit);
      continue;
    }
    const prev = new Date(current[current.length - 1]!.date).getTime();
    const now = new Date(commit.date).getTime();
    if ((now - prev) / 60_000 > gapMinutes) flush();
    current.push(commit);
  }
  flush();
  return sessions;
}

/** Тема работы: номер задачи, иначе скоуп conventional commit, иначе общий каталог. */
function groupKey(commit: Commit): { key: string; title: string } {
  if (commit.issues.length > 0) return { key: `issue:${commit.issues[0]}`, title: `Задача #${commit.issues[0]}` };

  const conv = commit.subject.match(CONVENTIONAL);
  if (conv?.[1]) return { key: `scope:${conv[1].toLowerCase()}`, title: conv[1] };

  // Каталог верхнего уровня: файлы в корне репозитория считаем одной областью.
  const dirs = commit.files
    .map((f) => (f.includes("/") ? f.split("/")[0]! : "корень"))
    .filter((d) => !d.startsWith("."));
  if (dirs.length > 0) {
    const counts = new Map<string, number>();
    for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) return { key: `path:${top[0]}`, title: top[0] };
  }
  return { key: "other", title: "Прочее" };
}

/** Самое содержательное сообщение группы — кандидат в тему задачи. */
function suggestTitle(commits: Commit[]): string {
  const subjects = commits.map((c) => {
    const conv = c.subject.match(CONVENTIONAL);
    return (conv?.[2] ?? c.subject).trim();
  });
  const best = subjects.slice().sort((a, b) => b.length - a.length)[0] ?? "Работы по проекту";
  return best.charAt(0).toUpperCase() + best.slice(1);
}

/** Склонение существительного при числительном. */
export function plural(n: number, forms: [string, string, string]): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${forms[2]}`;
  if (mod10 === 1) return `${n} ${forms[0]}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${forms[1]}`;
  return `${n} ${forms[2]}`;
}

export function buildGroups(sessions: Session[]): Group[] {
  const map = new Map<string, Group>();

  for (const session of sessions) {
    // Часы сессии делим между темами пропорционально числу коммитов.
    const keys = session.commits.map((c) => groupKey(c));
    const perCommit = session.hours / session.commits.length;

    session.commits.forEach((commit, i) => {
      const { key, title } = keys[i]!;
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          issue: commit.issues[0] ?? null,
          title,
          commits: [],
          files: [],
          hours: 0,
          insertions: 0,
          deletions: 0,
        };
        map.set(key, group);
      }
      group.commits.push(commit);
      group.hours += perCommit;
      group.insertions += commit.insertions;
      group.deletions += commit.deletions;
      for (const f of commit.files) if (!group.files.includes(f)) group.files.push(f);
    });
  }

  const groups = [...map.values()].map((g) => ({
    ...g,
    hours: Math.max(0.25, Math.round(g.hours * 4) / 4),
    title: g.issue ? g.title : suggestTitle(g.commits),
  }));

  return groups.sort((a, b) => b.hours - a.hours);
}

/** Черновик описания задачи по коммитам — заготовка, которую дорабатывает аналитик. */
export function draftDescription(group: Group, markup: "html" | "textile" | "markdown"): string {
  const bullets = [...new Set(group.commits.map((c) => (c.subject.match(CONVENTIONAL)?.[2] ?? c.subject).trim()))];
  const areas = [...new Set(group.files.map((f) => f.split("/").slice(0, 2).join("/")))].slice(0, 8);
  const stat = `${plural(group.commits.length, ["коммит", "коммита", "коммитов"])}, +${group.insertions}/−${group.deletions} строк`;

  if (markup === "html") {
    return (
      `<p><strong>Что сделано.</strong> Черновик по истории репозитория (${stat}). Требует правки до отправки заказчику.</p>\n` +
      `<h3>Состав работ</h3>\n<ul>\n${bullets.map((b) => `  <li>${escapeHtml(b)}</li>`).join("\n")}\n</ul>\n` +
      (areas.length ? `<h3>Затронутые части</h3>\n<ul>\n${areas.map((a) => `  <li><code>${escapeHtml(a)}</code></li>`).join("\n")}\n</ul>\n` : "")
    );
  }
  if (markup === "markdown") {
    return (
      `**Что сделано.** Черновик по истории репозитория (${stat}).\n\n### Состав работ\n` +
      bullets.map((b) => `- ${b}`).join("\n") +
      (areas.length ? `\n\n### Затронутые части\n${areas.map((a) => `- \`${a}\``).join("\n")}` : "")
    );
  }
  return (
    `*Что сделано.* Черновик по истории репозитория (${stat}).\n\nh3. Состав работ\n\n` +
    bullets.map((b) => `* ${b}`).join("\n") +
    (areas.length ? `\n\nh3. Затронутые части\n\n${areas.map((a) => `* @${a}@`).join("\n")}` : "")
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function harvestRepo(
  repo: string,
  binding: RepoBinding,
  options: { from: string; to: string; author: string | null; gap: number; warmup: number; min: number },
): Promise<HarvestResult> {
  const commits = await readCommits(repo, options.from, options.to, options.author);
  const sessions = buildSessions(commits, options.gap, options.warmup, options.min);
  const groups = buildGroups(sessions);
  return {
    repo: await repoName(repo),
    binding,
    from: options.from,
    to: options.to,
    author: options.author ?? "все",
    commits,
    sessions,
    groups,
    totalHours: Math.round(sessions.reduce((s, x) => s + x.hours, 0) * 4) / 4,
  };
}

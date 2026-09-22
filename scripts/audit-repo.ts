#!/usr/bin/env bun
/**
 * Проверка репозитория перед публикацией: тот же сканер, что защищает сообщения в Redmine,
 * прогоняется по всем файлам под контролем версий.
 *
 * Запуск: bun scripts/audit-repo.ts [--history]
 *   --history — проверить ещё и содержимое всех коммитов (публикация раскрывает историю целиком).
 *
 * Код возврата 1, если найдено то, чего в публичном репозитории быть не должно.
 */

import { scanText, type Finding } from "./guard.ts";

const TEXT_EXTENSIONS = new Set([
  "ts", "js", "mjs", "cjs", "json", "md", "html", "htm", "css", "yml", "yaml", "txt", "sh", "toml", "gitignore",
  "gitattributes",
]);

/** Файлы с намеренными примерами: там «секреты» синтетические и нужны для тестов, правил и документации. */
const FIXTURE_FILES = new Set([
  "scripts/selftest.ts",
  "scripts/guard.ts",
  "scripts/audit-repo.ts",
  "references/safety.md",
  "references/editorial.md",
]);

/**
 * В исходном коде «pwd: value» — это имя поля, а не утечка, поэтому к коду применяются
 * только правила, распознающие сам секрет по форме, а не по соседнему слову.
 */
const CODE_EXTENSIONS = new Set(["ts", "js", "mjs", "cjs", "json", "yml", "yaml"]);
const STRONG_RULES = new Set([
  "private-key",
  "aws-key",
  "github-token",
  "slack-token",
  "llm-key",
  "jwt",
  "bearer",
  "conn-string",
  "onec-conn",
  "hex-secret",
  "card",
  "snils",
  "passport",
]);

/** Внутренняя инфраструктура компании не должна упоминаться в публичном репозитории. */
const INTERNAL_PATTERNS: { pattern: RegExp; title: string }[] = [
  { pattern: /redmine\.33solutions\.(?:ru|company)/gi, title: "внутренний адрес Redmine" },
  { pattern: /\b33solutions\.(?:ru|company)\b/gi, title: "внутренний домен компании" },
];
/** Ссылка на сам репозиторий — не утечка. */
const INTERNAL_ALLOW = /github\.com\/33solutions\//i;

async function sh(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${command.join(" ")} → код ${code}: ${err.trim()}`);
  }
  return out;
}

function isTextFile(path: string): boolean {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : path.replace(/^\./, "");
  return TEXT_EXTENSIONS.has(ext);
}

type Problem = { file: string; line: number | null; title: string; detail: string };

const problems: Problem[] = [];
const notes: string[] = [];

const files = (await sh(["git", "ls-files"])).split("\n").map((f) => f.trim()).filter(Boolean);
if (files.length === 0) throw new Error("git ls-files ничего не вернул — запускать из корня репозитория");

// ── 1. Файлы, которых не должно быть под контролем версий ─────────────
const FORBIDDEN = [/(^|\/)config\.json$/, /(^|\/)\.env/, /(^|\/)node_modules\//, /\.key$/, /\.pem$/, /\.pfx$/];
for (const file of files) {
  if (FORBIDDEN.some((re) => re.test(file))) {
    problems.push({ file, line: null, title: "файл не должен быть в репозитории", detail: file });
  }
}

// ── 2. Секреты в содержимом файлов ────────────────────────────────────
let scanned = 0;
for (const file of files) {
  if (!isTextFile(file)) {
    notes.push(`пропущен как бинарный: ${file}`);
    continue;
  }
  const text = await Bun.file(file).text();
  scanned++;

  if (!FIXTURE_FILES.has(file)) {
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const isCode = CODE_EXTENSIONS.has(ext);
    const findings: Finding[] = scanText(text, { audience: "internal" })
      .filter((f) => f.severity === "block")
      .filter((f) => !isCode || STRONG_RULES.has(f.rule));
    for (const f of findings) {
      problems.push({ file, line: f.line, title: f.title, detail: f.excerpt });
    }
  }

  for (const { pattern, title } of INTERNAL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20);
      if (INTERNAL_ALLOW.test(around)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      problems.push({ file, line, title, detail: m[0] });
    }
  }
}

// ── 3. История коммитов ───────────────────────────────────────────────
if (process.argv.includes("--history")) {
  // Фикстуры исключаем и из истории: их синтетические «секреты» добавлялись коммитами.
  const excludes = [...FIXTURE_FILES].map((f) => `:(exclude)${f}`);
  const diff = await sh(["git", "log", "-p", "--no-color", "--unified=0", "--", ".", ...excludes]);
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  // История — это в основном диффы кода и документации, поэтому только правила «по форме секрета».
  const findings = scanText(added, { audience: "internal" })
    .filter((f) => f.severity === "block")
    .filter((f) => STRONG_RULES.has(f.rule));
  for (const f of findings) {
    problems.push({ file: "история git", line: null, title: f.title, detail: f.excerpt });
  }
  const everAdded = (await sh(["git", "log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:"]))
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const file of new Set(everAdded)) {
    if (FORBIDDEN.some((re) => re.test(file))) {
      problems.push({ file, line: null, title: "файл присутствовал в истории", detail: file });
    }
  }
  notes.push(`история: просмотрено ${new Set(everAdded).size} когда-либо добавленных файлов`);
}

// ── итог ──────────────────────────────────────────────────────────────
console.log(`Файлов под контролем версий: ${files.length}, просмотрено как текст: ${scanned}`);
for (const n of notes) console.log(`  ${n}`);

if (problems.length === 0) {
  console.log("\nПубликовать можно: секретов и внутренних адресов не найдено.");
  process.exit(0);
}

console.error(`\nНайдено проблем: ${problems.length}`);
for (const p of problems) {
  console.error(`  ${p.file}${p.line ? `:${p.line}` : ""} — ${p.title}: ${p.detail}`);
}
process.exit(1);

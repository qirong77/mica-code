/**
 * `@` 文件补全的纯逻辑：触发判定、查询归一化、评分排序、标签高亮与插入文本。
 *
 * CLI（`mica-ui` 的输入框 + file-mention 插件）与桌面端输入框共用这一份，两端的候选、
 * 顺序和插入文本因此完全一致。这里只处理字符串；工作区扫描在 `search.ts`。
 */

/** 补全候选：`label` 是文件名（目录带尾部 `/`），`description` 是工作区相对路径。 */
export interface FileMentionItem {
  path: string;
  label?: string;
  description?: string;
  labelHighlights?: number[];
}

export interface RankedFileMention extends FileMentionItem {
  path: string;
  label: string;
  description: string;
  labelHighlights: number[];
  score: number;
  isDirectory: boolean;
}

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

export const MAX_WORKSPACE_FILES = 50_000;

// Kimi-code's getFuzzyFileSuggestions keeps only the top 20 scored candidates
// for `@` file mention (scored.slice(0, 20)). Keep the truncation aligned so
// `@doc` surfaces the most relevant docs/ + files instead of a wall of
// basename-only-substring matches (file_type_docusaurus.svg etc).
export const MAX_FILE_MENTION_RESULTS = 20;

const MENTION_TRIGGER = /@([^\s@]*)$/u;
// `@` 必须落在词首：文本开头、空白、开括号/引号，或一个非 ASCII 字符之后
// （`参考@src/a.ts` 也算词首，而 `mail@x.com` 不算）。
const MENTION_PREFIX = /[\s([{'"，。、；：！？（）【「《]/u;
const QUOTED_PATH = /[\s"]/u;

/**
 * 光标前是否正处在一个 `@` 提及里。
 *
 * 规则与输入框的 `/` 补全一致：`@` 在词首、且到光标之间没有空白或第二个 `@`。
 * `mail@x.com` 这类贴在词中间的 `@` 不触发。
 */
export function activeFileMention(
  text: string,
  caret?: number,
): { start: number; query: string } | null {
  const value = String(text ?? '');
  const end = clamp(caret, 0, value.length);
  const before = value.slice(0, end);
  const match = MENTION_TRIGGER.exec(before);
  if (!match) return null;
  const start = before.length - match[0].length;
  if (start > 0) {
    const previous = before.charAt(start - 1);
    if (!MENTION_PREFIX.test(previous) && previous.charCodeAt(0) < 128) return null;
  }
  return { start, query: match[1] ?? '' };
}

/** 路径含空白或引号时整条 JSON 化，避免插入后被拆成两个词。 */
export function mentionPath(path: string): string {
  const value = String(path ?? '');
  return QUOTED_PATH.test(value) ? JSON.stringify(value) : value;
}

/** `@` 提及的插入文本（尾部一个空格，方便继续输入）。 */
export function mentionText(path: string): string {
  return `@${mentionPath(path)} `;
}

export function normalizePathQuery(query: string): string {
  return query
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+/u, '')
    .replace(/\/{2,}/gu, '/')
    .toLocaleLowerCase();
}

export function isWorkspaceFile(path: string): boolean {
  return !path.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment));
}

/**
 * Mirrors kimi-code's `scoreCandidate`: base name beats path, within the base
 * name an exact match beats a prefix which beats a substring, and directories
 * get a small bonus so workspace folders surface ahead of files.
 */
export function scorePath(
  path: string,
  query: string,
  isDirectory: boolean,
): { score: number; basenameMatch: boolean } {
  const lowerQuery = query.toLowerCase();
  const lowerPath = path.toLowerCase();
  const lowerBase = basename(path).toLowerCase();
  let score = 0;
  let basenameMatch = false;
  if (lowerBase === lowerQuery) {
    score = 100;
    basenameMatch = true;
  } else if (lowerBase.startsWith(lowerQuery)) {
    score = 80;
    basenameMatch = true;
  } else if (lowerBase.includes(lowerQuery)) {
    score = 50;
    basenameMatch = true;
  } else if (lowerPath.includes(lowerQuery)) {
    score = 30;
  }
  if (isDirectory && score > 0) score += 10;
  return { score, basenameMatch };
}

/** Character indexes into `label` for the query substring, or [] when absent. */
export function computeLabelHighlights(label: string, query: string): number[] {
  const index = label.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return [];
  return Array.from({ length: query.length }, (_, offset) => index + offset);
}

/**
 * Rank every workspace file/directory against `query` using kimi-code's graded
 * substring scoring: exact basename > basename prefix > basename substring >
 * path substring. Higher score = better match, and directories outrank files
 * at equal score (so `@doc` puts the `docs/` entries first). Candidates that do
 * not contain the query anywhere are dropped, so `@doc` only surfaces
 * files/directories whose name or path actually holds "doc" — not unrelated
 * files whose full path merely contains the letters d-o-c out of order.
 */
export function rankWorkspaceFiles(files: string[], query: string): RankedFileMention[] {
  if (!query) {
    return files
      .toSorted(comparePaths)
      .map((path) => describePath(path))
      .filter((entry) => entry !== null)
      .map(({ path, label, description, isDirectory }) => ({
        path,
        label,
        description,
        labelHighlights: [],
        score: 0,
        isDirectory,
      }));
  }

  const results: RankedFileMention[] = [];
  for (const path of files) {
    const { score, basenameMatch } = scorePath(path, query, false);
    if (score <= 0) continue;
    results.push({
      path,
      label: basename(path),
      description: path,
      labelHighlights: basenameMatch ? computeLabelHighlights(basename(path), query) : [],
      score,
      isDirectory: false,
    });
  }
  for (const directory of collectDirectoryPaths(files)) {
    const { score, basenameMatch } = scorePath(directory, query, true);
    if (score <= 0) continue;
    const name = basename(directory);
    results.push({
      path: `${directory}/`,
      label: `${name}/`,
      description: directory,
      labelHighlights: basenameMatch ? computeLabelHighlights(name, query) : [],
      score,
      isDirectory: true,
    });
  }
  results.sort(compareRankedMentions);
  return results;
}

/** 候选排序：分数高的在前，同分时目录在前、路径短的在前。 */
export function compareRankedMentions(left: RankedFileMention, right: RankedFileMention): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return comparePaths(left.path, right.path);
}

/** `rankWorkspaceFiles` 的前 20 条，作为端上候选。 */
export function matchWorkspaceFiles(files: string[], query: string): FileMentionItem[] {
  return rankWorkspaceFiles(files, query)
    .slice(0, MAX_FILE_MENTION_RESULTS)
    .map(({ path, label, description, labelHighlights }) => ({
      path,
      label,
      description,
      labelHighlights,
    }));
}

/**
 * Every directory reachable from the workspace files, as relative paths. Used
 * to surface directory completions (e.g. `docs/`) ahead of path-only matches.
 */
export function collectDirectoryPaths(files: string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = dirname(file);
    while (directory && directory !== '.') {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return [...directories];
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * `git ls-files` 会把嵌套仓库/未跟踪目录报成带尾 `/` 的条目（`temp/pi/`），
 * 这类条目的 `basename` 是空串——按目录形态描述，名字为空时整条丢弃。
 */
function describePath(path: string): {
  path: string;
  label: string;
  description: string;
  isDirectory: boolean;
} | null {
  const isDirectory = path.endsWith('/');
  const clean = isDirectory ? path.slice(0, -1) : path;
  const name = basename(clean);
  if (!name) return null;
  return {
    path,
    label: isDirectory ? `${name}/` : name,
    description: clean,
    isDirectory,
  };
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function comparePaths(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function clamp(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, value as number));
}

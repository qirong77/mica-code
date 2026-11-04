import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expandHome, resolvePathRepoIdentity, type RepoIdentity } from './repo.js';

/**
 * 「本次任务的目标仓库」是会话跑起来之后才知道的，不是开窗时的那条路径。
 *
 * 真实用法里这两种情况都很常见：在 `mis` 里开会话，实际改的是 `sass`；在 `mica-code`
 * 里开会话，去修 `spring-cli`；从 melos 的 workdir 里开会话，真正的工作区根本不是 git
 * 仓库。只按 cwd 归项目记忆，这些会话写下的东西会落进一个「谁也不看」的文件里，
 * 而真正需要它的仓库那份永远是空的。
 *
 * 这里从工具调用里认出**实际被碰到的路径**，按信号强弱加权：
 * 写操作 > shell 的 `cd` / `cwd` > 读取。权重足够高的非 cwd 仓库会：
 *
 * - 被注入它的项目记忆（`contextScopes`）；
 * - 成为 `memory` 工具省略 `repo` 时的默认写入目标；
 * - 被整理器当作「这条事实属于谁」的候选。
 *
 * 上限是刻意的：一次会话真正在改的仓库通常就一两个，把六七个仓库的记忆都塞进
 * 提示词等于回到「全量注入」。
 */

export const MAX_TOUCHED_REPOS = 8;
/** 至少要这么强的信号才会被注入记忆：只是 `read_file` 看过一眼不算。 */
export const MIN_EXTRA_WEIGHT = 2;
/** 除 cwd 仓库外，最多再注入几个仓库的项目记忆。 */
export const MAX_EXTRA_REPOS = 2;

const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'edit_file', 'create_file', 'notebook_edit', 'patch']);
const SHELL_TOOLS = new Set(['run_shell']);
const READ_TOOLS = new Set([
  'read_file',
  'grep_search',
  'list_files',
  'read_image',
  'files:stat',
  'files:read',
  'background_tasks_read',
]);

const WRITE_WEIGHT = 3;
/** shell 里显式 `cd <目录>` 是很强的意向信号，仅次于直接写文件。 */
const SHELL_CD_WEIGHT = 2;
const READ_WEIGHT = 1;
/** 不认识插件工具时给最低权重：它的 params 里可能有路径，但语义未知。 */
const UNKNOWN_WEIGHT = 1;

/** 超过这个长度的参数不再做 JSON 解析（大 patch 正文可以是几百 KB）。 */
const MAX_JSON_SCAN_CHARS = 100_000;

export type TouchedRepo = {
  repo: RepoIdentity;
  weight: number;
  lastAt: number;
};

/**
 * 从一次工具调用里抽「可能属于某个仓库」的路径。
 *
 * 只认以 `/` 或 `~/` 开头的字符串：相对路径要看工具自己的语义（相对工作区还是相对
 * 某处配置），猜错比不认更糟。
 */
export function extractPathCandidates(toolName: string, args: string): string[] {
  if (!args) return [];
  const out = new Set<string>();

  // apply_patch 的参数是补丁正文而不是 JSON，路径写在 `*** Update File:` 这类行里。
  if (toolName === 'apply_patch' || args.includes('*** Begin Patch')) {
    collectPatchPaths(args, out);
    if (out.size > 0) return [...out];
  }

  if (SHELL_TOOLS.has(toolName)) {
    for (const match of args.matchAll(/(?:^|[\s"';&|(])cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/gm)) {
      addPath(out, match[1] ?? match[2] ?? match[3]);
    }
  }

  if (args.length <= MAX_JSON_SCAN_CHARS) {
    try {
      collectPaths(JSON.parse(args), out, 0);
    } catch {
      // 参数不是 JSON（自定义工具可能直接收一段文本）：按空白切开逐个试。
      for (const token of args.split(/[\s,;"'`]+/)) addPath(out, token);
    }
  }
  return [...out];
}

function collectPaths(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    // 每个字符串都试一次：路径可能作为数组项出现（`files: [...]`）。
    addPath(out, value);
    // 真实调用里补丁正文是 JSON 的一个字段，换行是 `\n` 转义——
    // 直接对原始参数跑行首锚定会一条都匹配不到，必须解析后再扫。
    if (value.includes('*** ')) collectPatchPaths(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectPaths(item, out, depth + 1);
  }
}

function addPath(out: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    // `src/app.ts:12:3` 这类「路径:行:列」只留路径本身。
    .replace(/:(\d+)(?::\d+)?$/, '')
    .replace(/[),.;]+$/, '');
  if (!cleaned) return;
  if (cleaned.includes('://')) return;
  if (cleaned.startsWith('~/')) {
    out.add(cleaned);
    return;
  }
  if (cleaned.startsWith('/') && cleaned.length > 1) out.add(cleaned);
}

function collectPatchPaths(text: string, out: Set<string>): void {
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) addPath(out, match[1]);
  for (const match of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) addPath(out, match[1]);
}

export function weightForTool(toolName: string): number {
  if (WRITE_TOOLS.has(toolName)) return WRITE_WEIGHT;
  if (SHELL_TOOLS.has(toolName)) return SHELL_CD_WEIGHT;
  if (READ_TOOLS.has(toolName)) return READ_WEIGHT;
  return UNKNOWN_WEIGHT;
}

/**
 * 按会话累积「碰过哪些仓库」。
 *
 * 键是**会话 id**而不是运行时 owner 对象：注入发生在 `prompt.section.render()` 里，
 * 那条路径拿不到 owner（也不需要）。按对象分桶会让「观察到的仓库」和「注入时查的
 * 仓库」变成两个桶，注入永远看不到刚碰过的目标仓库。
 *
 * 只活在进程内：它描述的是**这次执行**的轨迹，重启后模型照样可以显式传 `repo`。
 * 落盘反而会让用户几天后打开同一会话时看到一个过期的目标仓库。
 */
export class TouchedRepoIndex {
  private readonly sessions = new Map<string, Map<string, TouchedRepo>>();

  /** 记一次工具调用，返回这次识别到的仓库（没有就 null）。 */
  observe(sessionId: string, toolName: string, args: string): RepoIdentity | null {
    const paths = extractPathCandidates(toolName, args);
    if (paths.length === 0) return null;
    const baseWeight = weightForTool(toolName);
    // 同一次调用里的多个路径常常指向同一个仓库（`file_path` 与补丁正文各一份），
    // 按路径加权会让「读了一个文件」变成两次信号，把只读页面的仓库也注入进来。
    const touched = new Map<string, RepoIdentity>();
    for (const path of paths) {
      const repo = resolvePathRepoIdentity(expandHome(path));
      if (!repo) continue;
      // 家目录本身、以及写进 `~/.mica` 的记忆文件不该把「用户目录」变成项目。
      if (repo.root === homedir()) continue;
      touched.set(repo.slug, repo);
    }
    for (const repo of touched.values()) this.bump(sessionId, repo, baseWeight);
    return touched.values().next().value ?? null;
  }

  /** 按权重降序的全部已知仓库。 */
  list(sessionId: string): TouchedRepo[] {
    const entries = this.sessions.get(sessionId);
    if (!entries) return [];
    return [...entries.values()]
      .sort((left, right) => right.weight - left.weight || right.lastAt - left.lastAt)
      .map((entry) => ({ ...entry }));
  }

  /** 本次任务最可能的目标仓库。 */
  primary(sessionId: string): RepoIdentity | null {
    return this.list(sessionId)[0]?.repo ?? null;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  private bump(sessionId: string, repo: RepoIdentity, weight: number): void {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.sessions.set(sessionId, entries);
    }
    const current = entries.get(repo.slug);
    entries.set(repo.slug, {
      repo,
      weight: (current?.weight ?? 0) + weight,
      lastAt: Date.now(),
    });
    if (entries.size > MAX_TOUCHED_REPOS) this.prune(entries);
  }

  /** 超出上限时先丢权重最低的，同权重丢最久没碰的。 */
  private prune(entries: Map<string, TouchedRepo>): void {
    const ordered = [...entries.entries()].sort(
      (left, right) => right[1].weight - left[1].weight || right[1].lastAt - left[1].lastAt,
    );
    for (const [slug] of ordered.slice(MAX_TOUCHED_REPOS)) entries.delete(slug);
  }
}

/** 把「本次任务碰到的仓库」压缩成注入时要用的那几个。 */
export function injectionRepos(touched: TouchedRepo[], cwdRepo: RepoIdentity | null): RepoIdentity[] {
  return touched
    .filter((entry) => entry.weight >= MIN_EXTRA_WEIGHT)
    .map((entry) => entry.repo)
    .filter((repo) => repo.slug !== cwdRepo?.slug)
    .slice(0, MAX_EXTRA_REPOS);
}

export function absolutePath(path: string): string {
  return resolve(expandHome(path));
}

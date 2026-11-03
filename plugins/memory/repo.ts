import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * 仓库身份：项目记忆按「仓库」归档，而不是按会话当时的 cwd。
 *
 * 用 cwd 归档会在真实用法里裂成好几份：同一个仓库从根目录开、从 `apps/desktop` 开、
 * 在临时 worktree 里开，各写一份互不可见的记忆，而它们讲的是同一套约定。
 *
 * 这里全部用文件系统读取，**不 spawn git**：本机全局 git 配置挂了 trace2 钩子，
 * 一条 git 命令 150–600ms，而这个函数在会话第一次渲染提示词时就会跑。
 */

export type RepoIdentity = {
  /** 稳定的文件名 slug：`<仓库名>-<key 的哈希>`。 */
  slug: string;
  /** 仓库根（worktree 自己的根，不是 common dir）。 */
  root: string;
  /** 共享身份：有 origin 时用归一化后的远端地址，否则用 common dir 的真实路径。 */
  key: string;
  /** 给人看的名字。 */
  name: string;
  /** 归一化后的 origin 地址；没有远端时为 null。 */
  remote: string | null;
  /**
   * `git` = 按仓库认（子目录、worktree、别的 clone 都归到同一份）；
   * `dir` = 没有 git 的项目目录，只认这一层目录自己。
   */
  source: 'git' | 'dir';
};

/** 进程内缓存：同一个目录在一次会话里被问很多次（注入、工具、整理器）。 */
const cache = new Map<string, RepoIdentity | null>();

export function clearRepoIdentityCache(): void {
  cache.clear();
}

export function resolveRepoIdentity(cwd: string | null | undefined): RepoIdentity | null {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (!trimmed) return null;
  const start = safeRealpath(resolve(trimmed));
  if (!start) return null;
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  const resolved = detect(start);
  cache.set(start, resolved);
  return resolved;
}

function detect(start: string): RepoIdentity | null {
  const root = findRepoRoot(start);
  if (!root) return detectLooseProject(start);
  const gitEntry = join(root, '.git');

  let commonDir: string;
  try {
    commonDir = resolveCommonDir(gitEntry);
  } catch {
    return null;
  }

  const remote = readOriginUrl(commonDir);
  const key = remote ?? safeRealpath(commonDir) ?? commonDir;
  // 名字取远端仓库名而不是本地目录名：同一个仓库的两个 clone 目录名可能不同，
  // 用目录名会让它们落进两个 slug，记忆又裂开了。
  const name = (remote ? remote.split('/').filter(Boolean).pop() : '') || basename(root) || 'repo';
  return {
    slug: `${sanitize(name)}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`,
    root,
    key,
    name,
    remote,
    source: 'git',
  };
}

/**
 * 没有 git 的项目目录（部署产物、脚本仓库、外部服务的本地镜像）也有自己的约定。
 *
 * 判据是**目录自己能看出来的项目标记**，而不是「随便哪个目录」：
 * 从家目录、下载目录开的一次性会话不该攒出一份项目记忆——那会重演按 cwd
 * 分裂记忆的老问题。这里也**不向上找**：没有 git 时「这个项目」就是当前这一层。
 */
const PROJECT_MARKERS = [
  'package.json',
  'AGENTS.md',
  'CLAUDE.md',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'docker-compose.yml',
  'deploy.sh',
];

function detectLooseProject(start: string): RepoIdentity | null {
  if (!PROJECT_MARKERS.some((marker) => existsSync(join(start, marker)))) return null;
  const name = basename(start) || 'project';
  return {
    slug: `${sanitize(name)}-${createHash('sha1').update(start).digest('hex').slice(0, 8)}`,
    root: start,
    key: start,
    name,
    remote: null,
    source: 'dir',
  };
}

/** 从 cwd 往上找含 `.git` 的目录；找不到返回 null（不在仓库里）。 */
function findRepoRoot(start: string): string | null {
  let current = start;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * worktree / submodule 的 `.git` 是一个文本文件，内容 `gitdir: <路径>`；
 * 真正的共享仓库信息在 common dir 里（worktree 共享同一份 config 与 refs）。
 */
function resolveCommonDir(gitEntry: string): string {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(gitEntry).isDirectory();
  } catch {
    throw new Error(`cannot stat ${gitEntry}`);
  }
  if (isDirectory) return gitEntry;

  const text = readFileSync(gitEntry, 'utf-8');
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) throw new Error(`${gitEntry} is neither a directory nor a gitdir file`);
  const gitDir = resolve(dirname(gitEntry), match[1]!.trim());
  const commonFile = join(gitDir, 'commondir');
  if (!existsSync(commonFile)) return gitDir;
  const relative = readFileSync(commonFile, 'utf-8').trim();
  if (!relative) return gitDir;
  return isAbsolute(relative) ? relative : resolve(gitDir, relative);
}

/**
 * 只读 `config` 的 `[remote "origin"] url`。
 *
 * 不用 `git config` 是不想为一次提示词渲染起子进程；`config` 是纯文本，
 * 这里也不需要处理 include 之类的复杂形态——找不到就退回 common dir 身份，
 * 代价只是多个 clone 不共享记忆，不会出错。
 */
export function readOriginUrl(commonDir: string): string | null {
  const configPath = join(commonDir, 'config');
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const assignment = /^url\s*=\s*(.+)$/i.exec(line);
    if (assignment) return normalizeRemote(assignment[1]!.trim()) || null;
  }
  return null;
}

/**
 * 归一化远端地址，让 ssh / https / 带端口的写法落到同一个身份上。
 *
 * `git@git.x.com:org/repo.git`、`ssh://git@git.x.com:22/org/repo.git`、
 * `https://git.x.com/org/repo` 都是 `git.x.com/org/repo`。
 */
export function normalizeRemote(raw: string): string {
  let value = raw.trim();
  if (!value) return '';
  value = value.replace(/\.git$/i, '').replace(/\/+$/, '');

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp && !value.includes('://')) {
    return `${scp[1]}/${scp[2]}`.replace(/\/+/g, '/');
  }

  const url = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(value);
  if (url) return `${url[1]}/${url[2]}`.replace(/\/+/g, '/');

  // 本地路径或裸地址：保持原样，只去掉协议前缀。
  return value.replace(/^[a-z+]+:\/\//i, '');
}

function sanitize(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'repo';
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

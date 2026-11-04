import { join, resolve } from 'node:path';
import { listDomains, matchDomains, type DomainDefinition } from './domains.js';
import { resolvePathRepoIdentity, type RepoIdentity } from './repo.js';

/**
 * 记忆的作用域：**先问「这条事实在哪些会话里还成立」，再决定存在哪**。
 *
 * 三个范围从宽到窄：
 *
 * - `profile`：用户本人（称呼、语言、对任何项目都成立的偏好与红线）；
 * - `domain`：一组同域仓库共享的知识（租车的灰度规则、发布台、某个内部系统）；
 * - `project`：一个仓库的约定、命令、坑。
 *
 * 注入只给「当前会话确实适用」的那些：在 `mica-code` 里改桌面端时，租车领域的记忆
 * 一条都不出现。这是整个设计与「按主题分三块、全部无条件注入」的根本区别。
 */
export type MemoryScope =
  | { kind: 'profile' }
  | { kind: 'project'; repo: RepoIdentity; note?: string }
  | { kind: 'domain'; domain: DomainDefinition };

export type MemoryContext = {
  cwd: string | null;
  /** 会话 cwd 所属的仓库（开窗的位置）。 */
  repo: RepoIdentity | null;
  /** 本次任务实际碰到、且信号足够强的其它仓库。 */
  taskRepos: RepoIdentity[];
  /** 当前会话适用的领域（cwd 或仓库根落在它的 match 里）。 */
  domains: DomainDefinition[];
  /** 磁盘上定义的全部领域，给 `/memory` 与工具校验用。 */
  knownDomains: DomainDefinition[];
  /** 写项目记忆的默认目标：实际在改的仓库优先，其次才是 cwd 仓库。 */
  project: MemoryScope | null;
  /** 判断某个项目作用域是否属于本次会话（cwd 或本次碰过）。 */
  repos: RepoIdentity[];
};

export function resolveMemoryContext(
  memoryRoot: string,
  cwd: string | null | undefined,
  taskRepos: RepoIdentity[] = [],
): MemoryContext {
  const normalized = typeof cwd === 'string' && cwd.trim() ? resolve(cwd.trim()) : null;
  // 用宽松版：会话 cwd 可能已经被删掉，或者指向一个还没创建的目录；那也要认得出仓库。
  const repo = resolvePathRepoIdentity(normalized);
  const knownDomains = listDomains(memoryRoot);
  const extra = taskRepos.filter((candidate) => candidate.slug !== repo?.slug);
  const domains = matchDomains(knownDomains, [
    normalized,
    repo?.root,
    repo?.remote,
    ...extra.flatMap((candidate) => [candidate.root, candidate.remote]),
  ]);
  // 「目标仓库」优先：在 `mis` 里开会话去改 `sass`，默认写入目标必须是 sass。
  const target = extra[0] ?? repo;
  return {
    cwd: normalized,
    repo,
    taskRepos: extra,
    domains,
    knownDomains,
    project: target ? { kind: 'project', repo: target, ...noteFor(target, repo) } : null,
    repos: [repo, ...extra].filter((candidate): candidate is RepoIdentity => candidate !== null),
  };
}

function noteFor(target: RepoIdentity, cwdRepo: RepoIdentity | null): { note?: string } {
  if (!cwdRepo || cwdRepo.slug === target.slug) return {};
  return { note: '本次任务目标' };
}

/** 注入顺序：越窄越靠后，模型读到最后的是最近作用的规则。 */
export function contextScopes(context: MemoryContext): MemoryScope[] {
  const scopes: MemoryScope[] = [{ kind: 'profile' }];
  if (context.repo) scopes.push({ kind: 'project', repo: context.repo });
  for (const [index, repo] of context.taskRepos.entries()) {
    // 只有第一个是「目标」，其余是顺带碰到的：都给同一个标签会让模型分不清主次。
    scopes.push({ kind: 'project', repo, ...(index === 0 ? { note: '本次任务目标' } : {}) });
  }
  for (const domain of context.domains) scopes.push({ kind: 'domain', domain });
  return scopes;
}

export function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'profile':
      return 'profile';
    case 'project':
      return `project:${scope.repo.slug}`;
    case 'domain':
      return `domain:${scope.domain.name}`;
  }
}

/** 给人看的一句话，命令与工具结果里用。 */
export function describeScope(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'profile':
      return '用户档案（所有会话）';
    case 'project':
      return `项目记忆 · ${repoLabel(scope.repo)}${scope.note ? `（${scope.note}）` : ''}`;
    case 'domain':
      return `领域记忆 · ${scope.domain.name}`;
  }
}

/** 段落标题，注入与列表里用。 */
export function scopeTitle(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'profile':
      return '用户档案';
    case 'project':
      return `项目记忆 · ${repoLabel(scope.repo)}${scope.note ? `（${scope.note}）` : ''}`;
    case 'domain':
      return `领域记忆 · ${scope.domain.name}`;
  }
}

/** 仓库名取远端（同一仓库的不同 clone 才认得出是一个），目录名不同时一起显示。 */
export function repoLabel(repo: RepoIdentity): string {
  return repo.dirName && repo.dirName !== repo.name ? `${repo.name} · ${repo.dirName}` : repo.name;
}

export function scopeFile(memoryRoot: string, scope: MemoryScope): string {
  switch (scope.kind) {
    case 'profile':
      return join(memoryRoot, 'PROFILE.md');
    case 'project':
      return join(memoryRoot, 'projects', `${scope.repo.slug}.md`);
    case 'domain':
      // 由名字推出路径而不是依赖条目里的 `path`：领域文件是本地的、可以被手工改名，
      // 而作用域对象可能来自上一轮读到的清单。
      return join(memoryRoot, 'domains', `${scope.domain.name}.md`);
  }
}

export function scopeLabel(memoryRoot: string, scope: MemoryScope): string {
  return scopeFile(memoryRoot, scope).slice(memoryRoot.length + 1);
}

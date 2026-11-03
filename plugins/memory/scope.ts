import { join, resolve } from 'node:path';
import { listDomains, matchDomains, type DomainDefinition } from './domains.js';
import { resolveRepoIdentity, type RepoIdentity } from './repo.js';

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
  | { kind: 'project'; repo: RepoIdentity }
  | { kind: 'domain'; domain: DomainDefinition };

export type MemoryContext = {
  cwd: string | null;
  repo: RepoIdentity | null;
  /** 当前会话适用的领域（cwd 或仓库根落在它的 match 里）。 */
  domains: DomainDefinition[];
  /** 磁盘上定义的全部领域，给 `/memory` 与工具校验用。 */
  knownDomains: DomainDefinition[];
  /** 可写的项目作用域；不在仓库里时为 null。 */
  project: MemoryScope | null;
};

export function resolveMemoryContext(memoryRoot: string, cwd: string | null | undefined): MemoryContext {
  const normalized = typeof cwd === 'string' && cwd.trim() ? resolve(cwd.trim()) : null;
  const repo = resolveRepoIdentity(normalized);
  const knownDomains = listDomains(memoryRoot);
  const domains = matchDomains(knownDomains, [normalized, repo?.root, repo?.remote]);
  return {
    cwd: normalized,
    repo,
    domains,
    knownDomains,
    project: repo ? { kind: 'project', repo } : null,
  };
}

/** 注入顺序：越窄越靠后，模型读到最后的是最近作用的规则。 */
export function contextScopes(context: MemoryContext): MemoryScope[] {
  const scopes: MemoryScope[] = [{ kind: 'profile' }];
  if (context.project) scopes.push(context.project);
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
      return `项目记忆 · ${scope.repo.name}`;
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
      return `项目记忆 · ${scope.repo.name}`;
    case 'domain':
      return `领域记忆 · ${scope.domain.name}`;
  }
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

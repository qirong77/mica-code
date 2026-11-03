import { existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Disposable } from '@packages/mica-common/index.js';
import type { CommandResult } from '@packages/mica-commands/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { ensureDomain, listDomains } from './domains.js';
import { contextScopes, describeScope, type MemoryContext } from './scope.js';
import { formatMemoryStatus } from './section.js';
import type { MemoryRepository } from './store.js';

export type MemoryReviewOutcome = {
  ok: boolean;
  /** 已经准备好展示给用户的一段话。 */
  message: string;
};

export type MemoryCommandDeps = {
  repository: MemoryRepository;
  /** 当前会话的作用域解析结果（换 cwd 之后重新求值）。 */
  context: () => MemoryContext;
  /** 丢弃本会话的 prompt 快照，下一轮重新读盘。 */
  refreshPrompt: () => void;
  /** 手动触发一次整理（内部自行处理并发与节流）。 */
  runReview: () => Promise<MemoryReviewOutcome>;
  /** 当前整理模式与配置状态，`status` 里展示。 */
  describeRuntime: () => string;
};

/**
 * `/memory`：记忆系统的观察面与唯一的"结构"入口。
 *
 * 记忆文件本身是普通 markdown，用户可以直接编辑；这个命令解决的是在编辑器里看不到的
 * 几件事：**当前会话到底会注入哪几层**、各层用了多少、刚整理过没有，以及领域的创建
 * （领域是用户划定的知识边界，模型不能自己造）。
 */
export function registerMemoryCommand(ctx: PluginContext, deps: MemoryCommandDeps): Disposable {
  return ctx.commands.register({
    name: 'memory',
    description: '查看 / 整理跨会话记忆（用户档案 · 项目记忆 · 领域记忆）',
    completionItems: [
      { arg: 'status', description: '当前会话会注入哪几层、各层用量（默认）' },
      { arg: 'list', description: 'list [profile|project|domain <名字>]：列出条目' },
      { arg: 'domain', description: 'domain list | domain new <名字> [路径]：查看 / 新建领域' },
      { arg: 'review', description: '立即整理一次当前会话' },
      { arg: 'refresh', description: '重新读取记忆文件（本会话的系统提示快照）' },
      { arg: 'path', description: '显示记忆文件所在目录' },
      { arg: 'archive', description: '把旧版记忆文件（USER.md / MEMORY.md 等）移入 archive/' },
    ],
    scope: 'local-only',
    allowDuringTurn: false,
    pluginId: ctx.pluginId,
    handler: async (_commandCtx, args): Promise<CommandResult> => {
      const [verb = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (verb) {
        case 'status': {
          const context = deps.context();
          const snapshots = deps.repository.snapshots(contextScopes(context));
          const lines = [
            '当前会话适用的记忆层：',
            ...snapshots.map((snapshot) => `· ${formatMemoryStatus([snapshot])}`),
            '',
            describeContextLine(context),
            '',
            deps.describeRuntime(),
            `目录：${deps.repository.root}`,
          ];
          ctx.ui?.showMessage(lines.join('\n'), 12_000);
          return { ok: true };
        }
        case 'list': {
          const target = rest[0];
          if (!target) return listContext(ctx, deps);
          if (target === 'profile' || target === 'project' || target === 'domain') {
            return listScope(ctx, deps, target, rest[1]);
          }
          ctx.ui?.showMessage(`未知的记忆层：${target}（可用：profile / project / domain <名字>）`, 6000);
          return { ok: true };
        }
        case 'domain': {
          const action = rest[0] ?? 'list';
          if (action === 'list') {
            const domains = listDomains(deps.repository.root);
            if (domains.length === 0) {
              ctx.ui?.showMessage(
                '还没有定义任何领域。领域用于「一组同域仓库共享的知识」，例如把 sass / mis / zuche-staff-service 归为「租车」。\n\n新建：/memory domain new <名字> [覆盖路径...]（默认当前目录）',
                12_000,
              );
              return { ok: true };
            }
            const context = deps.context();
            const lines = domains.map((domain) => {
              const active = context.domains.some((candidate) => candidate.name === domain.name);
              return `${active ? '●' : '○'} ${domain.name}${domain.description ? ` —— ${domain.description}` : ''}\n    覆盖：${domain.match.join('  ') || '（未声明）'}`;
            });
            ctx.ui?.showMessage(['领域（● = 当前会话命中）：', ...lines].join('\n'), 12_000);
            return { ok: true };
          }
          if (action === 'new' || action === 'add') {
            const name = rest[1];
            if (!name) {
              ctx.ui?.showMessage('用法：/memory domain new <名字> [覆盖路径...]', 6000);
              return { ok: true };
            }
            const paths = rest.slice(2);
            const context = deps.context();
            const defaults = paths.length > 0 ? paths : [context.repo?.root ?? context.cwd ?? process.cwd()];
            const result = ensureDomain(deps.repository.root, name, defaults);
            if (!result.ok) {
              ctx.ui?.showMessage(`新建领域失败：${result.error}`, 6000);
              return { ok: false, error: new Error(result.error) };
            }
            deps.refreshPrompt();
            ctx.ui?.showMessage(
              result.created
                ? `已创建领域「${name}」，覆盖：${defaults.join('  ')}\n\n把跨仓库共享的事实写进 ${result.path}（或让模型用 scope=domain 写入）。`
                : `领域「${name}」已更新覆盖路径：${defaults.join('  ')}`,
              10_000,
            );
            return { ok: true };
          }
          ctx.ui?.showMessage('用法：/memory domain list | /memory domain new <名字> [路径...]', 6000);
          return { ok: true };
        }
        case 'review': {
          ctx.ui?.showMessage('记忆整理中…', 3000);
          const outcome = await deps.runReview();
          ctx.ui?.showMessage(outcome.message, 12_000);
          return outcome.ok ? { ok: true } : { ok: false, error: new Error(outcome.message), message: outcome.message };
        }
        case 'refresh': {
          deps.refreshPrompt();
          ctx.ui?.showMessage('已丢弃本会话的记忆快照，下一次请求会重新读取文件。', 6000);
          return { ok: true };
        }
        case 'path': {
          const context = deps.context();
          const lines = contextScopes(context).map(
            (scope) => `${describeScope(scope)}: ${deps.repository.pathFor(scope)}`,
          );
          ctx.ui?.showMessage([`记忆目录：${deps.repository.root}`, ...lines].join('\n'), 10_000);
          return { ok: true };
        }
        case 'archive': {
          const moved = archiveLegacyFiles(deps.repository.root);
          ctx.ui?.showMessage(
            moved.length > 0
              ? `已把 ${moved.length} 个旧版记忆文件移入 archive/：\n${moved.join('\n')}\n\n新架构不再读取它们；需要时从该目录取回。`
              : '没有需要归档的旧版记忆文件。',
            10_000,
          );
          return { ok: true };
        }
        default: {
          ctx.ui?.showMessage(
            `未知子命令：${verb}。可用：status / list / domain / review / refresh / path / archive。`,
            8000,
          );
          return { ok: true };
        }
      }
    },
  });
}

function listContext(ctx: PluginContext, deps: MemoryCommandDeps): CommandResult {
  const context = deps.context();
  const snapshots = deps.repository.snapshots(contextScopes(context));
  const lines: string[] = [describeContextLine(context), ''];
  for (const snapshot of snapshots) {
    lines.push(`## ${snapshot.title} · ${snapshot.entries.length} 条 · ${snapshot.chars}/${snapshot.budget} 字符`, '');
    if (snapshot.entries.length === 0) lines.push('（空）');
    else lines.push(...snapshot.entries.map((entry, index) => `${index + 1}. ${entry}`));
    lines.push('');
  }
  ctx.ui?.showMessage(lines.join('\n'), 15_000);
  return { ok: true };
}

function listScope(
  ctx: PluginContext,
  deps: MemoryCommandDeps,
  kind: 'profile' | 'project' | 'domain',
  domainName: string | undefined,
): CommandResult {
  if (kind === 'domain') {
    const name = domainName ?? deps.context().domains[0]?.name;
    if (!name) {
      ctx.ui?.showMessage('用法：/memory list domain <领域名>（用 /memory domain list 查看已有领域）', 6000);
      return { ok: true };
    }
    const domain = listDomains(deps.repository.root).find((candidate) => candidate.name === name);
    if (!domain) {
      ctx.ui?.showMessage(`找不到领域「${name}」。`, 6000);
      return { ok: true };
    }
    const snapshot = deps.repository.snapshot({ kind: 'domain', domain });
    return showSnapshot(ctx, snapshot.title, snapshot.entries, snapshot.chars, snapshot.budget);
  }
  if (kind === 'project') {
    const project = deps.context().project;
    if (!project) {
      ctx.ui?.showMessage('当前工作目录不在任何仓库里，所以没有项目记忆。', 6000);
      return { ok: true };
    }
    const snapshot = deps.repository.snapshot(project);
    return showSnapshot(ctx, snapshot.title, snapshot.entries, snapshot.chars, snapshot.budget);
  }
  const snapshot = deps.repository.snapshot({ kind: 'profile' });
  return showSnapshot(ctx, snapshot.title, snapshot.entries, snapshot.chars, snapshot.budget);
}

function showSnapshot(
  ctx: PluginContext,
  title: string,
  entries: string[],
  chars: number,
  budget: number,
): CommandResult {
  if (entries.length === 0) {
    ctx.ui?.showMessage(`${title} 还没有任何记忆。`, 6000);
    return { ok: true };
  }
  ctx.ui?.showMessage(
    [
      `${title} · ${entries.length} 条 · ${chars}/${budget} 字符`,
      '',
      ...entries.map((entry, index) => `${index + 1}. ${entry}`),
    ].join('\n'),
    12_000,
  );
  return { ok: true };
}

function describeContextLine(context: MemoryContext): string {
  const parts: string[] = [];
  parts.push(
    context.repo ? `仓库：${context.repo.name}（${context.repo.remote ?? context.repo.root}）` : '不在任何仓库里',
  );
  parts.push(
    context.domains.length > 0
      ? `命中的领域：${context.domains.map((domain) => domain.name).join(', ')}`
      : '没有命中领域',
  );
  if (context.knownDomains.length > 0 && context.domains.length === 0) {
    parts.push(`已定义的领域：${context.knownDomains.map((domain) => domain.name).join(', ')}`);
  }
  return parts.join(' · ');
}

/**
 * 旧版布局（`USER.md` / `MEMORY.md` / `projects/<cwd-hash>/MEMORY.md`）不再被读取。
 * 归档是显式的：不自动搬，因为「用户以为记忆还在、其实被移走了」比留着更糟。
 */
export function archiveLegacyFiles(root: string): string[] {
  const legacy = ['USER.md', 'MEMORY.md'].filter((name) => existsSync(join(root, name)));
  const projectsDir = join(root, 'projects');
  // 只认旧布局的 `projects/<cwd 哈希>/MEMORY.md`。新布局的 `projects/<仓库>.md`
  // 是同目录下的文件，按前缀一刀切会把用户正在用的项目记忆也搬走。
  const projectStores = existsSync(projectsDir)
    ? readdirSync(projectsDir)
        .filter((name) => existsSync(join(projectsDir, name, 'MEMORY.md')))
        .map((name) => `projects/${name}`)
    : [];
  const targets = [...legacy, ...projectStores];
  if (targets.length === 0) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(root, 'archive', stamp);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const target of targets) {
    try {
      renameSync(join(root, target), join(dest, target.replace(/\//g, '__')));
      moved.push(target);
    } catch {
      // 单个文件搬不动（权限、跨设备）不影响其余文件。
    }
  }
  return moved;
}

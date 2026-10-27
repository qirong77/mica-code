import type { Disposable } from '@packages/mica-common/index.js';
import type { CommandResult } from '@packages/mica-commands/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { MEMORY_TARGETS, type MemoryRepository, type MemoryTarget } from './store.js';
import { formatMemoryStatus, formatMemorySection } from './section.js';

export type MemoryReviewOutcome = {
  ok: boolean;
  /** 已经准备好展示给用户的一段话。 */
  message: string;
};

export type MemoryCommandDeps = {
  repository: MemoryRepository;
  /** 丢弃本会话的 prompt 快照，下一轮重新读盘。 */
  refreshPrompt: () => void;
  /** 手动触发一次整理（内部自行处理并发与节流）。 */
  runReview: () => Promise<MemoryReviewOutcome>;
  /** 当前整理模式与配置状态，`status` 里展示。 */
  describeRuntime: () => string;
};

/**
 * `/memory`：记忆系统的观察面。
 *
 * 记忆文件本身是普通的 markdown，用户可以直接编辑；这个命令只解决「在哪、用了
 * 多少、刚整理过没有」这三件在编辑器里看不到的事，以及手动触发整理和刷新快照。
 */
export function registerMemoryCommand(ctx: PluginContext, deps: MemoryCommandDeps): Disposable {
  return ctx.commands.register({
    name: 'memory',
    description: '查看 / 整理跨会话记忆（user / memory / project 三块）',
    completionItems: [
      { arg: 'status', description: '用量、条目数、最近一次整理（默认）' },
      { arg: 'list', description: 'list [user|memory|project]：列出条目' },
      { arg: 'review', description: '立即整理一次当前会话' },
      { arg: 'refresh', description: '重新读取记忆文件（本会话的系统提示快照）' },
      { arg: 'path', description: '显示记忆文件所在目录' },
    ],
    scope: 'local-only',
    allowDuringTurn: false,
    pluginId: ctx.pluginId,
    handler: async (_commandCtx, args): Promise<CommandResult> => {
      const [verb = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (verb) {
        case 'status': {
          const snapshots = deps.repository.snapshots();
          ctx.ui?.showMessage(
            [formatMemoryStatus(snapshots), '', deps.describeRuntime(), `目录：${deps.repository.root}`].join('\n'),
            10_000,
          );
          return { ok: true };
        }
        case 'list': {
          const target = resolveTarget(rest[0]);
          if (!target) {
            ctx.ui?.showMessage(`未知的记忆块：${rest[0] ?? ''}（可用：${MEMORY_TARGETS.join(' / ')}）`, 6000);
            return { ok: true };
          }
          const snapshot = deps.repository.snapshot(target);
          if (snapshot.entries.length === 0) {
            ctx.ui?.showMessage(`${target} 还没有任何记忆（${snapshot.label}）。`, 6000);
            return { ok: true };
          }
          ctx.ui?.showMessage(
            [
              `${target} · ${snapshot.entries.length} 条 · ${snapshot.chars}/${snapshot.limit} 字符`,
              '',
              ...snapshot.entries.map((entry, index) => `${index + 1}. ${entry}`),
            ].join('\n'),
            10_000,
          );
          return { ok: true };
        }
        case 'review': {
          ctx.ui?.showMessage('记忆整理中…', 3000);
          const outcome = await deps.runReview();
          ctx.ui?.showMessage(outcome.message, 10_000);
          return outcome.ok ? { ok: true } : { ok: false, error: new Error(outcome.message), message: outcome.message };
        }
        case 'refresh': {
          deps.refreshPrompt();
          ctx.ui?.showMessage('已丢弃本会话的记忆快照，下一次请求会重新读取文件。', 6000);
          return { ok: true };
        }
        case 'path': {
          const lines = deps.repository.snapshots().map((snapshot) => `${snapshot.target}: ${snapshot.path}`);
          ctx.ui?.showMessage([`记忆目录：${deps.repository.root}`, ...lines].join('\n'), 10_000);
          return { ok: true };
        }
        default: {
          ctx.ui?.showMessage(
            `未知子命令：${verb}。可用：status / list / review / refresh / path。\n\n${formatMemorySection(
              deps.repository.snapshots(),
            )}`,
            10_000,
          );
          return { ok: true };
        }
      }
    },
  });
}

function resolveTarget(value: string | undefined): MemoryTarget | null {
  if (!value) return 'memory';
  return MEMORY_TARGETS.includes(value as MemoryTarget) ? (value as MemoryTarget) : null;
}

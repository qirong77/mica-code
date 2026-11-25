import type {
  PluginPanelActionResult,
  PluginPanelHandler,
  PluginPanelItem,
  PluginPanelView,
} from '@packages/mica-plugin/index.js';
import { type SubagentEntry, type SubagentRegistry } from './registry.js';
import { renderSubagent, sinceLabel } from './views.js';

/**
 * 对话右侧的那块面板：看得见、也按得动所有子会话。
 *
 * 之前用户只能从会话列表里看到「派生了几条会话」，既不知道它们现在跑到哪，也不能
 * 在界面上打断或收掉——想停一个跑飞的子会话，得自己打字让模型去调工具。这块面板把
 * 那几件事变成一次点击：
 *
 * - **状态行**（输入框上方常驻）：`2 个子会话在跑`，面板关着也看得见；
 * - **每一条**：状态、最近动静、用量，行内可「看详情 / 打断 / 收掉」；
 * - **整块**：一键收掉跑完的，或者把「汇总结果」放进输入框交给模型收尾。
 *
 * 视图只读进程里已有的投影（宿主每 4 秒轮询一次视图），所以这里不跑命令、不发请求、
 * 也不等子会话——那些都是动作或工具的事。
 */

export const INSPECT_ACTION = 'inspect';
export const ABORT_ACTION = 'abort';
export const CLOSE_ACTION = 'close';
export const CLOSE_IDLE_ACTION = 'close-idle';
export const COLLECT_ACTION = 'collect';
export const SPAWN_ACTION = 'spawn';
/** 详情弹窗里「接着让它干」：把一句话放进输入框，由模型带着上下文投给子会话。 */
export const CONTINUE_ACTION = 'continue';

export type PanelDeps = {
  registry: SubagentRegistry;
  /** 现在的时间：测试用它固定「最近动静 3s 前」。 */
  now?: () => number;
};

function stateLabel(entry: SubagentEntry): string {
  if (entry.process.closed) return '已退出';
  return entry.process.transcript.busy ? '运行中' : '空闲';
}

function toneOf(entry: SubagentEntry): 'ok' | 'warn' | 'muted' {
  if (entry.process.closed) return 'muted';
  return entry.process.transcript.busy ? 'warn' : 'ok';
}

function itemOf(entry: SubagentEntry, now: number): PluginPanelItem {
  const transcript = entry.process.transcript;
  const latest = transcript.latestTurn;
  const conclusion = latest ? latest.text.replace(/\s+/g, ' ').trim() : '';
  return {
    key: entry.id,
    label: `${entry.title} · ${stateLabel(entry)}`,
    value:
      `${transcript.totalTurnCount} 轮 · 最近动静 ${sinceLabel(transcript.lastActivityAt, now)}` +
      (transcript.usage.total > 0 ? ` · ${transcript.usage.total} token` : '') +
      (conclusion ? ` · ${conclusion.slice(0, 80)}` : ''),
    tone: toneOf(entry),
    actions: [
      { id: INSPECT_ACTION, label: '看详情', icon: 'external' },
      ...(entry.process.closed || !transcript.busy
        ? [{ id: CLOSE_ACTION, label: '收掉', icon: 'close' as const, tone: 'ghost' as const }]
        : [{ id: ABORT_ACTION, label: '打断', icon: 'close' as const, tone: 'danger' as const }]),
    ],
  };
}

export function createPanelHandler(deps: PanelDeps): PluginPanelHandler {
  const { registry } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    view(): PluginPanelView {
      const entries = registry.list();
      const live = entries.filter((entry) => !entry.process.closed);
      const running = live.filter((entry) => entry.process.transcript.busy).length;
      const sections: NonNullable<PluginPanelView['sections']> = [
        {
          title: '子会话',
          subtitle: entries.length
            ? `${running} 个在跑 · ${live.length - running} 个空闲`
            : undefined,
          items: entries.map((entry) => itemOf(entry, now())),
          empty: '还没有子会话。要派活就点下面的「派一个」——模型会按你的话写清楚目标、边界和验收方式。',
          ...(live.length
            ? {
                actions: [
                  { id: CLOSE_IDLE_ACTION, label: '收掉空闲的', icon: 'trash' as const, tone: 'ghost' as const },
                  { id: COLLECT_ACTION, label: '汇总结果', icon: 'check' as const, tone: 'primary' as const },
                ],
              }
            : {}),
        },
        {
          title: '派一个',
          subtitle: '在这里写一句要它做的事，提示词会放进输入框，由你确认后再发',
          actions: [{ id: SPAWN_ACTION, label: '派一个去干活', tone: 'default' as const }],
        },
      ];
      return {
        title: 'Subagent',
        subtitle: entries.length ? `${entries.length} 个子会话` : '没有在跑的子会话',
        ...(registry.pendingEventCount > 0
          ? { status: { label: `${registry.pendingEventCount} 条新动态`, tone: 'accent' as const } }
          : {}),
        // 状态行只在真有活在跑时出现：空闲的子会话挂在侧栏里就够，不必占一条常驻位置。
        ...(running > 0
          ? {
              statusBar: {
                label: `${running} 个在跑`,
                detail: live.length > running ? `${live.length} 个子会话` : undefined,
                tone: 'accent' as const,
                section: '子会话',
              },
            }
          : {}),
        sections,
      };
    },

    async action(input): Promise<PluginPanelActionResult> {
      const entryId = input.key ?? '';
      const entry = entryId ? registry.get(entryId) : null;
      switch (input.action) {
        case INSPECT_ACTION: {
          if (!entry) return { message: '这条子会话已经不在了，刷新看看。' };
          registry.markRead(entry.id);
          return {
            dialog: {
              title: entry.title,
              subtitle: `${entry.id} · ${stateLabel(entry)}`,
              text: renderSubagent(entry, { full: true }),
              actions: [
                ...(entry.process.closed || !entry.process.transcript.busy
                  ? []
                  : [{ id: ABORT_ACTION, key: entry.id, label: '打断这一轮', tone: 'danger' as const }]),
                { id: CONTINUE_ACTION, key: entry.id, label: '让它接着干', tone: 'primary' as const },
              ],
            },
          };
        }
        case ABORT_ACTION: {
          if (!entry) return { message: '这条子会话已经不在了。' };
          const stopped = await entry.process.abort().catch(() => false);
          return { message: stopped ? `已打断「${entry.title}」这一轮` : `「${entry.title}」当前没有在跑的一轮` };
        }
        case CLOSE_ACTION: {
          if (!entry) return { message: '这条子会话已经不在了。' };
          // 不 await：close 最多等 3s 落盘，而页面在等这次动作的回包。
          void registry.close(entry.id).catch(() => undefined);
          return { message: `正在收掉「${entry.title}」` };
        }
        case CLOSE_IDLE_ACTION: {
          const closed = await registry.closeMany('idle');
          return { message: closed.length ? `已收掉 ${closed.length} 个空闲的子会话` : '没有空闲的子会话可收' };
        }
        case SPAWN_ACTION:
        case COLLECT_ACTION:
        case CONTINUE_ACTION: {
          const text =
            input.action === COLLECT_ACTION
              ? '用 subagent_inspect({ full: true }) 汇总当前所有子会话的结果（状态、结论、失败的工具），然后 subagent_stop({ action: "close", idle: true }) 收掉已经跑完的。'
              : input.action === SPAWN_ACTION
                ? '用 subagent_drive 派一个子会话去干活：'
                : entry
                  ? `用 subagent_drive 让子会话 ${entry.id} 接着干：`
                  : '用 subagent_inspect 看看当前有哪些子会话。';
          // 不替用户按发送：这些事由模型带着对话上下文去写提示词，用户先看一眼再发。
          return { compose: text };
        }
        default:
          return { message: `未知动作：${String(input.action)}` };
      }
    },
  };
}

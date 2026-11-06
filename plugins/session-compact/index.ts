import type { PluginContext, PluginTurnPrepareEvent } from '@packages/mica-plugin/index.js';
import { formatTokenCount } from '@packages/mica-common/format.js';

type CompactHistory = NonNullable<NonNullable<PluginContext['agent']>['compactIdleHistory']>;

/**
 * 会话压缩：右键菜单手动压缩，模型配置变更后下一轮快速压缩。
 *
 * - 快速压缩：把历史里的工具过程聚合成一条占位调用（思考丢掉、图片换占位符）。
 *   不调模型、不丢轮次、不改对话正文，所以随手就能点一次。
 * - 模型压缩：把用户与助手的对话（不带工具调用与结果）交给模型写一段 checkpoint
 *   摘要，旧历史折成这段摘要加最近几轮。
 *
 * 手动两条入口与轮前 compactHistory 都将当前压缩结果落盘，展示记录同步变化；
 * 对话区完整展示当前持久化记录，不额外保留压缩前的原始展示历史。
 *
 * 摘要走清单里的 `llm`（默认可复用当前会话模型）：换模型是插件的事，分段、预算与
 * 截断仍归内核的 `CompactionService`。
 */
export default function setup(ctx: PluginContext): void {
  const compact = ctx.agent?.compactIdleHistory;
  const menu = ctx.desktop?.sessionMenu;
  if (!compact || !menu) {
    ctx.health.report({
      level: 'warn',
      message: '宿主没有提供会话历史压缩能力，会话压缩不可用',
      hint: '需要桌面端（mica app-server）启动的会话宿主',
    });
    return;
  }
  ctx.health.report({ level: 'ok', message: '会话压缩已就绪：右键会话可快速压缩或模型压缩' });

  const prepare = ctx.hooks.on<PluginTurnPrepareEvent>('turn:prepare', async ({ previous, current, compactHistory }) => {
    if (previous.providerId === current.providerId && previous.model === current.model) return;
    await compactHistory({ mode: 'quick' });
  });
  ctx.onDispose(() => prepare.dispose());

  menu({
    run({ action }) {
      if (action === 'quick') return quick(compact);
      if (action === 'model') return model(ctx, compact);
      return { message: `未知动作：${action}` };
    },
  });
}

function quick(compact: CompactHistory) {
  return report(() => compact({ mode: 'quick' }), '快速压缩', '没有可清理的工具结果');
}

async function model(ctx: PluginContext, compact: CompactHistory) {
  const llm = ctx.llm;
  if (!llm) return { message: '当前宿主没有模型接口，模型压缩不可用' };
  if (!llm.configured())
    return { message: '压缩摘要模型未配置：在插件设置里复用当前会话模型，或填写接口地址与模型' };
  const summarize = async (transcript: string, prompt: string): Promise<string> => {
    const result = await llm.request({
      purpose: '会话压缩摘要',
      system: prompt,
      user: transcript,
      timeoutMs: 120_000,
    });
    if (!result.text.trim()) throw new Error('摘要请求返回了空内容');
    return result.text;
  };
  return report(() => compact({ mode: 'model', summarize }), '模型压缩', '对话内容太少，不用压缩');
}

/** 菜单动作没有别的地方可以说结果，这里的一句话就是全部反馈。 */
async function report(
  run: () => ReturnType<CompactHistory>,
  label: string,
  emptyMessage: string,
): Promise<{ message: string }> {
  let outcome;
  try {
    outcome = await run();
  } catch (error) {
    return { message: `${label}失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (outcome.status === 'skipped')
    return { message: outcome.reason === 'busy' ? '这条会话正忙，等这一轮结束再压' : emptyMessage };
  const show = (tokens: number) => formatTokenCount(tokens, { roundedThousands: true });
  // 压缩前的数字锚在会话上一次真实请求上，误差不到 1%；压缩后的余量只能从「清掉多少」反推，
  // 一次压掉七八成时它同时含固定开销（提示词 + 工具定义，每条会话 16k~40k）的估算偏差，
  // 所以标成「约」，把实测更稳的清掉量单独写出来。
  return {
    message: `${label}完成：${show(outcome.beforeTokens)} → 约 ${show(outcome.afterTokens)}（清掉 ${show(outcome.savedTokens)}）`,
  };
}

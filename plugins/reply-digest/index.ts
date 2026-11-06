import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import {
  cleanSummary,
  DEFAULT_CHAR_THRESHOLD,
  DEFAULT_INPUT_LIMIT,
  DEFAULT_LINE_THRESHOLD,
  DEFAULT_SUMMARY_LIMIT,
  digestInput,
  lastAssistantText,
  parseSetting,
  shouldDigest,
} from './digest.js';

const DEFAULT_PROMPT = [
  '请把下面 Agent 的最终回复压缩成一段简短摘要。',
  '保留做了什么、关键结论、重要文件或验证结果；不要复述过程，不要编造原文没有的信息。',
  '使用原回复的语言，最多 4 个要点或 600 个字符，可使用简洁 Markdown，只输出摘要正文，不要加“摘要：”标题。',
].join('\n');

export { DEFAULT_PROMPT };

type DigestState = { inputId: string; controller: AbortController };

export default function setup(ctx: PluginContext): void {
  const states = new Map<string, DigestState>();
  // 同一条会话里已经处理过的回合：同一轮即使被重复派发也只摘要一次。
  const handled = new Map<string, string>();
  const rememberHandled = (sessionId: string, inputId: string) => {
    handled.delete(sessionId);
    handled.set(sessionId, inputId);
    if (handled.size > 50) {
      const oldest = handled.keys().next();
      if (!oldest.done) handled.delete(oldest.value);
    }
  };
  let disposed = false;

  const dispose = () => {
    disposed = true;
    for (const state of states.values()) state.controller.abort();
    states.clear();
    handled.clear();
  };
  ctx.onDispose(dispose);


  const subscription = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
    'turn:after',
    (event) => {
      if (disposed || event.outcome !== 'completed' || ctx.agent?.mode === 'one-shot') return;
      const session = ctx.session;
      const llm = ctx.llm;
      const ui = ctx.ui;
      if (!session || !llm || !ui) return;

      const info = session.describe(event.owner);
      if (!info) return;
      if (handled.get(info.id) === event.input.id) return;
      const previous = states.get(info.id);
      previous?.controller.abort();

      const settings = ctx.settings.get();
      const limits = {
        charThreshold: parseSetting(settings.charThreshold, DEFAULT_CHAR_THRESHOLD, 200, 100_000),
        lineThreshold: parseSetting(settings.lineThreshold, DEFAULT_LINE_THRESHOLD, 5, 10_000),
        inputLimit: parseSetting(settings.inputLimit, DEFAULT_INPUT_LIMIT, 1_000, 100_000),
        summaryLimit: parseSetting(settings.summaryLimit, DEFAULT_SUMMARY_LIMIT, 100, 2_000),
      };
      const messages = session.messages(event.owner);
      const reply = lastAssistantText(messages);
      if (!shouldDigest(reply, limits)) {
        states.delete(info.id);
        rememberHandled(info.id, event.input.id);
        return;
      }
      if (!llm.configured(event.owner)) {
        rememberHandled(info.id, event.input.id);
        ctx.health.report({
          level: 'warn',
          message: '检测到长回复，但摘要模型未配置，未生成摘要',
          hint: '请在插件设置里复用当前会话模型，或填写独立模型配置',
        });
        return;
      }

      rememberHandled(info.id, event.input.id);
      const controller = new AbortController();
      states.set(info.id, { inputId: event.input.id, controller });
      void summarize(ctx, event, digestInput(reply, limits.inputLimit), limits.summaryLimit, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted || disposed) return;
          ctx.logger.warn('reply-digest:failed', {
            sessionId: info.id,
            error: error instanceof Error ? error.message : String(error),
          });
          ctx.health.report({
            level: 'warn',
            message: '长回复摘要生成失败，原回复不受影响',
            hint: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (states.get(info.id)?.controller === controller) states.delete(info.id);
        });
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => subscription.dispose());
}

async function summarize(
  ctx: PluginContext,
  event: RuntimeTurnAfterHookEvent,
  reply: string,
  summaryLimit: number,
  signal: AbortSignal,
): Promise<void> {
  const result = await ctx.llm!.request({
    purpose: '长回复摘要',
    system: String(ctx.settings.get().prompt || DEFAULT_PROMPT),
    user: `Agent 最终回复：\n\n${reply}`,
    timeoutMs: 90_000,
    signal,
    owner: event.owner,
  });
  const summary = cleanSummary(result.text, summaryLimit);
  if (!summary || signal.aborted) throw new Error('摘要模型返回了空内容');
  ctx.ui!.notice(summary, {
    owner: event.owner,
    status: 'info',
    variant: 'digest',
  });
  ctx.health.report({ level: 'ok', message: '长回复摘要已生成' });
}

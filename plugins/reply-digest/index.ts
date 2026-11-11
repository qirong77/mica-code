import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent, RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
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

type DigestState = { inputId: string; cancel: (message: string) => void };

export default function setup(ctx: PluginContext): void {
  const states = new Map<string, DigestState>();
  // 保留近期已处理回合，重复派发旧事件也不会再请求模型或插入卡片。
  const handled = new Set<string>();
  const inputKey = (sessionId: string, inputId: string) => JSON.stringify([sessionId, inputId]);
  const rememberHandled = (sessionId: string, inputId: string) => {
    handled.add(inputKey(sessionId, inputId));
    if (handled.size > 200) {
      const oldest = handled.keys().next();
      if (!oldest.done) handled.delete(oldest.value);
    }
  };
  let disposed = false;

  ctx.onDispose(() => {
    disposed = true;
    for (const state of states.values()) state.cancel('摘要生成已取消：插件已停用，原回复不受影响。');
    states.clear();
    handled.clear();
  });

  const beforeSubscription = ctx.hooks.on<RuntimeTurnBeforeHookEvent>(
    'turn:before',
    (event) => {
      if (disposed || !event.owner) return;
      const info = ctx.session?.describe(event.owner);
      const previous = info && states.get(info.id);
      if (previous && previous.inputId !== event.input.id) {
        previous.cancel('摘要生成已取消：已开始新一轮对话，原回复不受影响。');
      }
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => beforeSubscription.dispose());

  const subscription = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
    'turn:after',
    (event) => {
      if (disposed || ctx.agent?.mode === 'one-shot') return;
      const session = ctx.session;
      const llm = ctx.llm;
      const ui = ctx.ui;
      if (!session || !llm || !ui) return;

      const info = session.describe(event.owner);
      if (!info) return;
      const alreadyHandled = handled.has(inputKey(info.id, event.input.id));
      if (event.outcome !== 'completed') {
        const previous = states.get(info.id);
        if (!alreadyHandled || previous?.inputId === event.input.id) {
          previous?.cancel('摘要生成已取消：对话已中止或失败，原回复不受影响。');
        }
        return;
      }
      if (alreadyHandled) return;
      states.get(info.id)?.cancel('摘要生成已取消：对话已进入下一轮，原回复不受影响。');

      const settings = ctx.settings.get();
      const limits = {
        charThreshold: parseSetting(settings.charThreshold, DEFAULT_CHAR_THRESHOLD, 200, 100_000),
        lineThreshold: parseSetting(settings.lineThreshold, DEFAULT_LINE_THRESHOLD, 5, 10_000),
        inputLimit: parseSetting(settings.inputLimit, DEFAULT_INPUT_LIMIT, 1_000, 100_000),
        summaryLimit: parseSetting(settings.summaryLimit, DEFAULT_SUMMARY_LIMIT, 100, 2_000),
      };
      const reply = lastAssistantText(session.messages(event.owner));
      rememberHandled(info.id, event.input.id);
      if (!shouldDigest(reply, limits)) return;
      if (!llm.configured(event.owner)) {
        ctx.health.report({
          level: 'warn',
          message: '检测到长回复，但摘要模型未配置，未生成摘要',
          hint: '请在插件设置里复用当前会话模型，或填写独立模型配置',
        });
        return;
      }

      const controller = new AbortController();
      // 默认只替换同 command 的 running 项，按 input 隔离以保留每轮摘要。
      const noticeOptions = {
        owner: event.owner,
        command: `${ctx.pluginId}:${event.input.id}`,
        variant: 'digest' as const,
      };
      const finish = (content: string, status: 'info' | 'warning') => {
        if (states.get(info.id) !== state) return;
        states.delete(info.id);
        // owner 可能已被 resume 到另一条会话，迟到结果不能写到新会话。
        if (session.describe(event.owner)?.id !== info.id) return;
        ui.notice(content, { ...noticeOptions, status });
      };
      const state: DigestState = {
        inputId: event.input.id,
        cancel: (message) => {
          finish(message, 'warning');
          controller.abort();
        },
      };
      states.set(info.id, state);
      ui.notice('正在整理这次长回复的重点，请稍候…', { ...noticeOptions, status: 'running' });
      void summarize(ctx, event, digestInput(reply, limits.inputLimit), limits.summaryLimit, controller.signal)
        .then((summary) => {
          if (controller.signal.aborted || disposed || states.get(info.id) !== state) return;
          finish(summary, 'info');
          ctx.health.report({ level: 'ok', message: '长回复摘要已生成' });
        })
        .catch((error) => {
          if (controller.signal.aborted || disposed || states.get(info.id) !== state) return;
          finish('摘要生成失败，未能生成摘要，原回复不受影响。请稍后重试或检查摘要模型配置。', 'warning');
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
          if (states.get(info.id) === state) states.delete(info.id);
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
): Promise<string> {
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
  return summary;
}

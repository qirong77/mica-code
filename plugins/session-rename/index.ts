import { pluginLogPath, type PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { buildTranscript, formatTranscript } from './transcript.js';
import {
  isTitleRequestConfigured,
  requestSessionTitle,
  sanitizeTitle,
  type TitleRequestConfig,
} from './titleRequest.js';

/** 与 `plugin.json` 里的 `prompt.default` 保持一致（有测试对账）。 */
export const DEFAULT_PROMPT = [
  '你在为一个编程助手会话起标题。',
  '只输出标题本身：一行、不超过 20 个字、不要引号、不要句号、不要 markdown。',
  '用中文概括这段对话在做什么，宁可具体（改哪个模块、修什么 bug），也不要空泛（如「代码讨论」「修复问题」）。',
].join('\n');

const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MIN_INTERVAL_SECONDS = 0;
const MAX_MESSAGES_LIMIT = 50;

type SessionRenameState = {
  running: boolean;
  lastAttemptAt: number;
};

/**
 * 自动重命名会话。
 *
 * 每轮**成功**结束后（`turn:after` + `completed`）把用户与助手的文本交给另一台模型，
 * 让它给出一个贴题的标题。几个刻意的取舍：
 *
 * - 不阻塞 turn：重命名是一次外部请求，`turn:after` 里只是发起，失败只记日志；
 * - 不覆盖用户的标题：`SessionController.renameCurrent(title, { source: 'auto' })` 在
 *   `titleSource === 'manual'` 时直接返回 false；
 * - 工具调用与结果不进 prompt（见 `transcript.ts`）：它们不是对话内容；
 * - 同一会话同时只跑一个请求，且遵守 `minIntervalSeconds`。
 */
export default function setup(ctx: PluginContext): void {
  const states = new Map<string, SessionRenameState>();

  const readConfig = (): TitleRequestConfig => {
    const values = ctx.settings.get();
    return {
      baseUrl: (values.baseUrl ?? '').trim(),
      apiKey: values.apiKey ?? '',
      protocol: parseProtocol(values.protocol),
      model: (values.model ?? '').trim(),
      prompt: (values.prompt ?? '').trim() || DEFAULT_PROMPT,
    };
  };

  const maxMessages = () => parseCount(ctx.settings.get().maxMessages, DEFAULT_MAX_MESSAGES, MAX_MESSAGES_LIMIT);
  const minIntervalMs = () => {
    const seconds = parseCount(ctx.settings.get().minIntervalSeconds, DEFAULT_MIN_INTERVAL_SECONDS, 24 * 60 * 60);
    return seconds * 1000;
  };

  ctx.logger.info('session-rename:setup', {
    settingsPath: ctx.settings.path,
    logPath: pluginLogPath(ctx.pluginId),
    config: describeConfig(readConfig()),
  });

  const renameNow = async (owner: unknown): Promise<string> => {
    const session = ctx.session;
    if (!session) throw new Error('插件运行环境没有提供会话接口');
    const config = readConfig();
    if (!isTitleRequestConfigured(config)) {
      throw new Error('未配置接口地址或模型：请在设置页填写后再试');
    }
    const info = session.describe(owner);
    if (!info) throw new Error('当前没有会话');
    const title = await rename({
      ctx,
      owner,
      sessionId: info.id,
      currentTitle: info.title,
      config,
      maxMessages: maxMessages(),
    });
    if (title === null) throw new Error('这次没有生成新标题（内容不足，或用户已手动命名）');
    return title;
  };

  const hookSubscription = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
    'turn:after',
    (event) => {
      // 只有正常结束的一轮才有「完整的问答」。中止或失败时助手的文本往往只是一半，
      // 拿它去起标题会把错误的印象固化进标题。
      if (event.outcome !== 'completed') return;
      const session = ctx.session;
      if (!session) return;

      const info = session.describe(event.owner);
      if (!info) return;
      if (info.titleSource === 'manual') {
        ctx.logger.info('session-rename:skip', { reason: 'manual-title', sessionId: info.id });
        return;
      }

      const config = readConfig();
      if (!isTitleRequestConfigured(config)) return;

      const state = states.get(info.id) ?? { running: false, lastAttemptAt: 0 };
      if (state.running) return;
      const interval = minIntervalMs();
      if (interval > 0 && Date.now() - state.lastAttemptAt < interval) return;

      states.set(info.id, { running: true, lastAttemptAt: Date.now() });
      // 不 await：这里只是发起，重命名失败绝不能拖住或打断 turn。
      void rename({
        ctx,
        owner: event.owner,
        sessionId: info.id,
        currentTitle: info.title,
        config,
        maxMessages: maxMessages(),
      })
        .catch((error: unknown) => {
          ctx.logger.warn('session-rename:failed', { sessionId: info.id, error: errorMessage(error) });
          return null;
        })
        .finally(() => {
          const current = states.get(info.id);
          if (current) states.set(info.id, { ...current, running: false });
        });
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => hookSubscription.dispose());

  const command = ctx.commands.register({
    name: 'session-rename',
    description: '手动触发一次自动重命名，或查看当前配置',
    completionItems: [
      { arg: 'now', description: '立刻按当前对话重新起标题' },
      { arg: 'status', description: '查看配置状态与日志位置' },
    ],
    scope: 'local-only',
    allowDuringTurn: false,
    pluginId: ctx.pluginId,
    handler: async (_commandCtx, args) => {
      const action = args.trim().toLowerCase();
      if (action === 'status' || !action) {
        const config = readConfig();
        const info = ctx.session?.describe();
        ctx.ui?.showMessage(
          [
            `配置：${describeConfig(config)}`,
            `会话：${info ? `${info.id}（titleSource: ${info.titleSource ?? 'derived'}）` : '无'}`,
            `设置文件：${ctx.settings.path ?? '不可用'}`,
            '日志：os.tmpdir()/mica-logs/plugin-session-rename-*.jsonl',
          ].join('\n'),
          8000,
        );
        return { ok: true };
      }
      if (action === 'now') {
        try {
          const title = await renameNow(undefined);
          ctx.ui?.showMessage(`已重命名：${title}`);
        } catch (error) {
          ctx.ui?.showMessage(`重命名失败：${errorMessage(error)}`);
        }
        return { ok: true };
      }
      ctx.ui?.showMessage('Usage: /session-rename [now|status]');
      return { ok: true };
    },
  });
  ctx.onDispose(() => command.dispose());
}

async function rename(input: {
  ctx: PluginContext;
  owner: unknown;
  sessionId: string;
  currentTitle: string;
  config: TitleRequestConfig;
  maxMessages: number;
}): Promise<string | null> {
  const { ctx, owner, sessionId, currentTitle, config, maxMessages } = input;
  const session = ctx.session;
  if (!session) return null;

  const entries = buildTranscript(session.messages(owner), { maxMessages });
  const hasUser = entries.some((entry) => entry.role === 'user');
  const hasAssistant = entries.some((entry) => entry.role === 'assistant');
  if (!hasUser || !hasAssistant) {
    ctx.logger.info('session-rename:skip', { reason: 'not-enough-conversation', sessionId, entries: entries.length });
    return null;
  }

  const startedAt = Date.now();
  ctx.logger.info('session-rename:request', {
    sessionId,
    entries: entries.length,
    chars: entries.reduce((total, entry) => total + entry.text.length, 0),
    model: config.model,
    protocol: config.protocol,
  });

  const { title: rawTitle, usage } = await requestSessionTitle(config, formatTranscript(entries));
  const title = sanitizeTitle(rawTitle);
  if (!title) {
    ctx.logger.warn('session-rename:empty-title', { sessionId, elapsedMs: Date.now() - startedAt });
    return null;
  }
  if (title === currentTitle) {
    ctx.logger.info('session-rename:unchanged', { sessionId, title });
    return title;
  }

  const renamed = session.rename(title, { owner, source: 'auto' });
  ctx.logger.info('session-rename:renamed', {
    sessionId,
    from: currentTitle,
    to: title,
    renamed,
    elapsedMs: Date.now() - startedAt,
    usage,
  });
  return renamed ? title : null;
}

function parseProtocol(value: string | undefined): ProviderProtocol {
  return value === 'openai_responses' ? 'openai_responses' : 'openai_chat_completions';
}

function parseCount(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/** 日志里永远不带 apiKey。 */
function describeConfig(config: TitleRequestConfig): string {
  return [
    `baseUrl=${config.baseUrl || '(空)'}`,
    `model=${config.model || '(空)'}`,
    `protocol=${config.protocol}`,
    `prompt=${config.prompt.length} 字`,
  ].join(' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

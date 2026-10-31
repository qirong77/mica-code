import { pluginLogPath, type PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import { buildTranscript, formatTitleInput, messageText } from './transcript.js';
import { requestSessionTitle, sanitizeTitle, type TitleRequestConfig } from './titleRequest.js';

/** 与 `plugin.json` 里的 `prompt.default` 保持一致（有测试对账）。 */
export const DEFAULT_PROMPT = [
  '你在为编程助手会话起标题，标题要概括用户最近一次提出的任务。',
  '输入分两段：对话记录用来理解上下文（改哪个模块、进行到哪一步），用户最新请求是标题的对象。',
  '先读对话记录，再按最新请求定标题；两者不一致时以最新请求为准，不要沿用上一轮的主题。',
  '最新请求太含糊（如「继续」「再改一下」）时，用上下文补全它真正指的事。',
  '只输出标题本身：一行、不超过 20 个字，不要引号、句号或 markdown。',
  '要具体：写清动作和对象（改哪个模块、修什么 bug），不要泛泛的类别（如「代码讨论」「修复问题」）。',
  '不要照抄用户原话里的寒暄、举例或粘贴的报错，只取其中的动作与目标。',
].join('\n');

const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MIN_INTERVAL_SECONDS = 0;
const MAX_MESSAGES_LIMIT = 50;

type SessionRenameState = {
  running: boolean;
  lastAttemptAt: number;
  /** 上次成功起标题用的「最新请求」：同一条请求不重复请求模型。 */
  lastRequestText: string;
};

/**
 * 自动重命名会话。
 *
 * 每轮**开始运行前**（`turn:before`）把最近的对话文本与本轮用户请求交给另一台模型，
 * 让它给出一个贴题的标题。几个刻意的取舍：
 *
 * - 不阻塞 turn：重命名是一次外部请求，`turn:before` 里只是发起，失败只记日志；
 * - 放在开始之前，是因为标题要在用户盯着这一轮跑的时候就有意义；放在结束之后，
 *   标题永远滞后一轮，用户看到的始终是上一件事的标题；
 * - 不覆盖用户的标题：`SessionController.renameCurrent(title, { source: 'auto' })` 在
 *   `titleSource === 'manual'` 时直接返回 false；
 * - 工具调用与结果不进 prompt（见 `transcript.ts`）：它们不是对话内容；
 * - 同一会话同时只跑一个请求，且遵守 `minIntervalSeconds`。
 */
export default function setup(ctx: PluginContext): void {
  const states = new Map<string, SessionRenameState>();
  /** 「配置不完整」只上报一次；用户补好配置后成功改名会把状态覆写成 ok。 */
  let notConfiguredReported = false;

  // 模型接口由 `ctx.llm` 负责（清单 `llm` 声明）：这里只剩提示词。
  const readConfig = (): TitleRequestConfig => ({
    prompt: (ctx.settings.get().prompt ?? '').trim() || DEFAULT_PROMPT,
  });
  /** 没配好就别发请求：`ctx.llm.request` 会抛错，但这里要提前给出可读的原因。 */
  const llmReady = () => ctx.llm?.configured() === true;

  const maxMessages = () => parseCount(ctx.settings.get().maxMessages, DEFAULT_MAX_MESSAGES, MAX_MESSAGES_LIMIT);
  const minIntervalMs = () => {
    const seconds = parseCount(ctx.settings.get().minIntervalSeconds, DEFAULT_MIN_INTERVAL_SECONDS, 24 * 60 * 60);
    return seconds * 1000;
  };

  ctx.logger.info('session-rename:setup', {
    settingsPath: ctx.settings.path,
    logPath: pluginLogPath(ctx.pluginId),
    config: describeConfig(ctx, readConfig()),
  });

  /**
   * 配置是否可用：与配置页保存时用的是同一套校验规则（`ctx.settings.validate()`），
   * 所以不会出现「页面说已保存、插件说不能用」。
   *
   * 不可用时**上报**而不是静默跳过：用户打开插件页就能看到「待配置 / 缺接口地址」，
   * 否则现象只是「开了插件但标题一直没变」，只能一路翻到 tmpdir 里查日志。
   */
  const configProblem = (): string | null => {
    const issues = ctx.settings.validate();
    if (issues.length > 0) {
      return `配置有问题：${issues.map((issue) => `${issue.key} ${issue.message}`).join('；')}`;
    }
    if (!llmReady()) return '模型接口未配置（接口地址与模型），自动改名不会运行';
    return null;
  };

  /** 返回这份配置能不能用；不能用时顺手把原因报到健康状态上。 */
  const reportConfigHealth = (): boolean => {
    const problem = configProblem();
    if (problem) {
      ctx.health.report({ level: 'warn', message: problem });
      return false;
    }
    return true;
  };

  const renameNow = async (owner: unknown): Promise<string> => {
    const session = ctx.session;
    if (!session) throw new Error('插件运行环境没有提供会话接口');
    const config = readConfig();
    if (!llmReady()) throw new Error('模型接口未配置：请到插件设置里填写接口地址与模型');
    const info = session.describe(owner);
    if (!info) throw new Error('当前没有会话');
    const title = await rename({
      ctx,
      sessionId: info.id,
      currentTitle: info.title,
      config,
      maxMessages: maxMessages(),
      // 手动触发时这一轮已经跑完，最后一条用户消息就在历史里。
      latestUserText: '',
    });
    if (title === null) throw new Error('这次没有生成新标题（内容不足，或用户已手动命名）');
    return title;
  };

  const hookSubscription = ctx.hooks.on<RuntimeTurnBeforeHookEvent>(
    'turn:before',
    (event) => {
      // 一次性运行（`mica exec`）不落会话、马上退出，生成的标题没有地方可留；
      // 默认复用会话模型之后它就成了实际的每日调用，更不该在这种宿主里白花一次。
      if (ctx.agent?.mode === 'one-shot') return;
      // 系统注入（compact 边界、插件通知）不是用户提的要求，拿它当标题依据只会得到
      // 一句内部文本。
      if (event.input.source === 'system') return;
      const session = ctx.session;
      if (!session) return;

      const info = session.describe();
      if (!info) return;
      if (info.titleSource === 'manual') {
        ctx.logger.info('session-rename:skip', { reason: 'manual-title', sessionId: info.id });
        return;
      }

      const config = readConfig();
      // 配置不完整时每轮都会走到这里：只在第一次上报，避免把健康文件刷成噪声。
      if (!llmReady()) {
        if (!notConfiguredReported) {
          notConfiguredReported = true;
          reportConfigHealth();
        }
        return;
      }

      const latestUserText = messageText(event.input.text ?? '');
      const state = states.get(info.id) ?? { running: false, lastAttemptAt: 0, lastRequestText: '' };
      if (state.running) return;
      // 同一条用户请求只起一次标题：`mica exec` 在一轮结束后会再补发一次 `turn:before`，
      // 重复请求既改不动标题，也白花一次调用。
      if (latestUserText && state.lastRequestText === latestUserText) return;
      const interval = minIntervalMs();
      if (interval > 0 && Date.now() - state.lastAttemptAt < interval) return;

      states.set(info.id, { ...state, running: true, lastAttemptAt: Date.now() });
      // 不 await：这里只是发起，重命名失败绝不能拖住或打断 turn。
      void (async () => {
        try {
          const title = await rename({
            ctx,
            sessionId: info.id,
            currentTitle: info.title,
            config,
            maxMessages: maxMessages(),
            latestUserText,
          });
          if (title === null) return;
          const current = states.get(info.id);
          if (current) states.set(info.id, { ...current, lastRequestText: latestUserText });
        } catch (error) {
          const message = errorMessage(error);
          ctx.logger.warn('session-rename:failed', {
            sessionId: info.id,
            reason: failureReason(message),
            error: message,
          });
          ctx.health.report({ level: 'error', message: `上次自动改名失败：${message}` });
        } finally {
          const current = states.get(info.id);
          if (current) states.set(info.id, { ...current, running: false });
        }
      })();
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
        const problem = configProblem();
        ctx.ui?.showMessage(
          [
            `配置：${describeConfig(ctx, config)}`,
            ...(problem ? [`问题：${problem}`] : []),
            `会话：${info ? `${info.id}（titleSource: ${info.titleSource ?? 'derived'}）` : '无'}`,
            `设置文件：${ctx.settings.path ?? '不可用'}`,
            `健康：${ctx.health.path ?? '不可用'}`,
            `日志：${pluginLogPath(ctx.pluginId)}`,
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
          ctx.health.report({ level: 'error', message: `手动改名失败：${errorMessage(error)}` });
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
  sessionId: string;
  currentTitle: string;
  config: TitleRequestConfig;
  maxMessages: number;
  latestUserText: string;
}): Promise<string | null> {
  const { ctx, sessionId, currentTitle, config, maxMessages, latestUserText } = input;
  const session = ctx.session;
  if (!session) return null;
  const llm = ctx.llm;
  if (!llm) throw new Error('插件运行环境没有提供模型接口（requires 里缺 llm）');

  const entries = buildTranscript(session.messages(), { maxMessages, latestUserText });
  if (!entries.some((entry) => entry.role === 'user')) {
    ctx.logger.info('session-rename:skip', { reason: 'not-enough-conversation', sessionId, entries: entries.length });
    return null;
  }

  const startedAt = Date.now();
  ctx.logger.info('session-rename:request', {
    sessionId,
    entries: entries.length,
    chars: entries.reduce((total, entry) => total + entry.text.length, 0),
    latestChars: latestUserText.length,
    llm: llm.describe(),
  });

  const { title: rawTitle, usage } = await requestSessionTitle(llm, config, formatTitleInput(entries));
  const title = sanitizeTitle(rawTitle);
  if (!title) {
    ctx.logger.warn('session-rename:empty-title', { sessionId, elapsedMs: Date.now() - startedAt });
    return null;
  }
  if (title === currentTitle) {
    ctx.logger.info('session-rename:unchanged', { sessionId, title });
    return title;
  }

  const renamed = session.rename(title, { source: 'auto' });
  // 成功一次就把「待配置 / 上次失败」的状态收回去，页面上不会一直挂着旧故障。
  if (renamed) ctx.health.report({ level: 'ok', message: `最近一次改名成功：${title}` });
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

function parseCount(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/** 日志里永远不带 apiKey。 */
function describeConfig(ctx: PluginContext, config: TitleRequestConfig): string {
  return [`llm=${ctx.llm?.describe() ?? '(不可用)'}`, `prompt=${config.prompt.length} 字`].join(' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失败分类：排查时先看 reason，不用逐句读错误文本。 */
function failureReason(message: string): 'timeout' | 'aborted' | 'request-failed' {
  if (message.includes('超时')) return 'timeout';
  if (message === 'aborted' || /abort/i.test(message)) return 'aborted';
  return 'request-failed';
}

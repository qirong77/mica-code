import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { Disposable } from '@packages/mica-common/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { pluginLogPath } from '@packages/mica-plugin/index.js';
import type { AgentObservationEvent } from '@packages/mica-plugin/AgentObservation.js';
import {
  CURATOR_SYSTEM_PROMPT,
  applyCuratorOperations,
  buildCuratorUserPrompt,
  createCuratorScopeResolver,
  parseCuratorNotes,
  parseCuratorOutput,
  type CuratorConversationMessage,
  type CuratorOperation,
} from './curator.js';
import { MemoryTool } from './MemoryTool.js';
import { requestCuratorCompletion } from './providers.js';
import { MemorySnapshotCache, formatMemorySection } from './section.js';
import { curatorReady, describeCurator, settingsFromValues, type MemorySettings } from './settings.js';
import { MEMORY_DIR_NAME, MemoryRepository } from './store.js';
import { contextScopes, resolveMemoryContext, scopeKey, type MemoryContext } from './scope.js';
import { TouchedRepoIndex, injectionRepos } from './activity.js';
import { resolveRepoIdentity } from './repo.js';
import { registerMemoryCommand, type MemoryReviewOutcome } from './commands.js';

/**
 * 记忆插件。
 *
 * 设计只有一句话：**先问「这条事实在哪些会话里还成立」，再决定存在哪、什么时候注入。**
 *
 * 三个作用域从宽到窄——`profile`（用户本人）、`domain`（一组同域仓库）、
 * `project`（一个仓库）。注入只给当前会话适用的那些：在 mica-code 里改桌面端时，
 * 租车领域的记忆一条都不出现；会话在 `~` 下打开时只有 profile。
 *
 * 注入、写入、整理各自独立：
 * - **注入**：`ctx.prompt.section()`，会话内冻结，避免记忆变化打掉 prompt cache；
 * - **写入**：`memory` 工具，默认最窄作用域，写成规则的东西进不来；
 * - **整理**：turn 结束后可选跑一次（宿主子代理或独立 provider），用三道测试过滤，
 *   并且不允许写 profile——全局画像只由用户在对话里明确要求时写入。
 */

const PLUGIN_ID = 'memory';
const CURATOR_SUBAGENT_TYPE = 'memory-curator';
const PROMPT_SECTION_ORDER = 900;
/**
 * 整理的最小输入：少于这么多条用户 / 助手消息就直接跳过。
 *
 * 「回复一句 ok」这种轮次没有可沉淀的内容，不该为它发一次模型请求。真实使用里
 * 一次有信息量的会话至少有四五个来回，取 8 条（约 4 轮）作为门槛。
 */
const MIN_CONVERSATION_MESSAGES = 8;

export default function setupMemory(ctx: PluginContext): void {
  const tools = ctx.tools;
  const prompt = ctx.prompt;
  if (!tools || !prompt) throw new Error('memory 需要宿主提供 tools 与 prompt 能力');

  const repository = new MemoryRepository({
    rootDir: join(ctx.paths?.config ?? resolveMicaHome(), MEMORY_DIR_NAME),
    resolveBudgets: () => readSettings(ctx).budgets,
  });

  /**
   * 作用域每次现场求值：会话可以 `/cd`，项目与领域应该跟着走。
   * 仓库身份在 `repo.ts` 里有进程内缓存，这里不做第二层。
   */
  const contextFor = (owner?: unknown): MemoryContext => {
    const described = ctx.session?.describe(owner);
    const cwd = described?.cwd ?? null;
    const key = described?.id ?? 'no-session';
    return resolveMemoryContext(repository.root, cwd, injectionRepos(touched.list(key), resolveRepoIdentity(cwd)));
  };

  const snapshots = new MemorySnapshotCache();
  const touched = new TouchedRepoIndex();
  const sessionKey = () => ctx.session?.describe()?.id ?? 'no-session';
  /**
   * 缓存签名：作用域变了才重读。只按会话缓存会在 `/cd` 之后继续注入上一个仓库的记忆；
   * 每轮都重读则会让记忆段落每轮抖动，打掉它前面所有内容的 prompt cache。
   */
  const signatureOf = (context: MemoryContext) =>
    [
      context.repo?.slug ?? 'no-repo',
      ...context.taskRepos.map((repo) => repo.slug).sort(),
      ...context.domains.map((domain) => domain.name).sort(),
    ].join('|');

  // primaryAgentOnly：记忆属于这条会话/用户，子代理写它会让归属变模糊
  // （临时发现未必长期成立），与 session-notes 同一取舍。
  let disposed = false;
  let active: AbortController | null = null;
  let tool: Disposable | undefined;
  const syncEnabled = () => {
    const enabled = !disposed && readSettings(ctx).enabled;
    if (enabled && !tool) {
      tool = tools.register(new MemoryTool(repository, contextFor, () => !disposed && readSettings(ctx).enabled), {
        icon: '🧠',
        primaryAgentOnly: true,
      });
    } else if (!enabled) {
      tool?.dispose();
      tool = undefined;
      active?.abort();
    }
    return enabled;
  };
  syncEnabled();
  ctx.onDispose(() => {
    disposed = true;
    active?.abort();
    tool?.dispose();
    touched.clear(sessionKey());
  });

  // order 900：记忆内容在会话内是冻结的，但仍然排在会话笔记（1000）之前，让最容易
  // 变化的那一段保持在最后。
  const section = prompt.section({
    id: 'memory',
    order: PROMPT_SECTION_ORDER,
    render: () => {
      if (!syncEnabled()) return '';
      const context = contextFor();
      const scopes = contextScopes(context);
      return formatMemorySection(
        snapshots.get(sessionKey(), signatureOf(context), { load: (list) => repository.snapshots(list) }, scopes),
      );
    },
  });
  ctx.onDispose(() => section.dispose());

  const curatorType = ctx.subagents?.registerType({
    name: CURATOR_SUBAGENT_TYPE,
    description:
      'Extract durable cross-session facts from a finished session, choosing the narrowest memory scope. Read-only, single turn, no context inheritance.',
    systemPrompt: CURATOR_SYSTEM_PROMPT,
    // 回答结束后的自动整理不是用户发起的委派：它照常记账，但不该让子代理 dock 闪一下。
    activity: 'maintenance',
    allowedTools: [],
    writeMode: 'none',
    contextModeDefault: 'none',
    effort: false,
    maxTurns: 1,
  });
  if (curatorType) ctx.onDispose(() => curatorType.dispose());

  let running = false;

  const runCurator = async (options: { manual: boolean; owner?: unknown }): Promise<MemoryReviewOutcome> => {
    if (running) return { ok: false, message: '记忆整理正在进行中，稍后再试。' };
    running = true;
    const controller = new AbortController();
    active = controller;
    let release: (() => void) | null = null;
    let attempted: MemorySettings | null = null;
    try {
      const settings = readSettings(ctx, options.owner);
      if (disposed || !settings.enabled) return { ok: false, message: '记忆已关闭。' };
      // 一次性运行（`mica exec`）没有「下一次会话」：整理只会多花一次模型调用，
      // 而且写下的记忆这次也用不上。
      if (ctx.agent?.mode === 'one-shot') {
        return { ok: true, message: '一次性运行不整理记忆。' };
      }
      if (!options.manual && !settings.autoCapture) {
        return { ok: true, message: '自动整理未开启。' };
      }

      release = repository.acquireCuratorLock();
      if (!release) return { ok: false, message: '其他会话正在整理记忆，稍后再试。' };
      const state = repository.readState();
      if (!options.manual && withinInterval(state.lastRunAt, settings.minIntervalMinutes)) {
        return { ok: true, message: '距上次整理还不到间隔，跳过。' };
      }

      const messages = collectConversation(
        ctx,
        options.owner,
        Math.max(MIN_CONVERSATION_MESSAGES, settings.maxMessages),
      );
      if (messages.length < MIN_CONVERSATION_MESSAGES) {
        return { ok: true, message: '对话太短，跳过整理。' };
      }

      // 绑定发起时的上下文：等待模型期间 `/cd` 不能把结果写到另一个仓库。
      const source = contextFor(options.owner);
      const scopes = contextScopes(source);
      const ensureActive = () => {
        const current = readSettings(ctx, options.owner);
        if (disposed || !current.enabled || (!options.manual && !current.autoCapture)) controller.abort();
        controller.signal.throwIfAborted();
      };
      // 发起付费请求前保留节流基线；取消、进程退出也不能让下次自动整理立即重发。
      repository.writeState({
        lastRunAt: new Date().toISOString(),
        lastMode: settings.curatorMode,
        lastApplied: 0,
        lastError: null,
      });
      attempted = settings;
      const requested = await requestOperations(
        ctx,
        settings,
        source,
        repository.snapshots(scopes),
        messages.slice(-settings.maxMessages),
        { owner: options.owner, signal: controller.signal, ensureActive },
      );
      ensureActive();
      if (!requested.ok) {
        repository.writeState({
          lastRunAt: new Date().toISOString(),
          lastMode: settings.curatorMode,
          lastApplied: 0,
          lastError: requested.error,
        });
        ctx.health.report({
          level: 'warn',
          message: `记忆整理失败：${requested.error}`,
          hint:
            settings.curatorMode === 'direct'
              ? '检查插件设置里的整理接口地址 / Key / 模型是否可用。'
              : '检查当前模型配置是否可用；也可以改用独立 provider。',
        });
        return { ok: false, message: `记忆整理失败：${requested.error}` };
      }

      const outcome = applyCuratorOperations(repository, createCuratorScopeResolver(source), requested.operations);
      const error = outcome.failures.map((failure) => `${failure.scope}: ${failure.message}`).join('；');
      repository.writeState({
        lastRunAt: new Date().toISOString(),
        lastMode: settings.curatorMode,
        lastApplied: outcome.applied,
        lastError: error || null,
      });

      if (error) {
        ctx.health.report({
          level: 'warn',
          message: `记忆整理有 ${outcome.failures.length} 项未能写入`,
          hint: `${error}（通常是 old_text 对不上或整层超出安全上限；下次整理会重新尝试）`,
        });
      } else if (outcome.applied > 0) {
        ctx.health.report({ level: 'ok', message: `记忆已更新：应用 ${outcome.applied} 条操作` });
      }

      const summary =
        outcome.applied > 0
          ? `记忆整理完成：应用 ${outcome.applied} 条操作${requested.skipped > 0 ? `（忽略 ${requested.skipped} 条非法操作）` : ''}。`
          : '记忆整理完成：这次没有值得保存的内容。';
      const detail = error ? `\n未能写入：${error}` : '';
      return { ok: !error, message: `${summary}${detail}` };
    } catch (error) {
      if (controller.signal.aborted) return { ok: true, message: '记忆整理已取消。' };
      const message = error instanceof Error ? error.message : String(error);
      if (attempted) {
        try {
          repository.writeState({
            lastRunAt: new Date().toISOString(),
            lastMode: attempted.curatorMode,
            lastApplied: 0,
            lastError: message,
          });
        } catch (stateError) {
          ctx.logger.warn('memory:state-write-failed', { error: String(stateError) });
        }
      }
      ctx.logger.warn('memory:curator-failed', { error: message });
      ctx.health.report({
        level: 'warn',
        message: `记忆整理出错：${message}`,
        hint: `查看插件日志（${pluginLogPath(ctx.pluginId)}）。`,
      });
      return { ok: false, message: `记忆整理出错：${message}` };
    } finally {
      release?.();
      active = null;
      running = false;
    }
  };

  const hook = ctx.hooks.on(
    'turn:after',
    (event) => {
      const payload = event as { outcome?: string; owner?: unknown } | null;
      if (!payload || payload.outcome !== 'completed') return;
      if (disposed) return;
      const settings = readSettings(ctx, payload.owner);
      if (!settings.enabled) return;
      if (!settings.autoCapture) return;
      // 不 await：整理要发一次模型请求，不能把 turn:after 后面的队列启动、
      // 下一轮输入都拖住。`running` 标志保证同一时间只有一个整理在跑。
      void runCurator({ manual: false, owner: payload.owner });
    },
    { pluginId: PLUGIN_ID },
  );
  ctx.onDispose(() => hook.dispose());

  /**
   * 「本次任务的目标仓库」靠工具调用认，而不是靠会话开窗的那条路径。
   *
   * 在 `mis` 里开会话去改 `sass`、在 `mica-code` 里改 `spring-cli` 都是真实用法；
   * 只按 cwd 归项目记忆，这些会话写下的东西会落进一个谁也不读的文件里。
   * 观察本身不落盘、不发请求，`agent:observe` 保证观察失败不会影响任务。
   */
  const observeHook = ctx.hooks.on<AgentObservationEvent>(
    'agent:observe',
    (event) => {
      if (disposed || event.type !== 'tool:call') return;
      if (!event.name || typeof event.args !== 'string') return;
      const sessionId = ctx.session?.describe(event.owner)?.id;
      if (!sessionId) return;
      touched.observe(sessionId, event.name, event.args);
    },
    { pluginId: PLUGIN_ID },
  );
  ctx.onDispose(() => observeHook.dispose());

  const command = registerMemoryCommand(ctx, {
    repository,
    context: () => contextFor(),
    refreshPrompt: () => snapshots.invalidate(sessionKey()),
    runReview: () => runCurator({ manual: true }),
    describeRuntime: () => describeRuntime(ctx, repository),
  });
  ctx.onDispose(() => command.dispose());

  reportStartupHealth(ctx, repository, contextFor);
  ctx.logger.info('memory:ready', { root: repository.root });
}

type CuratorRequestOutcome =
  | { ok: true; operations: CuratorOperation[]; skipped: number; notes: string | null }
  | { ok: false; error: string };

/**
 * 把一份 prompt 变成操作。
 *
 * 解析失败时再问一次，而不是直接放弃：真实模型偶尔会退回自己熟悉的另一套 schema
 * （Codex 的 `op` / `path` / `value`），而记忆整理本身没有第二次机会——下一次整理
 * 要等间隔到期。重试只带一句「上一条输出不可用」和严格的 schema。
 */
async function requestOperations(
  ctx: PluginContext,
  settings: MemorySettings,
  context: MemoryContext,
  snapshotList: ReturnType<MemoryRepository['snapshots']>,
  messages: CuratorConversationMessage[],
  options: { owner?: unknown; signal: AbortSignal; ensureActive(): void },
): Promise<CuratorRequestOutcome> {
  const user = buildCuratorUserPrompt({ snapshots: snapshotList, context: describeContext(context), messages });
  options.ensureActive();
  const first = await runCuratorPrompt(ctx, settings, user, options);
  options.ensureActive();
  if (first.ok) return logNotes(ctx, first);
  if (!first.retryable) return { ok: false, error: first.error };

  ctx.logger.warn('memory:curator-retry', { error: first.error });
  const correction = [
    user,
    '',
    '<correction>',
    `上一条回复无法使用：${first.error}`,
    first.raw ? `收到的内容：${first.raw.slice(0, 500)}` : '',
    '只输出一个 JSON 对象，字段名只能是 scope / domain / action / old_text / content。scope 只能是 project 或 domain。',
    '</correction>',
  ].join('\n');
  const second = await runCuratorPrompt(ctx, settings, correction, options);
  return second.ok ? logNotes(ctx, second) : { ok: false, error: second.error };
}

/** `notes` 是「没写进去、但该让用户知道」的一句话（多半是「这属于你的画像，要我记住吗」），落进插件日志，不进对话。 */
function logNotes(
  ctx: PluginContext,
  outcome: { ok: true; operations: CuratorOperation[]; skipped: number; notes: string | null },
): CuratorRequestOutcome {
  if (outcome.notes) ctx.logger.info('memory:curator-notes', { notes: outcome.notes });
  return outcome;
}

type CuratorAttempt =
  | { ok: true; operations: CuratorOperation[]; skipped: number; notes: string | null }
  | { ok: false; error: string; retryable: boolean; raw?: string };

async function runCuratorPrompt(
  ctx: PluginContext,
  settings: MemorySettings,
  user: string,
  options: { owner?: unknown; signal: AbortSignal },
): Promise<CuratorAttempt> {
  const settle = (text: string): CuratorAttempt => {
    const parsed = parseCuratorOutput(text);
    return parsed.ok
      ? { ...parsed, notes: parseCuratorNotes(text) }
      : { ok: false, error: parsed.error, retryable: true, raw: parsed.raw };
  };

  if (settings.curatorMode === 'direct') {
    const llm = ctx.llm;
    if (!llm || !llm.configured(options.owner)) {
      return {
        ok: false,
        retryable: false,
        error:
          '整理接口未配置完整：需要接口地址与模型名（插件设置 → Memory）；Key 填 ${ENV_VAR} 时该环境变量需要在启动 Mica 的进程里可见',
      };
    }
    return settle(
      await requestCuratorCompletion(llm, {
        system: CURATOR_SYSTEM_PROMPT,
        user,
        signal: options.signal,
        owner: options.owner,
      }),
    );
  }

  if (!ctx.subagents) {
    return {
      ok: false,
      retryable: false,
      error: '当前宿主不提供子代理能力；请把整理模式改成「独立接口」并填写 provider 配置',
    };
  }

  const result = await ctx.subagents.run({
    type: CURATOR_SUBAGENT_TYPE,
    description: 'Consolidate session memory',
    prompt: user,
    contextMode: 'none',
    maxTurns: 1,
    signal: options.signal,
    caller: { owner: options.owner },
  });
  // partial 也接受：整理子代理没有工具，partial 通常只是最后一句被截断，
  // 只要拿到了可解析的 JSON 就没必要整次丢掉。
  const usable = result.status === 'completed' || (result.status === 'partial' && Boolean(result.output.trim()));
  if (!usable) {
    return {
      ok: false,
      retryable: false,
      error: `整理子代理未完成（${result.status}）${result.error ? `：${result.error}` : ''}`,
    };
  }
  return settle(result.output);
}

function describeContext(context: MemoryContext): string {
  const lines: string[] = [];
  lines.push(
    context.repo
      ? `当前仓库：${context.repo.name}（${context.repo.remote ?? context.repo.root}）`
      : '当前目录不在任何 git 仓库里：只能写入已定义的领域，或什么都不写',
  );
  if (context.taskRepos.length > 0) {
    lines.push(
      `本次任务实际改的仓库：${context.taskRepos.map((repo) => repo.name).join(', ')}（会话开在别处，事实属于这些仓库时写它们）`,
    );
  }
  lines.push(context.cwd ? `工作目录：${context.cwd}` : '工作目录：未知');
  if (context.domains.length > 0) {
    lines.push(`命中当前目录的领域：${context.domains.map((domain) => domain.name).join(', ')}`);
  } else if (context.knownDomains.length > 0) {
    lines.push(
      `已定义但未命中当前目录的领域：${context.knownDomains.map((domain) => domain.name).join(', ')}（不要往里写）`,
    );
  } else {
    lines.push('没有定义任何领域');
  }
  return lines.join('\n');
}

/** 取最近若干条用户 / 助手消息；工具、notice、图片都不进整理输入。 */
function collectConversation(ctx: PluginContext, owner: unknown, maxMessages: number): CuratorConversationMessage[] {
  const raw = ctx.session?.messages(owner) ?? [];
  const messages: CuratorConversationMessage[] = [];
  for (let index = raw.length - 1; index >= 0 && messages.length < maxMessages; index -= 1) {
    const message = raw[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = extractText(message.content);
    if (!text.trim()) continue;
    messages.push({ role: message.role, content: text });
  }
  return messages.reverse();
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function withinInterval(lastRunAt: string | null, minutes: number): boolean {
  if (minutes <= 0) return false;
  const last = Date.parse(lastRunAt ?? '');
  if (!Number.isFinite(last)) return false;
  const elapsed = Date.now() - last;
  // 时钟回拨（elapsed < 0）不算在间隔内，否则会把整理永久停掉。
  return elapsed >= 0 && elapsed < minutes * 60_000;
}

function describeRuntime(ctx: PluginContext, repository: MemoryRepository): string {
  const settings = readSettings(ctx);
  const state = repository.readState();
  const lines = [describeCurator(settings, ctx.llm)];
  if (state.lastRunAt) {
    const failed = state.lastError ? ` · 上次失败：${state.lastError}` : '';
    // 节流是全局的（多个会话共用一份 state.json），所以这里标明，避免用户以为
    // 「这个会话从没整理过」。
    lines.push(`最近整理（全局）：${state.lastRunAt} · 应用 ${state.lastApplied} 条${failed}`);
  } else {
    lines.push('最近整理（全局）：从未');
  }
  return lines.join('\n');
}

function reportStartupHealth(ctx: PluginContext, repository: MemoryRepository, contextFor: () => MemoryContext): void {
  if (!readSettings(ctx).enabled) {
    ctx.health.report({ level: 'ok', message: '记忆已关闭：插件设置里的「启用记忆」关掉了' });
    return;
  }
  const issues = ctx.settings.validate();
  if (issues.length > 0) {
    ctx.health.report({
      level: 'warn',
      message: `配置不完整：${issues.map((issue) => `${issue.label} ${issue.message}`).join('；')}`,
      hint: '在配置页的 Plugins → Memory 里修正。',
    });
    return;
  }

  const settings = readSettings(ctx);
  const context = contextFor();
  const snapshots = repository.snapshots(contextScopes(context));
  const total = snapshots.reduce((sum, snapshot) => sum + snapshot.entries.length, 0);
  const usage = snapshots
    .map((snapshot) => `${scopeKey(snapshot.scope)} ${snapshot.chars}/${snapshot.budget}`)
    .join(' · ');

  if (settings.autoCapture && settings.curatorMode === 'direct' && !curatorReady(ctx.llm)) {
    ctx.health.report({
      level: 'warn',
      message: '自动整理已开启，但独立接口还没配置完整',
      hint: '填写接口地址、API Key 与模型名，或把整理模式改回「宿主子代理」。',
    });
    return;
  }

  ctx.health.report({
    level: 'ok',
    message: `记忆已就绪：本会话注入 ${snapshots.length} 层 · ${total} 条（${usage}）`,
    hint: describeCurator(settings, ctx.llm),
  });
}

/**
 * 生效设置按 owner 取：轮次结束触发的整理属于**发起它的那条会话**，
 * 期间用户切到别的会话不能改变这次整理用的模型或阈值。
 */
function readSettings(ctx: PluginContext, owner?: unknown): MemorySettings {
  const values = (ctx.sessionSettings?.get(owner) ?? ctx.settings.get()) as Record<string, string | undefined>;
  return settingsFromValues(values);
}

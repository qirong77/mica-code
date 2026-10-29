import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { pluginLogPath } from '@packages/mica-plugin/index.js';
import {
  CURATOR_SYSTEM_PROMPT,
  applyCuratorOperations,
  buildCuratorUserPrompt,
  parseCuratorOutput,
  type CuratorConversationMessage,
  type CuratorOperation,
} from './curator.js';
import { MemoryTool } from './MemoryTool.js';
import { requestCuratorCompletion } from './providers.js';
import { MemorySnapshotCache, formatMemorySection } from './section.js';
import { curatorReady, describeCurator, settingsFromValues, type MemorySettings } from './settings.js';
import { MEMORY_DIR_NAME, MemoryRepository } from './store.js';
import { registerMemoryCommand, type MemoryReviewOutcome } from './commands.js';

/**
 * 记忆插件。
 *
 * 三层记忆，按「谁的事实、活多久」切分，共用同一套存储与工具：
 *
 * - `user`：用户是谁、偏好如何（跨项目、跨会话）；
 * - `memory`：环境事实、工具坑、经验（跨项目）；
 * - `project`：当前工作区的约定、命令、决策（按工作目录归档）。
 *
 * 注入、写入、整理各自独立：
 * - **注入**：`ctx.prompt.section()`，会话内冻结，避免记忆变化打掉 prompt cache；
 * - **写入**：`memory` 工具，模型在对话中主动保存，预算写死、超限必须先整理；
 * - **整理**：turn 结束后可选跑一次（宿主子代理或独立 provider），把一轮对话收敛成
 *   几条操作。默认关闭：后台整理花的是模型的钱，不该因为装了插件就自动开始。
 */

const PLUGIN_ID = 'memory';
const CURATOR_SUBAGENT_TYPE = 'memory-curator';
const PROMPT_SECTION_ORDER = 900;
/**
 * 整理的最小输入：少于这么多条用户 / 助手消息就直接跳过。
 *
 * 2 条（一问一答）也会触发一次模型请求，而「回复一句 ok」这种轮次没有任何值得沉淀的
 * 内容——纯浪费。真实使用里一次有信息量的会话至少有四五个来回，取 8 条（约 4 轮）
 * 作为门槛，短对话不花钱，长对话照常整理。
 */
const MIN_CONVERSATION_MESSAGES = 8;

const plugin: MicaPlugin = {
  id: PLUGIN_ID,
  name: 'Memory',
  version: '1.0.0',
  priority: 150,
  required: false,

  setup(ctx: PluginContext) {
    const tools = ctx.tools;
    const prompt = ctx.prompt;
    if (!tools || !prompt) throw new Error('memory 需要宿主提供 tools 与 prompt 能力');

    const initial = readSettings(ctx);
    if (!initial.enabled) {
      ctx.health.report({ level: 'ok', message: '记忆已关闭：插件设置里的「启用记忆」关掉了' });
      return;
    }

    const repository = new MemoryRepository({
      rootDir: join(ctx.paths?.config ?? resolveMicaHome(), MEMORY_DIR_NAME),
      resolveBudgets: () => readSettings(ctx).budgets,
      // 会话可以 /cd：项目记忆跟着当前工作目录走，而不是进程启动时的目录。
      resolveProjectDir: () => ctx.session?.describe()?.cwd,
    });

    const snapshots = new MemorySnapshotCache();
    // 键只按会话：项目目录变化不能换键，否则整段缓存（含 user / memory）都会被重读，
    // 冻结就失效了。`/cd` 的处理在缓存内部——只换掉 project 那一块。
    const sessionKey = () => ctx.session?.describe()?.id ?? 'no-session';

    // primaryAgentOnly：记忆属于这条会话/用户，子代理写它会让归属变模糊
    // （临时发现未必长期成立），与 session-notes 同一取舍。
    const tool = tools.register(new MemoryTool(repository), { icon: '🧠', primaryAgentOnly: true });
    ctx.onDispose(() => tool.dispose());

    // order 900：记忆内容在会话内是冻结的，但仍然排在会话笔记（1000）之前，让最容易
    // 变化的那一段保持在最后。
    const section = prompt.section({
      id: 'memory',
      order: PROMPT_SECTION_ORDER,
      render: () =>
        formatMemorySection(
          snapshots.get(sessionKey(), repository.projectDir(), {
            loadAll: () => repository.snapshots(),
            loadTarget: (target) => repository.snapshot(target),
          }),
        ),
    });
    ctx.onDispose(() => section.dispose());

    const curatorType = ctx.subagents?.registerType({
      name: CURATOR_SUBAGENT_TYPE,
      description:
        'Consolidate a finished session into memory operations. Read-only, single turn, no context inheritance.',
      systemPrompt: CURATOR_SYSTEM_PROMPT,
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
      try {
        const settings = readSettings(ctx);
        // 一次性运行（`mica exec`）没有「下一次会话」：整理只会多花一次模型调用，
        // 而且写下的记忆这次也用不上。
        if (ctx.agent?.mode === 'one-shot') {
          return { ok: true, message: '一次性运行不整理记忆。' };
        }
        if (!options.manual && !settings.autoCapture) {
          return { ok: true, message: '自动整理未开启。' };
        }

        const state = repository.readState();
        if (!options.manual && withinInterval(state.lastRunAt, settings.minIntervalMinutes)) {
          return { ok: true, message: '距上次整理还不到间隔，跳过。' };
        }

        const messages = collectConversation(ctx, options.owner, settings.maxMessages);
        if (messages.length < MIN_CONVERSATION_MESSAGES) {
          return { ok: true, message: '对话太短，跳过整理。' };
        }

        const requested = await requestOperations(ctx, settings, repository.snapshots(), messages);
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

        const outcome = applyCuratorOperations(repository, requested.operations);
        const error = outcome.failures.map((failure) => `${failure.target}: ${failure.message}`).join('；');
        repository.writeState({
          lastRunAt: new Date().toISOString(),
          lastMode: settings.curatorMode,
          lastApplied: outcome.applied,
          lastError: error || null,
        });

        if (error) {
          ctx.health.report({
            level: 'warn',
            message: `记忆整理有 ${outcome.failures.length} 块未能写入`,
            hint: `${error}（通常是记忆写满或 old_text 对不上；下次整理会重新尝试）`,
          });
        } else if (outcome.applied > 0) {
          ctx.health.report({
            level: 'ok',
            message: `记忆已更新：应用 ${outcome.applied} 条操作`,
          });
        }

        const summary =
          outcome.applied > 0
            ? `记忆整理完成：应用 ${outcome.applied} 条操作${requested.skipped > 0 ? `（忽略 ${requested.skipped} 条非法操作）` : ''}。`
            : '记忆整理完成：这次没有需要保存的内容。';
        const detail = error ? `\n未能写入：${error}` : '';
        return { ok: !error, message: `${summary}${detail}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn('memory:curator-failed', { error: message });
        ctx.health.report({
          level: 'warn',
          message: `记忆整理出错：${message}`,
          hint: `查看插件日志（${pluginLogPath(ctx.pluginId)}）。`,
        });
        return { ok: false, message: `记忆整理出错：${message}` };
      } finally {
        running = false;
      }
    };

    const hook = ctx.hooks.on(
      'turn:after',
      (event) => {
        const payload = event as { outcome?: string; owner?: unknown } | null;
        if (!payload || payload.outcome !== 'completed') return;
        const settings = readSettings(ctx);
        if (!settings.autoCapture) return;
        // 不 await：整理要发一次模型请求，不能把 turn:after 后面的队列启动、
        // 下一轮输入都拖住。`running` 标志保证同一时间只有一个整理在跑。
        void runCurator({ manual: false, owner: payload.owner });
      },
      { pluginId: PLUGIN_ID },
    );
    ctx.onDispose(() => hook.dispose());

    const command = registerMemoryCommand(ctx, {
      repository,
      refreshPrompt: () => snapshots.invalidate(),
      runReview: () => runCurator({ manual: true }),
      describeRuntime: () => describeRuntime(ctx, repository),
    });
    ctx.onDispose(() => command.dispose());

    reportStartupHealth(ctx, repository);
    ctx.logger.info('memory:ready', { root: repository.root });
  },
};

type CuratorRequestOutcome =
  | { ok: true; operations: CuratorOperation[]; skipped: number }
  | { ok: false; error: string };

/**
 * 把一份 prompt 变成操作。
 *
 * 解析失败时再问一次，而不是直接放弃：真实模型偶尔会退回自己熟悉的另一套 schema
 * （Codex 的 `op` / `path` / `value`），而记忆整理本身没有第二次机会——下一次整理
 * 要等间隔到期。重试只带一句「上一条输出不可用」和严格的 schema，多花的这一次调用
 * 远小于丢掉一整轮纠正的代价。
 */
async function requestOperations(
  ctx: PluginContext,
  settings: MemorySettings,
  snapshotList: ReturnType<MemoryRepository['snapshots']>,
  messages: CuratorConversationMessage[],
): Promise<CuratorRequestOutcome> {
  const user = buildCuratorUserPrompt({ snapshots: snapshotList, messages });
  const first = await runCuratorPrompt(ctx, settings, user);
  if (first.ok || !first.retryable) return first;

  ctx.logger.warn('memory:curator-retry', { error: first.error });
  const correction = [
    user,
    '',
    '<correction>',
    `上一条回复无法使用：${first.error}`,
    first.raw ? `收到的内容：${first.raw.slice(0, 500)}` : '',
    '只输出一个 JSON 对象，字段名只能是 target / action / old_text / content。',
    '</correction>',
  ].join('\n');
  const second = await runCuratorPrompt(ctx, settings, correction);
  return second.ok ? second : { ok: false, error: second.error };
}

type CuratorAttempt =
  | (CuratorRequestOutcome & { ok: true })
  | { ok: false; error: string; retryable: boolean; raw?: string };

async function runCuratorPrompt(ctx: PluginContext, settings: MemorySettings, user: string): Promise<CuratorAttempt> {
  const settle = (text: string): CuratorAttempt => {
    const parsed = parseCuratorOutput(text);
    return parsed.ok ? parsed : { ok: false, error: parsed.error, retryable: true, raw: parsed.raw };
  };

  if (settings.curatorMode === 'direct') {
    const llm = ctx.llm;
    if (!llm || !curatorReady(llm)) {
      return {
        ok: false,
        retryable: false,
        error:
          '整理接口未配置完整：需要接口地址与模型名（插件设置 → Memory）；Key 填 ${ENV_VAR} 时该环境变量需要在启动 Mica 的进程里可见',
      };
    }
    return settle(await requestCuratorCompletion(llm, { system: CURATOR_SYSTEM_PROMPT, user }));
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

/** 取最近若干条用户 / 助手消息；工具、notice、图片都不进整理输入。 */
function collectConversation(ctx: PluginContext, owner: unknown, maxMessages: number): CuratorConversationMessage[] {
  const raw = ctx.session?.messages(owner) ?? [];
  const messages: CuratorConversationMessage[] = [];
  for (const message of raw) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = extractText(message.content);
    if (!text.trim()) continue;
    messages.push({ role: message.role, content: text });
  }
  return messages.slice(-Math.max(2, maxMessages));
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

function reportStartupHealth(ctx: PluginContext, repository: MemoryRepository): void {
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
  const snapshots = repository.snapshots();
  const total = snapshots.reduce((sum, snapshot) => sum + snapshot.entries.length, 0);
  const usage = snapshots.map((snapshot) => `${snapshot.target} ${snapshot.chars}/${snapshot.limit}`).join(' · ');

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
    message: `记忆已就绪：${total} 条（${usage}）`,
    hint: describeCurator(settings, ctx.llm),
  });
}

function readSettings(ctx: PluginContext): MemorySettings {
  return settingsFromValues(ctx.settings.get());
}

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}

export const MEMORY_PLUGIN_ID = PLUGIN_ID;

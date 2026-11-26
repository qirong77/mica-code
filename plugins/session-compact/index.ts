import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginContext,
  PluginIdleCompactOutcome,
  PluginTurnPrepareEvent,
} from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent, RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import { formatTokenCount } from '@packages/mica-common/format.js';
import type { OperationOutcome } from '@packages/mica-diagnostics/operation.js';
import {
  MAX_FAILURES,
  RESUME_DELAY_MS,
  RESUME_DISPLAY_TEXT,
  buildHandoffPrompt,
  buildResumePrompt,
  compactThreshold,
  findHandoffReply,
  handoffDisplayText,
  isAutoInput,
  isHandoffInput,
  isResumeInput,
  normalizeAutoCompactState,
  readAutoCompactSettings,
  shouldTrigger,
  type AutoCompactSettings,
  type AutoCompactState,
} from './autoCompact.js';

type CompactHistory = NonNullable<NonNullable<PluginContext['agent']>['compactIdleHistory']>;

/** 后台轮询的两档节奏：流水线在跑时 1s 一拍，空闲时慢一点别白唤醒。 */
const ACTIVE_TICK_MS = 1000;
const IDLE_TICK_MS = 15_000;
/** 交接轮迟迟不回来（消息丢了 / 被别的进程吃掉）就放弃这次流程。 */
const HANDOFF_TIMEOUT_MS = 30 * 60_000;

/** 这一轮被中止（或宿主在准备期取消）：不算压缩失败，不该往对话里写红条。 */
function isCancellation(error: unknown): boolean {
  return error instanceof Error && ['AbortError', 'AgentAbortError'].includes(error.name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失败后的退避：5s → 15s → 45s → 120s。 */
function retryDelayMs(failures: number): number {
  return Math.min(120_000, 5_000 * 3 ** Math.max(0, failures));
}

/**
 * 会话压缩：右键菜单手动压缩 + 上下文到阈值后的自动交接压缩。
 *
 * - 快速压缩：把历史里的工具过程聚合成一条占位调用（思考丢掉、图片换占位符）。
 *   不调模型、不丢轮次、不改对话正文，所以随手就能点一次。
 * - 模型压缩：把用户与助手的对话（不带工具调用与结果）交给模型写一段 checkpoint
 *   摘要，旧历史折成这段摘要加最近几轮。
 * - 自动压缩：最近一次请求的输入到阈值（默认 400K）时，以插件身份发一条「暂停并写
 *   交接文档」；那一轮结束后先快速压缩，估算仍高于模型压缩阈值（默认 100K）再做一次
 *   模型压缩，最后发「继续」照着交接文档接着做。
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
      issueKey: 'dependency:host',
      level: 'warn',
      message: '宿主没有提供会话历史压缩能力，会话压缩不可用',
      hint: '需要桌面端（mica app-server）启动的会话宿主',
    });
    return;
  }

  /* ------------------------------------------------------------ 设置与状态 */

  const settings = (): AutoCompactSettings => readAutoCompactSettings(ctx.settings?.get?.() ?? {});

  // 宿主没有会话状态时退回进程内的一份：压缩还能跑，只是进程重启后从头判断。
  let fallbackState: AutoCompactState = { phase: 'idle' };
  const readState = (): AutoCompactState =>
    normalizeAutoCompactState(ctx.sessionState?.get() ?? fallbackState);
  const writeState = (patch: Partial<AutoCompactState>): AutoCompactState => {
    const next: AutoCompactState = { ...readState(), ...patch };
    fallbackState = next;
    try {
      ctx.sessionState?.set(next);
    } catch (error) {
      ctx.logger.warn('compact.auto-state-failed', { message: errorMessage(error) });
    }
    return next;
  };

  // 进程重启时「等一轮消息回来」的阶段已经失去意义：那一轮要么没发出去，要么随旧进程
  // 结束了。回到 idle 让下一轮重新判断；'compact' 保留——压缩本身可以接着做。
  const initial = readState();
  if (initial.phase === 'handoff' || initial.phase === 'resume' || initial.phase === 'resuming') {
    writeState({ phase: 'idle', lastResult: '进程重启，放弃上一次未走完的自动压缩' });
  }

  const lastUsageTokens = (): number | null => {
    const usage = ctx.agent?.lastUsage?.();
    return usage && Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : null;
  };
  const windowSize = (): number | undefined => ctx.agent?.contextWindowSize;

  /** 宿主排队槽里已有的输入条数：有用户消息在排就先让它跑。 */
  const pendingQueued = (owner: unknown): number => {
    const queue = ctx.runtime?.queue;
    if (!queue) return 0;
    try {
      return queue.list((owner ?? {}) as object).length;
    } catch {
      return 0;
    }
  };

  const submit = async (text: string, displayText: string) => {
    const runtime = ctx.runtime;
    if (!runtime?.submit) return null;
    return runtime.submit(text, { source: 'plugin', displayText });
  };

  /** 最近一次非自动消息的轮次：压缩窗口里用户补发的那条会先到，这时不该再抢着继续。 */
  let lastForeignTurnAt = 0;
  let lastOwner: unknown;

  const notify = (content: string, status: 'running' | 'success' | 'warning' | 'error'): void => {
    ctx.ui?.notice(content, { status, variant: 'compact', command: 'auto-compact', replace: true });
  };

  const show = (tokens: number): string => formatTokenCount(tokens, { roundedThousands: true });

  /* ------------------------------------------------------------ 交接文档落盘 */

  /**
   * 把交接文档另存一份。
   *
   * 模型压缩会把对话正文折成摘要，交接文档本身就不在对话里了；用户要回看「当时到底交接
   * 了什么」只能靠这份文件。失败只记日志——存不下不该让压缩失败，也不该多一条红字。
   */
  const saveHandover = (reply: string, requestText: string, usageTokens: number | null): string | null => {
    const root = ctx.paths?.config;
    if (!root || !reply.trim()) return null;
    try {
      const directory = join(root, 'handovers');
      mkdirSync(directory, { recursive: true });
      const sessionId = ctx.session?.describe?.()?.id ?? 'session';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(directory, `${sessionId.replace(/[\\/]/g, '_')}-${stamp}.md`);
      const model = ctx.session?.describe?.()?.model;
      writeFileSync(
        file,
        [
          '# 自动压缩交接',
          '',
          `- 会话：${sessionId}`,
          `- 时间：${new Date().toISOString()}`,
          `- 上下文：${usageTokens ? formatTokenCount(usageTokens) : '未知'} tokens`,
          ...(model ? [`- 模型：${model}`] : []),
          '',
          '---',
          '',
          '## 交接要求',
          '',
          requestText,
          '',
          '---',
          '',
          reply.trim(),
          '',
        ].join('\n'),
        'utf-8',
      );
      return file;
    } catch (error) {
      ctx.logger.warn('compact.auto-handover-file-failed', { message: errorMessage(error) });
      return null;
    }
  };

  /* ------------------------------------------------------------ 发起交接 */

  /**
   * 发一条交接请求，把状态推到 `handoff`。
   *
   * 这是整条流水线唯一「强制插话」的地方：消息以插件身份提交，会作为一条用户消息落进
   * 对话，模型必须回答。排队槽被占时 submit 会失败（busy），我们退回 idle，等下一轮
   * 再看——不抢、不吞用户那条。
   */
  const startHandoff = async (): Promise<{ message: string } & OperationOutcome> => {
    if (!ctx.runtime?.submit) {
      return { outcome: 'declined', code: 'unavailable', message: '当前宿主不能往会话里发消息，交接压缩不可用' };
    }
    const state = readState();
    if (state.phase !== 'idle') {
      return { outcome: 'busy', code: 'in_progress', message: '这条会话已经在自动压缩流程里，等它走完' };
    }
    // 宿主的排队槽只有一个位置：已经排着一条时再提交会被静默丢掉，不如先让那条跑。
    if (pendingQueued(lastOwner) > 0) {
      return { outcome: 'busy', code: 'queue_full', message: '还有一条消息在排队，等它发出去再交接' };
    }
    const usageTokens = lastUsageTokens();
    if (!usageTokens) {
      return { outcome: 'declined', code: 'no_usage', message: '这条会话还没有发出过模型请求，没有可交接的上下文' };
    }
    const current = settings();
    const threshold = compactThreshold(current, windowSize());
    const text = buildHandoffPrompt({ usageTokens, thresholdTokens: threshold, contextWindowSize: windowSize() });
    const now = Date.now();
    // 新的一轮从「当前这次真实用量」重新算：上一轮留下的 compactedTokens / staleUsageTokens
    // 会把「现在有多大」说小（压缩后 lastUsage 不变，但那是上一轮的事）。
    writeState({
      phase: 'handoff',
      phaseAt: now,
      triggeredAt: now,
      userIntervened: false,
      compactedTokens: undefined,
      staleUsageTokens: undefined,
      attemptAt: undefined,
      lastResult: undefined,
    });
    const result = await submit(text, handoffDisplayText(usageTokens, threshold));
    if (!result || !result.ok) {
      const reason = result && !result.ok ? result.reason : 'unavailable';
      writeState({ phase: 'idle', lastResult: `交接请求没发出去（${reason}）` });
      ctx.logger.warn('compact.auto-handoff-failed', { reason, usageTokens });
      return {
        outcome: reason === 'busy' ? 'busy' : 'error',
        code: 'submit_failed',
        message: `交接请求没发出去（${reason}）`,
      };
    }
    ctx.logger.info('compact.auto-handoff', { usageTokens, threshold, queued: result.queued === true });
    return {
      outcome: 'success',
      code: 'handoff_started',
      message: '已发送交接请求：这一轮先写交接文档，结束后自动压缩，压完接着继续任务',
    };
  };

  /* ------------------------------------------------------------ 压缩两段 */

  const summarize = async (transcript: string, prompt: string): Promise<string> => {
    if (!ctx.llm) throw new Error('当前宿主没有模型接口');
    const result = await ctx.llm.request({
      purpose: '会话压缩摘要',
      system: prompt,
      user: transcript,
      timeoutMs: 120_000,
    });
    if (!result.text.trim()) throw new Error('摘要请求返回了空内容');
    return result.text;
  };

  const failCompaction = (state: AutoCompactState, error: unknown, step: string): void => {
    if (isCancellation(error)) return;
    const failures = (state.failures ?? 0) + 1;
    const message = errorMessage(error);
    ctx.logger.warn('compact.auto-failed', { step, message, failures });
    if (failures >= MAX_FAILURES) {
      writeState({ phase: 'idle', failures, phaseAt: Date.now(), lastResult: `${step}失败：${message}` });
      notify(`自动压缩连续失败 ${failures} 次，已暂停：${message}。可以手动压缩，或调低阈值。`, 'warning');
      return;
    }
    writeState({ phase: 'compact', failures, attemptAt: Date.now(), lastResult: `${step}失败：${message}` });
    notify(`自动压缩没做成（${step}）：${message}。稍后自动重试。`, 'warning');
  };

  /**
   * 压缩这一段：快速压缩 → 估算仍高于阈值再模型压缩。
   *
   * 两次都走 `compactIdleHistory`：宿主决定「现在能不能写」（turn lease、对齐磁盘），
   * 并开一个维护窗口让客户端把发送留在排队行。`busy` 不是错误，下一拍再试。
   */
  const compactNow = async (): Promise<void> => {
    const state = readState();
    if (state.phase !== 'compact') return;
    const current = settings();
    const now = Date.now();
    if (state.attemptAt !== undefined && now - state.attemptAt < retryDelayMs(state.failures ?? 0)) return;

    writeState({ attemptAt: now });
    const before = state.staleUsageTokens ?? lastUsageTokens() ?? 0;
    // 上一拍已经压过的结果优先：`lastUsage` 压完不变，拿它当余量会把「已经变小」看成没变。
    let after = state.compactedTokens ?? lastUsageTokens() ?? before;
    let quickApplied = false;
    let modelApplied = false;

    let quick: PluginIdleCompactOutcome;
    try {
      quick = await compact({
        mode: 'quick',
        afterApply: (result) => {
          writeState({ compactedTokens: result.afterTokens, staleUsageTokens: lastUsageTokens() ?? undefined });
        },
      });
    } catch (error) {
      failCompaction(state, error, '快速压缩');
      return;
    }
    if (quick.status === 'skipped' && quick.reason === 'busy') {
      writeState({ attemptAt: undefined });
      return;
    }
    if (quick.status === 'applied') {
      after = quick.afterTokens;
      quickApplied = true;
    }

    if (after > current.modelCompactThreshold) {
      // 摘要模型默认复用会话模型；真没配置就让宿主用它的摘要子代理——那也是内核自己的
      // 模型压缩路径，别把流水线卡在「先去配一个模型」上。
      const useOwnLlm = ctx.llm?.configured?.() === true;
      let model: PluginIdleCompactOutcome;
      try {
        model = await compact({
          mode: 'model',
          ...(useOwnLlm ? { summarize } : {}),
          afterApply: (result) => {
            writeState({ compactedTokens: result.afterTokens, staleUsageTokens: lastUsageTokens() ?? undefined });
          },
        });
      } catch (error) {
        failCompaction(state, error, '模型压缩');
        return;
      }
      if (model.status === 'skipped' && model.reason === 'busy') {
        writeState({ attemptAt: undefined });
        return;
      }
      if (model.status === 'applied') {
        after = model.afterTokens;
        modelApplied = true;
      }
    }

    const threshold = compactThreshold(current, windowSize());
    const failures = after >= threshold ? (state.failures ?? 0) + 1 : 0;
    const how = [quickApplied ? '快速压缩' : '快速压缩（无可清理内容）', ...(modelApplied ? ['模型压缩'] : [])].join(' + ');
    const next = writeState({
      phase: 'resume',
      phaseAt: Date.now(),
      attemptAt: undefined,
      compactedTokens: after,
      staleUsageTokens: lastUsageTokens() ?? state.staleUsageTokens,
      failures,
      runs: (state.runs ?? 0) + 1,
      lastResult: `${how}：${before} → ${after}`,
    });
    ctx.logger.info('compact.auto-applied', { before, after, quick: quickApplied, model: modelApplied, failures });

    if (failures >= MAX_FAILURES) {
      writeState({ phase: 'idle', lastResult: `压缩后仍在阈值以上（${after}）` });
      notify(
        `自动压缩做了 ${failures} 次，上下文仍在阈值以上（${show(after)}），已暂停；请手动模型压缩或调低阈值。`,
        'warning',
      );
      return;
    }

    const lines = [`自动压缩完成：${show(before)} → ${show(after)}（${how}）`];
    if (!current.autoResume || next.userIntervened) {
      // 用户已经接手这条会话：压缩照做，但不再替他发「继续」。
      writeState({ phase: 'idle' });
      lines.push('你已经在继续对话，不再自动接着跑。');
    }
    notify(lines.join('\n'), 'success');
  };

  /* ------------------------------------------------------------ 压缩完继续 */

  const sendResume = async (): Promise<void> => {
    const state = readState();
    if (state.phase !== 'resume') return;
    const current = settings();
    if (!current.autoResume || state.userIntervened) {
      writeState({ phase: 'idle', phaseAt: Date.now(), lastResult: '不自动继续（设置或用户已介入）' });
      return;
    }
    const now = Date.now();
    if (now - (state.phaseAt ?? 0) < RESUME_DELAY_MS) return;
    // 一直 busy（另一个窗口持锁）时别每拍都戳一次；也给自己一个放弃的时刻。
    if (state.phaseAt !== undefined && now - state.phaseAt > HANDOFF_TIMEOUT_MS) {
      writeState({ phase: 'idle', lastResult: '继续指令一直没有送出，放弃自动继续' });
      return;
    }
    if (state.attemptAt !== undefined && now - state.attemptAt < 5_000) return;
    // 压缩窗口结束后用户自己补发了一条：这一轮已经由他接手，不要再塞一条「继续」。
    if (lastForeignTurnAt > (state.phaseAt ?? 0)) {
      writeState({ phase: 'idle', phaseAt: now, lastResult: '用户已接着发消息，不自动继续' });
      return;
    }
    if (pendingQueued(lastOwner) > 0) return;

    const afterTokens = state.compactedTokens ?? 0;
    const text = buildResumePrompt({ beforeTokens: state.staleUsageTokens ?? afterTokens, afterTokens });
    writeState({ attemptAt: now });
    const result = await submit(text, RESUME_DISPLAY_TEXT);
    if (!result) {
      writeState({ phase: 'idle', phaseAt: now, lastResult: '宿主没有提交入口，不自动继续' });
      return;
    }
    if (!result.ok) {
      // busy：会话刚被别的输入占住，下一拍再看；其它原因重试也没意义。
      if (result.reason === 'busy') return;
      writeState({ phase: 'idle', phaseAt: now, lastResult: `继续指令没发出去（${result.reason}）` });
      ctx.logger.warn('compact.auto-resume-failed', { reason: result.reason });
      return;
    }
    writeState({ phase: 'resuming', phaseAt: now, lastResult: '已发出继续指令' });
    ctx.logger.info('compact.auto-resume', { afterTokens, queued: result.queued === true });
  };

  /* ------------------------------------------------------------ 后台一拍 */

  const tick = async (): Promise<void> => {
    const state = readState();
    if (state.phase === 'compact') {
      await compactNow();
      return;
    }
    if (state.phase === 'resume') {
      await sendResume();
      return;
    }
    if (state.phase === 'handoff' || state.phase === 'resuming') {
      if (Date.now() - (state.phaseAt ?? 0) > HANDOFF_TIMEOUT_MS) {
        writeState({ phase: 'idle', lastResult: `${state.phase} 阶段超时` });
      }
    }
  };

  const background = ctx.background?.register({
    id: 'auto-compact',
    immediate: true,
    every: () => {
      const phase = readState().phase;
      return phase === 'compact' || phase === 'resume' ? ACTIVE_TICK_MS : IDLE_TICK_MS;
    },
    run: async () => {
      try {
        await tick();
      } catch (error) {
        if (!isCancellation(error)) ctx.logger.warn('compact.auto-tick-failed', { message: errorMessage(error) });
      }
    },
  });
  if (background) ctx.onDispose(() => background.dispose());

  /* ------------------------------------------------------------ 轮次钩子 */

  const onTurnBefore = ctx.hooks.on<RuntimeTurnBeforeHookEvent>('turn:before', (event) => {
    lastOwner = event.owner ?? lastOwner;
    if (isAutoInput(event.input)) return;
    lastForeignTurnAt = Date.now();
    const state = readState();
    if (state.phase === 'idle') return;
    // 流水线跑到一半用户插话了：压缩照做，但压完不要再自动「继续」。
    if (!state.userIntervened) {
      writeState({ userIntervened: true });
      ctx.logger.info('compact.auto-user-intervened', { phase: state.phase, source: event.input.source });
    }
  });
  ctx.onDispose(() => onTurnBefore.dispose());

  const onTurnAfter = ctx.hooks.on<RuntimeTurnAfterHookEvent>('turn:after', async (event) => {
    lastOwner = event.owner ?? lastOwner;
    const text = event.input.text;

    if (isHandoffInput(event.input)) {
      if (event.outcome !== 'completed') {
        writeState({ phase: 'idle', phaseAt: Date.now(), lastResult: `交接轮 ${event.outcome}` });
        notify('自动压缩已取消：交接那一轮没有正常结束。上下文仍然很大，可以稍后手动压缩。', 'warning');
        return;
      }
      const current = settings();
      const reply = findHandoffReply(ctx.session?.messages?.() ?? [], text);
      const usageTokens = lastUsageTokens();
      const file = current.saveHandover ? saveHandover(reply, text, usageTokens) : null;
      writeState({ phase: 'compact', phaseAt: Date.now(), attemptAt: undefined, lastResult: '交接完成，等待压缩' });
      const lines = ['交接文档已写好，开始压缩…'];
      if (file) lines.push(`已另存：${file}`);
      notify(lines.join('\n'), 'running');
      return;
    }

    if (isResumeInput(event.input)) {
      if (readState().phase === 'resuming') {
        writeState({ phase: 'idle', phaseAt: Date.now(), lastResult: `继续轮 ${event.outcome}` });
      }
      return;
    }

    if (event.outcome !== 'completed') return;
    if (ctx.agent?.mode === 'one-shot') return;

    // 连续失败会把自动压缩关掉；上下文既然已经回到阈值以下（多半是手动压过），重新启用。
    const before = readState();
    const usageNow = lastUsageTokens();
    if (before.phase === 'idle' && (before.failures ?? 0) > 0 && usageNow !== null) {
      if (usageNow < compactThreshold(settings(), windowSize())) {
        writeState({ failures: 0, lastResult: '上下文已回到阈值以下，重新启用自动压缩' });
      }
    }

    const decision = shouldTrigger({
      settings: settings(),
      state: readState(),
      usage: ctx.agent?.lastUsage?.() ?? null,
      contextWindowSize: windowSize(),
      queued: pendingQueued(event.owner),
      now: Date.now(),
    });
    if (!decision.trigger) {
      if (decision.reason !== 'disabled' && decision.reason !== 'below-threshold') {
        ctx.logger.info('compact.auto-skip', { reason: decision.reason });
      }
      return;
    }
    await startHandoff();
  });
  ctx.onDispose(() => onTurnAfter.dispose());

  /* ------------------------------------------------------------ 轮前压缩 */

  const prepare = ctx.hooks.on<PluginTurnPrepareEvent>('turn:prepare', async ({ previous, current, compactHistory }) => {
    if (previous.providerId === current.providerId && previous.model === current.model) return;
    try {
      const outcome = await compactHistory({ mode: 'quick' });
      // 轮前这条路没有菜单可以回话：跳过（干净的会话、纯对话会话）是常态，留一行日志就
      // 够，别往对话里塞噪音；压掉了多少也记在这里，事后能对上「这一轮为什么变小了」。
      ctx.logger.info('compact.turn-prepare', {
        status: outcome.status,
        ...(outcome.status === 'skipped' ? { reason: outcome.reason } : { savedTokens: outcome.savedTokens }),
      });
    } catch (error) {
      // 压缩失败只提示、不牵动这一轮（宿主的 failPolicy 也会吞掉异常，那样连原因都看不见）。
      // 中止属于这一轮自己的事，不是压缩失败。
      if (isCancellation(error)) return;
      const message = errorMessage(error);
      ctx.logger.warn('compact.turn-prepare-failed', { message });
      ctx.ui?.notice(`切换模型后的自动快速压缩没做成：${message}。这一轮照常发送。`, {
        status: 'warning',
        variant: 'compact',
      });
    }
  });
  ctx.onDispose(() => prepare.dispose());

  /* ------------------------------------------------------------ 菜单 */

  menu({
    run({ action }) {
      if (action === 'quick') return quick(compact);
      if (action === 'model') return model(ctx, compact);
      if (action === 'handoff') return startHandoff();
      return { outcome: 'declined' as const, code: 'unknown_action', message: `未知动作：${action}` };
    },
  });

  const autoReady = Boolean(ctx.runtime?.submit && ctx.background);
  ctx.health.report({
    issueKey: 'dependency:host',
    level: autoReady ? 'ok' : 'warn',
    message: autoReady
      ? '会话压缩已就绪：右键可压缩，上下文到阈值会自动交接并压缩'
      : '手动压缩可用；自动压缩需要宿主提供提交入口与后台调度',
    ...(autoReady ? {} : { hint: '自动压缩只在桌面端（mica app-server）的常驻会话里生效' }),
  });
}

function quick(compact: CompactHistory) {
  return report(() => compact({ mode: 'quick' }), '快速压缩', '没有可清理的工具结果');
}

async function model(ctx: PluginContext, compact: CompactHistory) {
  const llm = ctx.llm;
  if (!llm) return { outcome: 'declined' as const, code: 'unavailable', message: '当前宿主没有模型接口，模型压缩不可用' };
  if (!llm.configured())
    return { outcome: 'declined' as const, code: 'unconfigured', message: '压缩摘要模型未配置：在插件设置里复用当前会话模型，或填写接口地址与模型' };
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
  return report(
    () => compact({ mode: 'model', summarize }),
    '模型压缩',
    '当前没有可压缩的历史，或压缩后预计不会节省上下文',
  );
}

/** 菜单动作没有别的地方可以说结果，这里的一句话就是全部反馈。 */
async function report(
  run: () => ReturnType<CompactHistory>,
  label: string,
  emptyMessage: string,
): Promise<{ message: string } & OperationOutcome> {
  let outcome;
  try {
    outcome = await run();
  } catch (error) {
    const cancelled = isCancellation(error);
    return { outcome: cancelled ? 'cancelled' : 'error', code: cancelled ? 'aborted' : 'compact_failed', message: `${label}失败：${errorMessage(error)}` };
  }
  if (outcome.status === 'skipped')
    return { outcome: outcome.reason === 'busy' ? 'busy' : 'skipped', code: outcome.reason === 'busy' ? 'session_busy' : 'empty', message: outcome.reason === 'busy' ? '这条会话正忙，等这一轮结束再压' : emptyMessage };
  const show = (tokens: number) => formatTokenCount(tokens, { roundedThousands: true });
  // 压缩前的数字锚在会话上一次真实请求上，误差不到 1%；压缩后的余量只能从「清掉多少」反推，
  // 一次压掉七八成时它同时含固定开销（提示词 + 工具定义，每条会话 16k~40k）的估算偏差，
  // 所以标成「约」，把实测更稳的清掉量单独写出来。
  return {
    outcome: 'success', code: 'applied',
    message: `${label}完成：${show(outcome.beforeTokens)} → 约 ${show(outcome.afterTokens)}（清掉 ${show(outcome.savedTokens)}）`,
  };
}

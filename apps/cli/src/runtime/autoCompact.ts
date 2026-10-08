import { recordSubagentTaskUsage } from '@packages/mica-agent/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';

/**
 * 自动压缩：每完成一次模型请求（工具迭代边界）检查一次上下文占用，超过阈值就在
 * 「这次请求已经结束、下一次请求还没发出」的间隙把历史压小，而不是等整个 turn
 * 跑完——长任务里 turn 可能还要跑几十次请求，等到结束再压缩等于整段都在为膨胀的
 * 上下文付费。
 *
 * 两条规则（阈值与次数都由调用方下发，默认值在 AUTO_COMPACT_DEFAULTS）：
 * - 快速压缩：ctx ≥ quickThresholdK 且已运行次数 < quickLimit，本地把工具结果 /
 *   工具参数正文 / 媒体块换成占位符（不调用模型、不丢轮次）。
 * - 模型压缩：ctx 仍 ≥ modelThresholdK 且已运行次数 < modelLimit，调用模型生成
 *   checkpoint 摘要。
 *
 * 次序固定是「先快速、后模型」——快速压缩是模型压缩的前置步骤，只要这次确实要压就
 * 先跑一遍本地清理：ctx 到了快速阈值就单独跑一次；ctx 只到模型阈值（默认
 * modelThresholdK(120) < quickThresholdK(200)）时也先跑一次本地清理，清完仍高于
 * 模型阈值才升级为模型压缩——本地清理清不掉的内容才值得花一次模型请求。
 *
 * 这个模块只负责策略与计数；真正的重写由 provider loop 的
 * `rewriteIterationMessages` 钩子落地（见 packages/mica-agent/core/Agent.ts），因为
 * 迭代循环持有自己的消息数组，改 client 快照影响不到本 turn 剩下的请求。
 *
 * 压缩只改「发给模型的那份历史」：会话文件里的 conversationMessages（用户看到的
 * 对话）保持完整。渲染层的转写靠事件流绘制，turn 进行中没有任何安全的「历史替换」
 * 时机（mica/sessionHistory/replaced 会直接结束当前的流式回答），所以自动压缩不在
 * 中途回改对话展示——重开会话看到的仍是用户当时看到的完整对话，而 Stats 的上下文
 * 分解读的是 snapshot.messages，依旧反映压缩后的真实占用。
 *
 * **未收到宿主参数时一律不压缩**（`configured` 为 false）：`mica exec`、Terminal-Bench /
 * Harbor 这类 codex-family driver 只发 Codex 原生参数，不会带 `autoCompact`，它们的行为
 * 必须与今天完全一致——自动压缩会额外产生模型摘要请求，不能悄悄改变基准测试的成本与结果。
 * 桌面端每个 turn 都会显式下发设置（默认 enabled: true），所以那里是默认开启的。
 */

export type AutoCompactSettings = {
  enabled: boolean;
  quickThresholdK: number;
  quickLimit: number;
  modelThresholdK: number;
  modelLimit: number;
};

export type AutoCompactCounters = {
  quickRuns: number;
  modelRuns: number;
  lastRunAt: string | null;
  lastKind: 'quick' | 'model' | null;
  lastSavedTokens: number;
  lastNote: string | null;
};

/** `turn/start` 扩展参数：设置 + 本会话已运行次数（计数由宿主持久化）。 */
export type AutoCompactTurnParams = AutoCompactSettings & {
  quickRuns: number;
  modelRuns: number;
};

export const AUTO_COMPACT_DEFAULTS: AutoCompactSettings = {
  enabled: true,
  quickThresholdK: 200,
  quickLimit: 3,
  modelThresholdK: 120,
  modelLimit: 3,
};

export const AUTO_COMPACT_MAX_THRESHOLD_K = 10_000;
export const AUTO_COMPACT_MAX_LIMIT = 999;
const MAX_RUNS = 1_000_000;

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

export function emptyAutoCompactCounters(): AutoCompactCounters {
  return { quickRuns: 0, modelRuns: 0, lastRunAt: null, lastKind: null, lastSavedTokens: 0, lastNote: null };
}

export function normalizeAutoCompactSettings(input: unknown): AutoCompactSettings {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : AUTO_COMPACT_DEFAULTS.enabled,
    quickThresholdK: clampInteger(
      source.quickThresholdK,
      1,
      AUTO_COMPACT_MAX_THRESHOLD_K,
      AUTO_COMPACT_DEFAULTS.quickThresholdK,
    ),
    quickLimit: clampInteger(source.quickLimit, 0, AUTO_COMPACT_MAX_LIMIT, AUTO_COMPACT_DEFAULTS.quickLimit),
    modelThresholdK: clampInteger(
      source.modelThresholdK,
      1,
      AUTO_COMPACT_MAX_THRESHOLD_K,
      AUTO_COMPACT_DEFAULTS.modelThresholdK,
    ),
    modelLimit: clampInteger(source.modelLimit, 0, AUTO_COMPACT_MAX_LIMIT, AUTO_COMPACT_DEFAULTS.modelLimit),
  };
}

export function normalizeAutoCompactTurnParams(input: unknown): AutoCompactTurnParams {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    ...normalizeAutoCompactSettings(source),
    quickRuns: clampInteger(source.quickRuns, 0, MAX_RUNS, 0),
    modelRuns: clampInteger(source.modelRuns, 0, MAX_RUNS, 0),
  };
}

export type AutoCompactStep = 'quick' | 'model';

/**
 * 纯决策：给定当前 ctx 与已运行次数，决定这次请求结束后要不要压缩、压哪一种。
 *
 * 快速压缩同时是模型压缩的前置步骤，所以「模型压缩到期」本身就足以触发一次快速
 * 压缩：ctx 落在两个阈值之间时是「快速压缩 →（仍高于模型阈值）模型压缩」两步，
 * 而不是直接跳到模型压缩。升级判定在调用方（`rewriteIterationMessages`）按压缩后
 * 的 ctx 做。
 */
export function decideAutoCompactStep(input: {
  settings: AutoCompactSettings;
  counters: Pick<AutoCompactCounters, 'quickRuns' | 'modelRuns'>;
  ctxTokens: number;
}): AutoCompactStep | null {
  const { settings, counters, ctxTokens } = input;
  if (!settings.enabled) return null;
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) return null;
  const modelDue = counters.modelRuns < settings.modelLimit && ctxTokens >= settings.modelThresholdK * 1000;
  if (counters.quickRuns < settings.quickLimit && (ctxTokens >= settings.quickThresholdK * 1000 || modelDue)) {
    return 'quick';
  }
  if (modelDue) return 'model';
  return null;
}

export type AutoCompactControllerOptions = {
  agent: AgentRuntime;
  /** 计数变化时回调（宿主据此落盘并推给页面）。 */
  onStatus?: (counters: AutoCompactCounters) => void;
};

type CompactOutcome = { messages: unknown[]; savedTokens: number; kind: AutoCompactStep } | null;

/**
 * 会话级的自动压缩状态机。宿主（`mica app-server`）在 `turn/start` 时下发设置与
 * 计数，控制器在 provider 迭代边界做决策并应用，然后回报计数。
 */
export class AutoCompactController {
  private readonly options: AutoCompactControllerOptions;
  private settings: AutoCompactSettings = { ...AUTO_COMPACT_DEFAULTS };
  private counters: AutoCompactCounters = emptyAutoCompactCounters();
  /**
   * 宿主是否下发过设置。没有下发的调用方（`mica exec`、codex-family driver）必须保持
   * 既有行为，所以默认不压缩，而不只是「默认用默认值压缩」。
   */
  private configured = false;
  /** 已经处理过的那次请求（usageId），避免同一请求被重复判断。 */
  private lastUsageKey: string | null = null;
  /** 上次回推过的 lastNote：同一句说明只推一次，不随迭代边界重复刷 stdout。 */
  private notifiedNote: string | null = null;

  constructor(options: AutoCompactControllerOptions) {
    this.options = options;
  }

  /** 每个 turn 开始时由宿主下发：设置 + 该会话累计的运行次数。 */
  setParams(input: unknown): AutoCompactTurnParams {
    const params = normalizeAutoCompactTurnParams(input);
    this.configured = true;
    this.settings = {
      enabled: params.enabled,
      quickThresholdK: params.quickThresholdK,
      quickLimit: params.quickLimit,
      modelThresholdK: params.modelThresholdK,
      modelLimit: params.modelLimit,
    };
    this.counters = { ...this.counters, quickRuns: params.quickRuns, modelRuns: params.modelRuns };
    // 新一轮的第一个请求也是一次新的请求，必须重新判断（计数、ctx 都可能变了）。
    this.lastUsageKey = null;
    return params;
  }

  getSettings(): AutoCompactSettings {
    return { ...this.settings };
  }

  getCounters(): AutoCompactCounters {
    return { ...this.counters };
  }

  /**
   * provider 的迭代边界钩子。返回 null 表示不改变历史（调用方继续用原数组）。
   * 任何失败都必须吞掉：一次压缩失败不能把正在跑的 turn 弄挂。
   */
  async rewriteIterationMessages(messages: unknown[]): Promise<unknown[] | null> {
    const usage = this.options.agent.getSnapshot().lastUsage;
    if (!usage) return null;
    const usageKey = usage.usageId ?? `${usage.turnId}:${usage.requestIndex}`;
    if (usageKey === this.lastUsageKey) return null;
    this.lastUsageKey = usageKey;
    if (!this.configured || !this.settings.enabled) return null;

    let ctxTokens = Number(usage.inputTokens) || 0;
    let step = decideAutoCompactStep({ settings: this.settings, counters: this.counters, ctxTokens });
    if (!step) return null;

    let next = messages;
    if (step === 'quick') {
      const quick = await this.runQuick(next);
      if (quick) {
        next = quick.messages;
        ctxTokens = Math.max(0, ctxTokens - quick.savedTokens);
      }
      // 快速压缩之后仍然高于模型阈值（默认 120k < 200k，这正是「压缩没压够」的
      // 情形）才升级为模型压缩；已经压到阈值以下就不再花一次模型请求。快速压缩
      // 失败或没有可清理内容时 ctx 不变，这里同样按原 ctx 判定，不会因为它没生效
      // 就把这次模型压缩吞掉。
      if (
        ctxTokens >= this.settings.modelThresholdK * 1000 &&
        this.counters.modelRuns < this.settings.modelLimit
      ) {
        step = 'model';
      } else {
        step = null;
      }
    }
    if (step === 'model') {
      const model = await this.runModel(next);
      if (model) next = model.messages;
    }

    // 只在真的有话要说时回推：一次「没有可清理内容」的尝试会被每个迭代边界重复命中，
    // 每次都推一遍纯属噪音（宿主也会因为值没变而丢弃，但 stdout 已经白写了）。
    if (next !== messages || this.counters.lastNote !== this.notifiedNote) {
      this.notifiedNote = this.counters.lastNote;
      this.options.onStatus?.(this.getCounters());
    }
    if (next === messages) return null;
    return next;
  }

  private async runQuick(messages: unknown[]): Promise<CompactOutcome> {
    const service = new micaContext.CompactionService();
    try {
      // 纯本地替换，不需要 summarize（CompactionService 的 toolResultsOnly 路径
      // 不会调用模型）。
      const result = await service.compact({ messages, options: { toolResultsOnly: true } });
      this.counters.quickRuns += 1;
      this.recordRun('quick', result.savedTokenEstimate, null);
      return { messages: result.messages, savedTokens: Math.max(0, result.savedTokenEstimate), kind: 'quick' };
    } catch (error) {
      // 「没有可清理内容」不是错误：记一条说明，交给上层决定是否升级为模型压缩。
      const note = micaContext.isCompactionNotNeededError(error)
        ? '快速压缩没有可清理的工具结果'
        : `快速压缩失败：${error instanceof Error ? error.message : String(error)}`;
      this.recordNote(note);
      return null;
    }
  }

  private async runModel(messages: unknown[]): Promise<CompactOutcome> {
    const service = new micaContext.CompactionService();
    const agent = this.options.agent;
    try {
      const result = await service.compact({
        messages,
        summarize: async (transcript, prompt) => {
          // 摘要必须走子代理、禁用工具：它共享父代理的工具注册表，session_* 之类的
          // 工具会去改正在被压缩的会话本身（与 /compact llm 同一条路径）。
          const subAgent = agent.createSubAgent({ systemPrompt: prompt, tools: false });
          const startedAt = new Date().toISOString();
          try {
            return await subAgent.query(
              [
                'Summarize this conversation into a compact checkpoint for the next coding agent.',
                'Preserve concrete paths, commands, validation results, user constraints, and pending work.',
                'Return only the requested <analysis> and <summary> blocks.',
                '',
                transcript,
              ].join('\n'),
            );
          } finally {
            // 摘要请求不进主 usageHistory（那会污染 ctx 与 lastUsage），但要记进
            // subagentUsageHistory，否则这次开销在 Stats 里不可见。
            recordSubagentTaskUsage(agent, subAgent, {
              taskId: 'auto-compact-summary',
              subagentType: 'auto-compact',
              description: '自动模型压缩摘要',
              model: agent.config.model,
              effort: 'none',
              status: 'completed',
              startedAt,
              finishedAt: new Date().toISOString(),
            });
          }
        },
      });
      this.counters.modelRuns += 1;
      this.recordRun('model', result.savedTokenEstimate, null);
      return { messages: result.messages, savedTokens: Math.max(0, result.savedTokenEstimate), kind: 'model' };
    } catch (error) {
      const note = micaContext.isCompactionNotNeededError(error)
        ? '模型压缩没有可压缩的轮次'
        : `模型压缩失败：${error instanceof Error ? error.message : String(error)}`;
      this.recordNote(note);
      return null;
    }
  }

  private recordRun(kind: AutoCompactStep, savedTokens: number, note: string | null): void {
    this.counters.lastKind = kind;
    this.counters.lastRunAt = new Date().toISOString();
    this.counters.lastSavedTokens = Math.max(0, Math.round(savedTokens) || 0);
    this.counters.lastNote = note;
  }

  private recordNote(note: string): void {
    this.counters.lastNote = note;
  }
}

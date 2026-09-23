import type { AgentUsageRecord } from './Agent.js';

export type AgentUsageSummary = {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

/**
 * One subagent task's full usage footprint, persisted with the owning agent's
 * session. `requests` keeps every model request the subagent made, so stats
 * and analytics can reconstruct exact per-request usage after the process
 * exits. Kept separate from `AgentUsageRecord[]` (the parent usageHistory)
 * because subagent `turnId`/`messageCount` are relative to the subagent's own
 * message array and must not participate in parent rewind trimming.
 */
export type SubagentUsageRecord = {
  /** The subagent task id; equals the Agent tool's `task_id`. */
  taskId: string;
  /** The parent task id when this subagent was spawned by another subagent. */
  parentTaskId?: string;
  /** The provider tool-call id of the parent agent's Agent invocation. */
  initiatedByCallId?: string;
  subagentType: string;
  description: string;
  model?: string;
  /** Reasoning effort; kept as a string so mica-agent does not depend on mica-config. */
  effort?: string;
  status: 'completed' | 'failed' | 'killed' | 'partial';
  startedAt: string;
  finishedAt?: string;
  /** Every model request the subagent made, in order, with provider usage. */
  requests: AgentUsageRecord[];
  /** Aggregated totals for cheap stats queries. */
  summary: AgentUsageSummary;
};

export function summarizeUsageHistory(usageHistory: AgentUsageRecord[]): AgentUsageSummary {
  return usageHistory.reduce<AgentUsageSummary>(
    (totals, usage) => ({
      records: totals.records + 1,
      inputTokens: totals.inputTokens + usage.inputTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
      cachedInputTokens: totals.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      totalTokens: totals.totalTokens + usage.totalTokens,
    }),
    {
      records: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
    },
  );
}

/**
 * 能接收 helper 子代理用量的 owner（通常是会话的 agent）。命令上下文里这个能力是
 * 可选的，所以方法本身也允许缺失——没有它就只是不记账，不该让命令失败。
 */
export type SubagentUsageOwner = {
  recordSubagentUsage?(record: SubagentUsageRecord): void;
};

export type SubagentUsageTaskMeta = {
  /** 任务 id；Agent 工具里等于 `task_id`，helper 子代理（commit/btw/compact 摘要）用工具名。 */
  taskId: string;
  parentTaskId?: string;
  initiatedByCallId?: string;
  subagentType: string;
  description: string;
  model?: string;
  effort?: string;
  status: SubagentUsageRecord['status'];
  startedAt: string;
  finishedAt?: string;
  /** 该子代理此前已记账的请求数；复用一个子代理时只记新增部分（如 `/btw -continue`）。 */
  fromIndex?: number;
};

export function buildSubagentUsageRecord(
  options: Omit<SubagentUsageTaskMeta, 'fromIndex'> & { requests: AgentUsageRecord[] },
): SubagentUsageRecord {
  return {
    taskId: options.taskId,
    ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
    ...(options.initiatedByCallId ? { initiatedByCallId: options.initiatedByCallId } : {}),
    subagentType: options.subagentType,
    description: options.description,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    status: options.status,
    startedAt: options.startedAt,
    ...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
    // Deep copy: records outlive the subagent client, whose usageHistory may be
    // reused by later tasks (e.g. `/btw -continue` keeps one subagent around).
    requests: cloneUsageRecords(options.requests),
    summary: summarizeUsageHistory(options.requests),
  };
}

/**
 * 把一次 helper 子代理（commit / btw / compact 摘要 等）的模型请求记进 owner 会话的
 * `subagentUsageHistory`：这些请求走 `createSubAgent`，其 usageHistory 不会并进 owner 的
 * `usageHistory`（那会污染主上下文的 ctx 与 lastUsage），但确实是本会话产生的开销，
 * 不记账就会从 Stats 里漏掉。
 *
 * `fromIndex` 用于复用的子代理（`/btw -continue`）只记新增请求。返回写入的记录；
 * 没有新增请求或没有 owner 时返回 null（不写空记录）。
 */
export function recordSubagentTaskUsage(
  owner: SubagentUsageOwner | undefined,
  source: { usageHistory?: AgentUsageRecord[] } | undefined,
  meta: SubagentUsageTaskMeta,
): SubagentUsageRecord | null {
  const requests = source?.usageHistory?.slice(meta.fromIndex ?? 0) ?? [];
  if (!owner?.recordSubagentUsage || requests.length === 0) return null;
  const { fromIndex: _fromIndex, ...rest } = meta;
  const record = buildSubagentUsageRecord({ ...rest, requests });
  owner.recordSubagentUsage(record);
  return record;
}

function cloneUsageRecords(records: AgentUsageRecord[]): AgentUsageRecord[] {
  return JSON.parse(JSON.stringify(records)) as AgentUsageRecord[];
}

export function calculateCachedTokenRate(usageHistory: AgentUsageRecord[]): number {
  const totals = summarizeUsageHistory(usageHistory);
  return totals.inputTokens > 0 ? Math.max(0, totals.cachedInputTokens / totals.inputTokens) : 0;
}

export function calculateUsageCachedTokenRate(usage: AgentUsageRecord | undefined): number {
  if (!usage || usage.inputTokens <= 0) return 0;
  return Math.max(0, (usage.cachedInputTokens ?? 0) / usage.inputTokens);
}

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

export function calculateCachedTokenRate(usageHistory: AgentUsageRecord[]): number {
  const totals = summarizeUsageHistory(usageHistory);
  return totals.inputTokens > 0 ? Math.max(0, totals.cachedInputTokens / totals.inputTokens) : 0;
}

export function calculateUsageCachedTokenRate(usage: AgentUsageRecord | undefined): number {
  if (!usage || usage.inputTokens <= 0) return 0;
  return Math.max(0, (usage.cachedInputTokens ?? 0) / usage.inputTokens);
}

import type { AgentUsageRecord } from './Agent.js';

export type AgentUsageSummary = {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
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

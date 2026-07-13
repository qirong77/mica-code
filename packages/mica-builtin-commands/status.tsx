import { Text } from '@anthropic/ink';
import { formatTokenCount } from '@packages/mica-common/format.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaSession, type PersistedSession } from '@packages/mica-session/index.js';
import {
  calculateUsageCachedTokenRate,
  summarizeUsageHistory,
  type AgentUsageRecord,
  type AgentUsageSummary,
} from '@packages/mica-agent/index.js';
import type { CommandAgent, CommandSessionController } from './services.js';
import { BUILD_TIME } from '../../src/buildMeta.js';

type TotalSessionUsageSummary = AgentUsageSummary & {
  sessions: number;
  sessionsWithUsage: number;
  latestUpdatedAt: string | null;
  currentSessionIncluded: boolean;
};

export function createStatusCommand(agent: CommandAgent, sessionController?: CommandSessionController) {
  return {
    name: 'status',
    description: '显示当前 provider/model/effort 状态，支持 `total` 参数查看本地全部 session 累计 token',
    completionItems: [{ arg: 'total', description: '显示本地全部 session 的累计 token 使用' }],
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'total') {
        showStatusPanel(formatTotalStatus(agent, sessionController), 'status total');
        return;
      }

      const { provider, model, effort } = agent.config;
      const snapshot = agent.getSnapshot();
      const usageTotals = summarizeUsageHistory(snapshot.usageHistory);
      const latestUsage = snapshot.lastUsage;

      const contextTokens = micaUi.panels.contextSize.get();
      const contextWindowSize = micaUi.panels.modelDisplay.contextWindowSize.get();
      showStatusPanel(
        formatCurrentStatusList(
          provider,
          model,
          effort,
          agent.role,
          contextTokens,
          contextWindowSize,
          usageTotals,
          latestUsage,
        ),
      );
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showStatusPanel(text: string, title = 'status') {
  const panelId = 'status-panel';
  const initialText = micaUi.terminalInput.text.get();

  function hide() {
    micaUi.panels.removePluginUI(panelId);
  }

  function StatusPanel() {
    return (
      <micaUi.Dialog title={title} footer={<micaUi.KeyHints hints={['esc exit', 'type to close']} />}>
        <micaUi.BottomScrollBox>
          {text.split('\n').map((line, index) => (
            <Text key={`${index}:${line}`} color={micaUi.theme.colors.dim}>
              {line}
            </Text>
          ))}
        </micaUi.BottomScrollBox>
      </micaUi.Dialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: panelId,
    component: StatusPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (!key.escape) return false;
      hide();
      return true;
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function formatCurrentStatusList(
  provider: CommandAgent['config']['provider'],
  model: string,
  effort: string,
  role: string,
  contextTokens: number,
  contextWindowSize: number,
  usageTotals: AgentUsageSummary,
  latestUsage: AgentUsageRecord | undefined,
): string {
  return formatStatusList([
    ['Model', model],
    ['Effort', provider.supportsEffort !== false ? effort : 'none'],
    ['Provider', provider.name ?? provider.id],
    ['Role', role],
    ['Cwd', process.cwd()],
    ['Context', formatContextUsage(contextTokens, contextWindowSize)],
    ['Total input tokens', formatTokenValue(usageTotals.inputTokens, usageTotals.records)],
    ['Total output tokens', formatTokenValue(usageTotals.outputTokens, usageTotals.records)],
    ['Latest input cached', formatUsageCachedTokenValue(latestUsage)],
    ['Total input cached', formatTotalsCachedTokenValue(usageTotals)],
    ['Build', formatBuildTime(BUILD_TIME)],
  ]);
}

function formatTotalStatus(agent: CommandAgent, sessionController?: CommandSessionController): string {
  const usageTotals = summarizeAllSessionUsage(agent, sessionController);
  return formatStatusList([
    ['Sessions', formatSessionCount(usageTotals)],
    ['Usage records', formatCountValue(usageTotals.records)],
    ['Total input tokens', formatTokenValue(usageTotals.inputTokens, usageTotals.records)],
    ['Total output tokens', formatTokenValue(usageTotals.outputTokens, usageTotals.records)],
    ['Total tokens', formatTokenValue(usageTotals.totalTokens, usageTotals.records)],
    ['Total input cached', formatTotalsCachedTokenValue(usageTotals)],
    ['Latest session update', formatUpdatedAt(usageTotals.latestUpdatedAt)],
    ['Session dir', micaSession.dir],
  ]);
}

export function summarizeAllSessionUsage(
  agent: CommandAgent,
  sessionController?: CommandSessionController,
): TotalSessionUsageSummary {
  const store = micaSession.createStore();
  const sessions = store.listAllForUsage();
  const currentSessionId = sessionController?.getCurrentSessionId?.();
  const currentSnapshot = agent.getSnapshot();

  let currentSessionIncluded = false;
  const usageHistories: AgentUsageRecord[][] = [];

  for (const session of sessions) {
    if (currentSessionId && session.id === currentSessionId) {
      usageHistories.push(safeUsageHistory(currentSnapshot.usageHistory));
      currentSessionIncluded = true;
      continue;
    }
    usageHistories.push(safeUsageHistory(session.snapshot.usageHistory));
  }

  if (currentSessionId && !currentSessionIncluded && currentSnapshot.usageHistory.length > 0) {
    usageHistories.push(safeUsageHistory(currentSnapshot.usageHistory));
    currentSessionIncluded = true;
  }

  const totals = summarizeUsageHistory(usageHistories.flat());
  return {
    ...totals,
    sessions:
      sessions.length + (currentSessionId && !sessions.some((session) => session.id === currentSessionId) ? 1 : 0),
    sessionsWithUsage: usageHistories.filter((history) => history.length > 0).length,
    latestUpdatedAt: latestUpdatedAt(sessions),
    currentSessionIncluded,
  };
}

function formatTokenValue(tokens: number, records: number): string {
  if (records === 0) return '-';
  return formatTokenCount(tokens);
}

function formatCountValue(count: number): string {
  return count > 0 ? String(count) : '-';
}

function formatContextUsage(contextTokens: number, contextWindowSize: number): string {
  if (contextTokens <= 0 || contextWindowSize <= 0) return '-';
  const usagePct = ((contextTokens / contextWindowSize) * 100).toFixed(1);
  return `${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindowSize)} (${usagePct}%)`;
}

function formatUsageCachedTokenValue(usage: AgentUsageRecord | undefined): string {
  if (!usage) return '-';
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheRate = calculateUsageCachedTokenRate(usage);
  return `${formatTokenCount(cachedInputTokens)} (${(cacheRate * 100).toFixed(0)}%)`;
}

function formatTotalsCachedTokenValue(usageTotals: AgentUsageSummary): string {
  if (usageTotals.records === 0) return '-';
  const cacheRate = usageTotals.inputTokens > 0 ? usageTotals.cachedInputTokens / usageTotals.inputTokens : 0;
  return `${formatTokenCount(usageTotals.cachedInputTokens)} (${(cacheRate * 100).toFixed(0)}%)`;
}

function formatSessionCount(usageTotals: TotalSessionUsageSummary): string {
  if (usageTotals.sessions === 0) return '-';
  const base = String(usageTotals.sessions);
  const withUsage = `${usageTotals.sessionsWithUsage} with usage`;
  return usageTotals.currentSessionIncluded ? `${base} (${withUsage}, current included)` : `${base} (${withUsage})`;
}

function formatUpdatedAt(updatedAt: string | null): string {
  if (!updatedAt) return '-';
  try {
    return new Date(updatedAt).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return updatedAt;
  }
}

function formatStatusList(entries: Array<[string, string]>) {
  const width = entries.reduce((max, [label]) => Math.max(max, label.length), 0);
  return entries.map(([label, value]) => `${label.padEnd(width)} : ${value}`).join('\n');
}

function formatBuildTime(iso: string): string {
  if (iso === 'dev') return 'dev run';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function safeUsageHistory(records: readonly unknown[] | undefined): AgentUsageRecord[] {
  return (records ?? []).filter(isValidUsageRecord);
}

function isValidUsageRecord(record: unknown): record is AgentUsageRecord {
  if (!record || typeof record !== 'object') return false;
  const usage = record as Partial<AgentUsageRecord>;
  return (
    typeof usage.provider === 'string' &&
    Number.isFinite(usage.inputTokens) &&
    Number.isFinite(usage.outputTokens) &&
    Number.isFinite(usage.totalTokens) &&
    (usage.cachedInputTokens === undefined || Number.isFinite(usage.cachedInputTokens))
  );
}

function latestUpdatedAt(sessions: readonly PersistedSession[]): string | null {
  return sessions.reduce<string | null>((latest, session) => {
    if (!latest) return session.updatedAt;
    return session.updatedAt > latest ? session.updatedAt : latest;
  }, null);
}

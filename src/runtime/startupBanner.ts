import { basename } from 'node:path';
import { formatTokenCount } from '@packages/mica-common/format.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSession } from '@packages/mica-session/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaUi, type MicaUiStartupBannerState } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';

type StartupBannerSessionState = 'new' | 'restored';

type StartupTip = {
  text: string;
  priority: number;
};

export function syncStartupBanner(agent: AgentRuntime, sessionState: StartupBannerSessionState = 'new'): void {
  const { provider, model, effort } = agent.config;
  const toolCounts = micaTools.getCounts();
  const mcpServers = micaMcp.servers.get();
  const connectedMcpServers = mcpServers.filter((server) => server.status === 'connected').length;

  micaUi.panels.setStartupBanner({
    provider: (provider.name ?? provider.id) || '-',
    model: model || '-',
    context: formatTokenCount(provider.contextWindowSize, { zero: '-', roundedThousands: true }),
    effort: provider.supportsEffort !== false ? effort : 'none',
    tools: `${toolCounts.builtin} builtin`,
    mcp: formatMcpStatus(connectedMcpServers, mcpServers.length),
    session: sessionState,
    workdir: basename(process.cwd()) || process.cwd(),
    tips: chooseStartupTip(agent, sessionState, mcpServers),
  } satisfies Partial<MicaUiStartupBannerState>);
}

function chooseStartupTip(
  agent: AgentRuntime,
  sessionState: StartupBannerSessionState,
  mcpServers: ReturnType<typeof micaMcp.servers.get>,
): string {
  const config = micaConfig.get();
  const validation = micaConfig.validate(config);
  const issues = validation.issues;
  const failedMcpCount = mcpServers.filter((server) => server.status === 'failed').length;
  const sessionCount = countPersistedSessionsForCurrentCwd();

  const candidates: StartupTip[] = [
    ...issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({ text: configIssueTip(issue.code), priority: configIssuePriority(issue.code, 900) })),
    ...issues
      .filter((issue) => issue.severity === 'warning')
      .map((issue) => ({ text: configIssueTip(issue.code), priority: configIssuePriority(issue.code, 600) })),
  ];

  if (!agent.isConfigured) candidates.push({ text: 'Missing API key · edit config', priority: 850 });
  if (failedMcpCount > 0) candidates.push({ text: 'MCP failed · run /mcp', priority: 700 });
  if (sessionState === 'restored') candidates.push({ text: 'Session restored · continue work', priority: 500 });
  if (sessionCount > 0) candidates.push({ text: 'Use /resume to continue work', priority: 420 });
  candidates.push({ text: seededDefaultTip(), priority: 100 });

  return candidates.sort((a, b) => b.priority - a.priority)[0]?.text ?? '/help for commands · /model to switch';
}

function configIssueTip(code: string): string {
  switch (code) {
    case 'provider_empty':
    case 'providers_empty':
    case 'provider_not_found':
      return 'No provider set · run /provider';
    case 'provider_api_key_missing':
      return 'Missing API key · edit config';
    case 'model_empty':
    case 'model_not_supported':
      return 'Model unavailable · run /model';
    case 'effort_not_supported_by_provider':
      return 'Effort unsupported · run /effort';
    case 'context_window_invalid':
      return 'Context invalid · edit config';
    default:
      return 'Config needs attention';
  }
}

function configIssuePriority(code: string, fallback: number): number {
  switch (code) {
    case 'provider_empty':
    case 'providers_empty':
    case 'provider_not_found':
      return 1000;
    case 'model_empty':
    case 'model_not_supported':
      return 930;
    case 'effort_not_supported_by_provider':
      return 900;
    case 'provider_api_key_missing':
      return 850;
    default:
      return fallback;
  }
}

function seededDefaultTip(): string {
  const tips = [
    '/help for commands · /model to switch',
    'Start with "explain this repo"',
    'Mention files for faster edits',
    'Use /compact when context is long',
    'Ask me to run tests after edits',
  ];
  const day = Math.floor(Date.now() / 86_400_000);
  return tips[day % tips.length]!;
}

function countPersistedSessionsForCurrentCwd(): number {
  try {
    return micaSession
      .createStore()
      .list(20)
      .filter((session) => session.cwd === process.cwd()).length;
  } catch {
    return 0;
  }
}

function formatMcpStatus(connected: number, total: number): string {
  if (total === 0) return '0 servers';
  if (connected === total) return `${total} ${plural(total, 'server')}`;
  return `${connected}/${total} ${plural(total, 'server')}`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

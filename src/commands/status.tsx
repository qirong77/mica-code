import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { micaUI } from '../../packages/mica-ui/index.js';
import { Dialog, KeyHints } from '../../packages/mica-ui/primitives/index.js';
import { themeColors } from '../../packages/mica-ui/theme.js';
import type { AgentUsageRecord } from '../../packages/agent/core/Agent.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { logRuntime } from '../logger.js';

export function registerStatusPlugin(agent: AgentRuntime) {
  return {
    name: 'status',
    description: '显示当前 provider/model/effort 状态',
    action: () => {
      const { provider, model, effort } = agent.config;
      const snapshot = agent.getSnapshot();
      const lastUsage = snapshot.lastUsage;

      const contextTokens = micaUI.panels.contextSize.get();
      const contextWindowSize = micaUI.panels.modelDisplay.contextWindowSize.get();
      logRuntime('plugin.status', 'opened', {
        provider: provider.id,
        model,
        effort: provider.supportsEffort !== false ? effort : 'none',
        messages: snapshot.messages.length,
        contextTokens,
        hasLastUsage: Boolean(lastUsage),
      });
      showStatusPanel(
        formatStatusList([
          ['Model', model],
          ['Effort', provider.supportsEffort !== false ? effort : 'none'],
          ['Provider', provider.name ?? provider.id],
          ['Context', formatContextUsage(contextTokens, contextWindowSize)],
          ['Total tokens', formatTokenValue(readTotalTokens(lastUsage))],
          ['Paid token rate', formatPaidTokenRate(lastUsage)],
        ]),
      );
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

function showStatusPanel(text: string) {
  const panelId = 'status-panel';
  const initialText = micaUI.terminalInput.text.get();

  function hide() {
    const nextPanels = micaUI.panels.pluginUIs.get().filter((panel) => panel.id !== panelId);
    micaUI.panels.setPluginUIs(nextPanels);
    logRuntime('plugin.status', 'closed');
  }

  function StatusPanel() {
    return (
      <Dialog title="status" footer={<KeyHints hints={['esc exit', 'type to close']} />}>
        <Box flexDirection="column">
          {text.split('\n').map((line, index) => (
            <Text key={`${index}:${line}`} color={themeColors.dim}>
              {line}
            </Text>
          ))}
        </Box>
      </Dialog>
    );
  }

  micaUI.panels.setPluginUIs([
    ...micaUI.panels.pluginUIs.get().filter((panel) => panel.id !== panelId),
    {
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
    },
  ]);
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatTokenValue(tokens: number | undefined): string {
  if (tokens == null) return '-';
  return formatTokens(tokens);
}

function formatContextUsage(contextTokens: number, contextWindowSize: number): string {
  if (contextTokens <= 0 || contextWindowSize <= 0) return '-';
  const usagePct = ((contextTokens / contextWindowSize) * 100).toFixed(1);
  return `${formatTokens(contextTokens)} / ${formatTokens(contextWindowSize)} (${usagePct}%)`;
}

function formatPaidTokenRate(lastUsage: AgentUsageRecord | undefined): string {
  if (!lastUsage) return '-';
  const paidTokenRate = lastUsage.paidTokenRate;
  if (!Number.isFinite(paidTokenRate) || paidTokenRate < 0) return '-';
  return `${(paidTokenRate * 100).toFixed(0)}%`;
}

function readTotalTokens(lastUsage: AgentUsageRecord | undefined): number | undefined {
  if (!lastUsage) return undefined;
  return lastUsage.totalTokens;
}

function formatStatusList(entries: Array<[string, string]>) {
  const width = entries.reduce((max, [label]) => Math.max(max, label.length), 0);
  return entries.map(([label, value]) => `${label.padEnd(width)} : ${value}`).join('\n');
}

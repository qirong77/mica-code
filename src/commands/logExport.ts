import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentUsageRecord } from '../../packages/agent/core/Agent.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '../logger.js';

interface TurnData {
  turnIndex: number;
  model: string | undefined;
  usageRecords: AgentUsageRecord[];
  messages: unknown[];
}

export function registerLogExportPlugin(agent: AgentRuntime, sessionController: SessionController) {
  return {
    name: 'log-export',
    description: '导出当前对话记录为 JSON 文件',
    action: () => {
      logRuntime('plugin.log-export', 'requested');

      const snapshot = agent.getSnapshot();
      const rawMessages = snapshot.messages;
      const usageHistory = snapshot.usageHistory;

      if (rawMessages.length === 0) {
        micaUI.messageBar.addMessage({ id: 'log-export-empty', text: 'log-export: 当前会话为空，无内容可导出' });
        setTimeout(() => micaUI.messageBar.removeMessage('log-export-empty'), 4000);
        logRuntime('plugin.log-export', 'empty');
        return;
      }

      const turns = buildTurns(rawMessages, usageHistory);

      const conversationData = {
        exportedAt: new Date().toISOString(),
        provider: snapshot.providerId,
        effort: snapshot.effort,
        totalMessages: rawMessages.length,
        totalTurns: turns.length,
        turns: turns.map((t) => ({
          turnIndex: t.turnIndex,
          model: t.model,
          usage: t.usageRecords.map(compactUsage),
          messages: t.messages,
        })),
      };

      const logEntries = micaUI.panels.logEntries.get();
      const logData = {
        exportedAt: new Date().toISOString(),
        entries: logEntries.map((entry) => {
          if (entry.type === 'thinking') {
            return { type: 'thinking', text: entry.text };
          }
          return {
            type: 'tool',
            toolName: entry.toolName,
            displayText: entry.displayText,
            output: entry.output,
            completed: entry.completed,
          };
        }),
      };

      const cwd = process.cwd();
      writeFileSync(resolve(cwd, 'conversation.json'), `${JSON.stringify(conversationData, null, 2)}\n`, 'utf-8');
      writeFileSync(resolve(cwd, 'log.text'), `${JSON.stringify(logData, null, 2)}\n`, 'utf-8');

      const id = `log-export-${Date.now()}`;
      micaUI.messageBar.addMessage({
        id,
        text: `log-export: 已导出 ${rawMessages.length} 条消息 (${turns.length} turns) → conversation.json, log.text`,
      });
      setTimeout(() => micaUI.messageBar.removeMessage(id), 6000);

      logRuntime('plugin.log-export', 'done', { messages: rawMessages.length, turns: turns.length });
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

function buildTurns(messages: unknown[], usageHistory: AgentUsageRecord[]): TurnData[] {
  const turns: TurnData[] = [];
  let currentTurnMessages: unknown[] = [];

  for (const msg of messages) {
    if (isUserMessage(msg) && currentTurnMessages.length > 0) {
      turns.push(makeTurn(turns.length + 1, currentTurnMessages, usageHistory));
      currentTurnMessages = [];
    }
    currentTurnMessages.push(msg);
  }

  if (currentTurnMessages.length > 0) {
    turns.push(makeTurn(turns.length + 1, currentTurnMessages, usageHistory));
  }

  return turns;
}

function makeTurn(turnIndex: number, messages: unknown[], usageHistory: AgentUsageRecord[]): TurnData {
  const turnUsages = usageHistory.filter((u) => u.turnId === turnIndex);
  const model = turnUsages.length > 0 ? turnUsages[0].model : undefined;

  return {
    turnIndex,
    model,
    usageRecords: turnUsages,
    messages,
  };
}

function isUserMessage(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'role' in msg && (msg as any).role === 'user';
}

function compactUsage(u: AgentUsageRecord) {
  return {
    model: u.model,
    requestIndex: u.requestIndex,
    messageCount: u.messageCount,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    paidTokenRate: u.paidTokenRate,
  };
}

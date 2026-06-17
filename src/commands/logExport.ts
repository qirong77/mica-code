import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '../logger.js';

export function registerLogExportPlugin(agent: AgentRuntime, sessionController: SessionController) {
  return {
    name: 'log-export',
    description: '导出当前对话记录为 JSON 文件',
    action: () => {
      logRuntime('plugin.log-export', 'requested');

      const snapshot = agent.getSnapshot();
      const rawMessages = snapshot.messages;

      if (rawMessages.length === 0) {
        micaUI.messageBar.addMessage({ id: 'log-export-empty', text: 'log-export: 当前会话为空，无内容可导出' });
        setTimeout(() => micaUI.messageBar.removeMessage('log-export-empty'), 4000);
        logRuntime('plugin.log-export', 'empty');
        return;
      }

      const conversationData = {
        exportedAt: new Date().toISOString(),
        model: snapshot.model,
        provider: snapshot.providerId,
        effort: snapshot.effort,
        usage: snapshot.lastUsage
          ? {
              totalTokens: snapshot.lastUsage.totalTokens,
              inputTokens: snapshot.lastUsage.inputTokens,
              outputTokens: snapshot.lastUsage.outputTokens,
              cachedInputTokens: snapshot.lastUsage.cachedInputTokens,
              cacheHitRate: snapshot.lastUsage.cacheHitRate,
            }
          : null,
        messages: rawMessages,
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
        text: `log-export: 已导出 ${rawMessages.length} 条消息 → conversation.json, log.text`,
      });
      setTimeout(() => micaUI.messageBar.removeMessage(id), 6000);

      logRuntime('plugin.log-export', 'done', { messages: rawMessages.length });
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}
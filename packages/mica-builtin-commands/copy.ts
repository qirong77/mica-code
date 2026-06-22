import { micaUi } from '@packages/mica-ui/index.js';
import { setClipboard } from '@anthropic/ink';
import type { CommandRuntimeServices } from './services.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { MicaUiMessageParam, MicaUiContentBlockParam } from '@packages/mica-ui/types.js';

export function createCopyCommand(services: CommandRuntimeServices) {
  return {
    name: 'copy',
    description: '复制最后一条消息的内容到剪贴板',
    action: async () => {
      const msgs = micaUi.conversation.messages.get();
      const responseText = micaUi.conversation.responseText.get();
      const lastAssistant = findLastAssistantContent(msgs, responseText);

      if (!lastAssistant) {
        services.showMessage('No assistant message to copy');
        return;
      }

      try {
        const osc = await setClipboard(lastAssistant);
        process.stdout.write(osc);
        services.showMessage('Copied to clipboard');
        micaLogger.logRuntime('plugin.copy', 'copied', { length: lastAssistant.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        micaLogger.logRuntime('plugin.copy', 'error', { message }, 'error');
        services.showMessage(`Copy failed: ${message}`);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function findLastAssistantContent(messages: MicaUiMessageParam[], responseText: string): string | null {
  // If streaming, use the live response text
  if (responseText.trim()) return responseText.trim();

  // Otherwise, find the last assistant message from history
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      return extractTextContent(msg.content);
    }
  }
  return null;
}

function extractTextContent(content: string | MicaUiContentBlockParam[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

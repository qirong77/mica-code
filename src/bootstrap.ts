import { agentTurn } from './agent/turn.js';
import { ui } from './components/ui/index.js';
import { setupAgentEvents } from './core/agentEvents.js';
import { appendSystemLog } from './store/logAtom.js';
import { formatError } from './utils/formatError';
import { MicaTool } from './tools/MicaTool.js';

const slowToolMessages = new Map<string, string>();

function formatSec(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

MicaTool.onSlowTool = (toolName, elapsedMs, done) => {
  const text = done
    ? `工具 ${toolName} 执行完成 (${formatSec(elapsedMs)})`
    : `工具 ${toolName} 执行中 (${formatSec(elapsedMs)})`;

  const existingId = slowToolMessages.get(toolName);
  if (existingId) {
    ui.MessageBar.removeMessage(existingId);
  }

  if (done) {
    slowToolMessages.delete(toolName);
    const id = ui.MessageBar.addMessage({ id: `slow-${toolName}`, text });
    setTimeout(() => ui.MessageBar.removeMessage(id), 3000);
  } else {
    const id = ui.MessageBar.addMessage({ id: `slow-${toolName}`, text });
    slowToolMessages.set(toolName, id);
  }
};

export function bootstrap() {
  ui.TerminalInput.onSubmit(async (text) => {
    const startTime = Date.now();
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    appendSystemLog(`用户提交：${preview}`);

    try {
      agentTurn.events.emit('status', { type: 'connecting' });
      await agentTurn.run(text);
      agentTurn.events.emit('status', { type: 'completed', elapsedMs: Date.now() - startTime });
      appendSystemLog('Agent 运行完成');
    } catch (error) {
      const message = formatError(error);
      agentTurn.events.emit('status', {
        type: 'error',
        message,
      });
      appendSystemLog(`Agent 运行失败：${message}`);
      console.error('Agent error:', error);
    }
  });

  setupAgentEvents();

}

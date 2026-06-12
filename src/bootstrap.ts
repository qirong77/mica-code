import { agentTurn } from './agent/turn.js';
import { ui } from './components/ui/index.js';
import { setupAgentEvents } from './core/agentEvents.js';
import { appendSystemLog } from './store/logAtom.js';
import { workingStatusAtom, pendingInputAtom } from './store/ui-state.js';
import { formatError } from './utils/formatError';

async function processInput(text: string): Promise<void> {
  const startTime = Date.now();
  const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  appendSystemLog(`用户提交：${preview}`);

  try {
    agentTurn.events.emit('status', { type: 'connecting' });
    await agentTurn.run(text);
    if (!agentTurn.isAborted) {
      agentTurn.events.emit('status', { type: 'completed', elapsedMs: Date.now() - startTime });
      appendSystemLog('Agent 运行完成');
    } else {
      pendingInputAtom.set(null);
      const id = `agent-interrupted-${Date.now()}`;
      ui.MessageBar.addMessage({ id, text: 'Agent 已被中断' });
      setTimeout(() => ui.MessageBar.removeMessage(id), 3000);
    }
  } catch (error) {
    const message = formatError(error);
    agentTurn.events.emit('status', { type: 'error', message });
    appendSystemLog(`Agent 运行失败：${message}`);
    console.error('Agent error:', error);
    pendingInputAtom.set(null);
  }
}

export function bootstrap() {
  ui.TerminalInput.onSubmit(async (text) => {
    const status = workingStatusAtom.get();
    if (status.type !== 'idle' && status.type !== 'completed' && status.type !== 'error') {
      pendingInputAtom.set(text.trim());
      const id = `input-queued-${Date.now()}`;
      ui.MessageBar.addMessage({ id, text: '消息已排队，将在当前任务完成后发送' });
      setTimeout(() => ui.MessageBar.removeMessage(id), 3000);
      return;
    }

    await processInput(text);

    const pending = pendingInputAtom.get();
    if (pending && !agentTurn.isAborted) {
      pendingInputAtom.set(null);
      await processInput(pending);
    }
  });

  setupAgentEvents();

}
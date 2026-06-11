import { agentTurn } from './agent/turn.js';
import { ui } from './components/ui/index.js';
import { setupAgentEvents } from './core/agentEvents.js';
import { appendSystemLog } from './store/logAtom.js';
import { workingStatusAtom } from './store/ui-state.js';
import { formatError } from './utils/formatError';

export function bootstrap() {
  ui.TerminalInput.onSubmit(async (text) => {
    const status = workingStatusAtom.get();
    if (status.type !== 'idle' && status.type !== 'completed' && status.type !== 'error') {
      const id = `agent-busy-${Date.now()}`;
      ui.MessageBar.addMessage({ id, text: 'Agent 正在运行中，请等待当前任务完成' });
      setTimeout(() => ui.MessageBar.removeMessage(id), 3000);
      return;
    }
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
        const id = `agent-interrupted-${Date.now()}`;
        ui.MessageBar.addMessage({ id, text: 'Agent 已被中断' });
        setTimeout(() => ui.MessageBar.removeMessage(id), 3000);
      }
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


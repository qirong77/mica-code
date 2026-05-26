import { agentTurn } from './agent/turn.js';
import { ui } from './components/ui/index.js';
import { setupAgentEvents } from './core/agentEvents.js';
import { appendSystemLog } from './store/logAtom.js';
import { formatError } from './utils/formatError';

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

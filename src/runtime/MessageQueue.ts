import { micaUI } from '../../packages/mica-ui/index.js';
import { logRuntime } from '../logger.js';
import { showMessage } from './uiBridge.js';

export class MessageQueue {
  private pendingInput: string | null = null;
  private running = false;

  get isRunning() {
    return this.running;
  }

  startRun() {
    this.running = true;
  }

  finishRun() {
    this.running = false;
  }

  clear() {
    this.pendingInput = null;
    this.running = false;
  }

  enqueue(text: string) {
    this.pendingInput = text;
    logRuntime('runtime', 'submit:queued', { chars: text.length });
    micaUI.conversation.setPendingInput(text);
    showMessage('消息已排队，将在当前任务完成后发送');
    micaUI.terminalInput.clearText();
  }

  takePending(): string | null {
    const next = this.pendingInput;
    this.pendingInput = null;
    if (next) micaUI.conversation.clearPendingInput();
    return next;
  }
}

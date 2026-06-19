import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { showMessage } from './uiBridge.js';

export class MessageQueue {
  private pendingInputs: string[] = [];
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
    this.pendingInputs = [];
    this.running = false;
    micaUi.conversation.clearPendingInput();
  }

  enqueue(text: string) {
    this.pendingInputs.push(text);
    micaLogger.logRuntime('runtime', 'submit:queued', { chars: text.length, queued: this.pendingInputs.length });
    micaUi.conversation.setPendingInputs(this.pendingInputs);
    showMessage('消息已排队，将在当前任务完成后发送');
    micaUi.terminalInput.clearText();
  }

  takePending(): string | null {
    const next = this.pendingInputs.shift() ?? null;
    micaUi.conversation.setPendingInputs(this.pendingInputs);
    return next;
  }
}

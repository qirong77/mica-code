import { MicaPlugin } from '../MicaPlugin.js';
import { getClient } from '../../agent/client.js';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

function isRetryable(error: unknown): boolean {
  if (error instanceof Error && error.message === 'ABORT') return false;
  return getClient().isRetryableError(error);
}

export class ErrorHandlerPlugin extends MicaPlugin {
  onInstall(): void {
    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
        try {
          return await next(userInput, onIteration);
        } catch (error) {
          if (!isRetryable(error)) throw error;

          if (attempt >= RETRY_MAX_ATTEMPTS - 1) {
            const msgId = this.showMessage(`已重试 ${RETRY_MAX_ATTEMPTS} 次，仍然失败`, 3000);
            throw error;
          }

          const delay = Math.min(
            RETRY_BASE_DELAY_MS * 2 ** attempt,
            RETRY_MAX_DELAY_MS,
          );
          let remaining = Math.ceil(delay / 1000);
          const retryNum = attempt + 1;
          const msgId = this.showMessage(
            `第 ${retryNum} 次失败，${remaining}s 后重试...`,
            0,
          );
          const timer = setInterval(() => {
            remaining -= 1;
            this.showMessage(
              `第 ${retryNum} 次失败，${remaining}s 后重试...`,
              0,
              msgId,
            );
          }, 1000);

          await new Promise<void>((resolve) => {
            setTimeout(() => {
              clearInterval(timer);
              this.removeMessage(msgId);
              resolve();
            }, delay);
          });
        }
      }
    });
  }
}

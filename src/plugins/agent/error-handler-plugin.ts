import Anthropic from '@anthropic-ai/sdk';
import { MicaPlugin } from '../MicaPlugin';

// ── Retry configuration ──

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIUserAbortError) return false;
  // 其他（认证错误、非法请求等）不重试
  return false;
}

/**
 * 错误重试插件：当 API 调用遇到可重试错误时自动重试。
 */
export class ErrorHandlerPlugin extends MicaPlugin {
  onInstall(): void {
    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
        try {
          return await next(userInput, onIteration);
        } catch (error) {
          if (!isRetryable(error) || attempt >= RETRY_MAX_ATTEMPTS - 1) throw error;
          const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt + 1), RETRY_MAX_DELAY_MS);
          let restTime = delay / 1000;
          const msgId = this.showMessage(`第 ${attempt + 1} 次重试失败，${restTime}s 后重试...`, 0);
          const timer = setInterval(() => {
            restTime -= 1;
            this.showMessage(`第 ${attempt + 1} 次重试失败，${restTime}s 后重试...`, 0, msgId);
          }, 1000);
          await new Promise((resolve) =>
            setTimeout(() => {
              clearInterval(timer);
              this.removeMessage(msgId);
              resolve(true);
            }, delay),
          );
        }
      }
    });
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { appendSystemLog } from '../store/logAtom.js';
import { cleanBackups } from './run-loop-side-effects.js';
import { parseImageRefs } from '../components/ui/utils/imagePaste.js';
import { AgentSession } from './agent-session.js';
import type { IterationResult } from './types.js';

function hasTextContent(message: Anthropic.Message): boolean {
  if (typeof message.content === 'string') return true;
  return message.content.some((block) => block.type === 'text');
}

export type RunLoopControl = {
  runIteration: () => Promise<IterationResult>;
  isAborted: () => boolean;
  onAborted: () => void;
};

export class AgentRunLoop {
  constructor(private session: AgentSession) {}

  async run(
    userInput: string,
    control: RunLoopControl,
    onIteration?: (result: IterationResult) => void,
  ): Promise<void> {
    appendSystemLog('Agent run 开始');
    this.session.clearToolRecords();
    await cleanBackups();

    const userContent = parseImageRefs(userInput);
    this.session.appendUser(userContent);

    while (true) {
      if (control.isAborted()) {
        appendSystemLog('Agent run 被用户中断');
        control.onAborted();
        return;
      }

      try {
        const result = await control.runIteration();
        onIteration?.(result);

        if (!result.hasToolUse && !result.wasTruncated) {
          if (!hasTextContent(result.finalMessage)) {
            appendSystemLog('Agent run 继续（响应仅含思考块，等待模型输出文本）');
            continue;
          }
          appendSystemLog('Agent run 结束（无待执行工具）');
          return;
        }
        appendSystemLog(`继续下一轮迭代（${result.wasTruncated ? '响应被截断' : '存在工具调用'}）`);
      } catch (err) {
        if (err instanceof Error && err.message === 'ABORT') {
          appendSystemLog('Agent run 被用户中断');
          control.onAborted();
          return;
        }
        throw err;
      }
    }
  }
}

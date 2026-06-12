import { MicaPlugin } from '../MicaPlugin';
import { getContextUsage } from '../../utils/getContextUsage';
import { compactMessages, MIN_MESSAGES_TO_COMPACT } from '../../utils/compact';
import { model } from '../../store/config';

export class QuickCommandCompactPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'compact',
      description: '压缩当前对话上下文',
      action: async () => {
        const messages = this.agent.agentTurn.session.getMessages();
        if (messages.length < MIN_MESSAGES_TO_COMPACT) {
          this.showMessage(
            `消息条数不足（当前 ${messages.length}，最少 ${MIN_MESSAGES_TO_COMPACT}）`,
          );
          return;
        }

        const usageBefore = getContextUsage(messages);
        const maxCtx = model.contextWindowSize.get();
        const ratioBefore = maxCtx > 0 ? ((usageBefore / maxCtx) * 100).toFixed(0) : '?';

        const msgId = this.showMessage(`上下文使用 ${ratioBefore}%，正在压缩...`, 0);

        try {
          const { compacted, toCompressCount } = await compactMessages(messages);
          this.agent.agentTurn.session.replaceMessages(compacted);
          this.removeMessage(msgId);

          const usageAfter = getContextUsage(compacted);
          const ratioAfter = maxCtx > 0 ? ((usageAfter / maxCtx) * 100).toFixed(1) : '?';
          this.showMessage(
            `压缩完成：${toCompressCount} 条消息 → 1 条摘要，上下文使用 ${ratioAfter}%`,
            5000,
          );
        } catch {
          this.removeMessage(msgId);
          this.showMessage('压缩失败', 3000);
        }
      },
    });
  }
}

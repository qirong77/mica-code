import { atom, type WritableAtom } from 'nanostores';
import { MicaPlugin } from '../MicaPlugin.js';
import { getContextUsage } from '../../utils/getContextUsage.js';
import { compactMessages, KEEP_RECENT_COUNT, MIN_MESSAGES_TO_COMPACT, trySessionMemoryCompact } from '../../utils/compact.js';
import { model } from '../../store/config.js';
import { session } from '../../store/uiState.js';

const CONTEXT_THRESHOLD = 0.4;
const INACTIVITY_THRESHOLD_MS = 45 * 60 * 1000;

const sessionTimeAtoms = new Map<string, WritableAtom<number>>();

function getSessionTimeAtom(sessionId: string): WritableAtom<number> {
  let atom_ = sessionTimeAtoms.get(sessionId);
  if (!atom_) {
    atom_ = atom(0);
    sessionTimeAtoms.set(sessionId, atom_);
  }
  return atom_;
}

export class AutoCompactPlugin extends MicaPlugin {
  private lastUserMessageTimeAtom: WritableAtom<number> | null = null;
  private isCompressing = false;

  onInstall(): void {
    const sid = session.currentId.get();
    if (sid) {
      this.lastUserMessageTimeAtom = getSessionTimeAtom(sid);
    }

    session.currentId.subscribe((newId) => {
      if (newId && !this.lastUserMessageTimeAtom) {
        this.lastUserMessageTimeAtom = getSessionTimeAtom(newId);
      }
    });

    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      const timeAtom = this.lastUserMessageTimeAtom;
      const now = Date.now();
      const lastTime = timeAtom?.get() ?? 0;
      const timeSinceLastUser = lastTime > 0 ? now - lastTime : 0;
      if (timeAtom) timeAtom.set(now);

      if (this.isCompressing) return next(userInput, onIteration);

      const sess = this.agent.agentTurn.session;
      const messages = sess.getMessages();
      if (messages.length < MIN_MESSAGES_TO_COMPACT) {
        return next(userInput, onIteration);
      }

      const contextUsage = getContextUsage(messages);
      const maxContext = model.contextWindowSize.get();
      const contextRatio = maxContext > 0 ? contextUsage / maxContext : 0;

      const timeTriggered = timeSinceLastUser > INACTIVITY_THRESHOLD_MS;
      const contextTriggered = contextRatio > CONTEXT_THRESHOLD;

      if (!timeTriggered && !contextTriggered) {
        return next(userInput, onIteration);
      }

      this.isCompressing = true;

      const triggerReason = contextTriggered
        ? `上下文使用 ${(contextRatio * 100).toFixed(0)}%（阈值 40%）`
        : `超过 ${Math.floor(timeSinceLastUser / 60000)} 分钟无对话`;

      const msgId = this.showMessage(`${triggerReason}，正在压缩对话历史...`, 0);

      try {
        const sid = session.currentId.get();
        const smResult = sid ? await trySessionMemoryCompact(sid, messages) : null;

        if (smResult) {
          sess.replaceMessages(smResult);
          this.removeMessage(msgId);
          const newUsage = getContextUsage(smResult);
          const newRatio = maxContext > 0 ? (newUsage / maxContext * 100).toFixed(1) : '?';
          this.showMessage(
            `压缩完成（会话记忆）：上下文使用 ${newRatio}%`,
            5000,
          );
        } else {
          const { compacted, toCompressCount } = await compactMessages(messages);
          sess.replaceMessages(compacted);
          this.removeMessage(msgId);
          const newUsage = getContextUsage(compacted);
          const newRatio = maxContext > 0 ? (newUsage / maxContext * 100).toFixed(1) : '?';
          this.showMessage(
            `压缩完成：${toCompressCount} 条消息 → 1 条摘要，上下文使用 ${newRatio}%`,
            5000,
          );
        }
      } catch {
        this.removeMessage(msgId);
        this.showMessage('压缩失败，继续正常对话', 3000);
      } finally {
        this.isCompressing = false;
      }

      return next(userInput, onIteration);
    });
  }
}

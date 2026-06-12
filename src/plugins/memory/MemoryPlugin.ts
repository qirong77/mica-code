import { MicaPlugin } from '../MicaPlugin.js';
import { getMemoryDir, readMemoryIndex, ensureMemoryDir, getSessionMemoryPath, readSessionMemory, ensureSessionMemoryDir } from './memoryPaths.js';
import { buildMemorySystemPrompt } from './memoryTypes.js';
import { truncateEntrypointContent } from './memoryTruncate.js';
import { scanMemoryFiles, formatMemoryManifest } from './memoryScan.js';
import { createForkedAgent } from '../../agent/forked-agent.js';
import { getSystemPrompt } from '../../prompts/index.js';
import type { ConversationMessage } from '../../store/conversation.js';
import { session } from '../../store/ui-state.js';
import { getContextUsage } from '../../utils/getContextUsage';

const EXTRACT_MIN_MESSAGES_SINCE = 10;
const EXTRACT_MIN_TOKENS_SINCE = 5_000;

const SESSION_MEMORY_TOOL_CALLS = 10;
const SESSION_MEMORY_MIN_TOKENS = 10_000;

const RECALL_MEMORY_COUNT_THRESHOLD = 20;

let _systemPromptInjected = false;

export function injectMemorySystemPrompt(builder: { append: (type: any, content: string) => any }): void {
  if (_systemPromptInjected) return;
  _systemPromptInjected = true;

  const memoryDir = getMemoryDir();
  ensureMemoryDir();

  const instructions = buildMemorySystemPrompt(memoryDir);
  const rawIndex = readMemoryIndex();

  let content = instructions;
  if (rawIndex.trim()) {
    const truncated = truncateEntrypointContent(rawIndex);
    content += `\n\n## MEMORY.md index\n\n${truncated.content}`;
  } else {
    content += '\n\n## MEMORY.md index\n\nYour MEMORY.md is currently empty. When you save new memories, they will appear here.';
  }

  builder.append('memory', content);
}

export class MemoryPlugin extends MicaPlugin {
  private lastExtractionMessageIdx = 0;
  private tokensAtLastExtraction = 0;
  private extracting = false;

  private sessionMemoryToolCallCount = 0;
  private sessionMemoryTokensAtLastUpdate = 0;
  private sessionMemoryExtracting = false;

  private _unsubIteration: (() => void) | null = null;

  onInstall(): void {
    ensureMemoryDir();
    ensureSessionMemoryDir();

    this.addQuickCommand({
      name: 'memory',
      description: '查看/管理当前项目的记忆文件',
      action: () => this.showMemoryStatus(),
    });

    this._unsubIteration = this.agent.agentTurn.onIterationComplete((messages) => {
      this.onTurnComplete(messages);
    });
  }

  onCleanup(): void {
    this._unsubIteration?.();
  }

  private async onTurnComplete(messages: ConversationMessage[]): Promise<void> {
    if (this.extracting || this.sessionMemoryExtracting) return;

    void this.tryExtractMemories(messages);
    void this.tryExtractSessionMemory(messages);
  }

  private async tryExtractMemories(messages: ConversationMessage[]): Promise<void> {
    const newCount = messages.length - this.lastExtractionMessageIdx;
    const currentTokens = getContextUsage(messages);
    const tokensSince = currentTokens - this.tokensAtLastExtraction;

    if (newCount < EXTRACT_MIN_MESSAGES_SINCE && tokensSince < EXTRACT_MIN_TOKENS_SINCE) {
      return;
    }

    this.lastExtractionMessageIdx = messages.length;
    this.tokensAtLastExtraction = currentTokens;

    const memoryDir = getMemoryDir();
    const memoryCount = scanMemoryFiles(memoryDir).length;

    this.extracting = true;
    try {
      let recallContext = '';
      if (memoryCount > RECALL_MEMORY_COUNT_THRESHOLD) {
        const manifest = formatMemoryManifest(scanMemoryFiles(memoryDir));
        recallContext = `\n当前记忆文件清单（已有 ${memoryCount} 个，请从中选择最相关的 ≤5 个进行更新，或创建新的）：\n${manifest}\n\n仅更新已有的或创建与对话相关的新记忆，不要创建无关记忆。`;
      } else {
        const manifest = formatMemoryManifest(scanMemoryFiles(memoryDir));
        if (manifest) {
          recallContext = `\n当前记忆文件清单：\n${manifest}\n`;
        }
      }

      const systemPrompt = getSystemPrompt();
      await createForkedAgent({
        promptMessages: [{
          role: 'user',
          content: `查看上述对话历史，提取应该跨对话持久化的记忆。${recallContext}\n\n将记忆写入 ${memoryDir} 目录。遵循系统 prompt 中 "Memory system" 部分的类型和格式要求。MEMORY.md 索引保留在 200 行以内。如果没有值得保留的记忆，不做任何操作。`,
        }],
        systemPrompt,
        allowedTools: ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_search'],
        maxTurns: 5,
        thinkingDisabled: true,
      });
    } catch {
      // best-effort
    } finally {
      this.extracting = false;
    }
  }

  private async tryExtractSessionMemory(messages: ConversationMessage[]): Promise<void> {
    this.sessionMemoryToolCallCount++;

    const currentTokens = getContextUsage(messages);
    const tokensSince = currentTokens - this.sessionMemoryTokensAtLastUpdate;

    if (this.sessionMemoryToolCallCount < SESSION_MEMORY_TOOL_CALLS &&
        tokensSince < SESSION_MEMORY_MIN_TOKENS) {
      return;
    }

    this.sessionMemoryToolCallCount = 0;
    this.sessionMemoryTokensAtLastUpdate = currentTokens;

    const sid = session.currentId.get();
    if (!sid) return;

    const memoryPath = getSessionMemoryPath(sid);
    const currentContent = readSessionMemory(sid) ?? '';

    this.sessionMemoryExtracting = true;
    try {
      const systemPrompt = getSystemPrompt();
      await createForkedAgent({
        promptMessages: [{
          role: 'user',
          content: `你是会话记忆维护助手。基于对话历史更新会话记忆文件。

当前会话记忆内容：
${currentContent || '(空)'}

更新 ${memoryPath}，将对话中的关键信息汇总进去：
- 用户的请求和目标
- 作出的决策
- 修改过的文件和代码
- 遇到的错误及修复方法
- 待完成的任务

保持简洁但详细。更新已有条目而非重复，删除过时信息。使用 Edit 或 Write 工具编辑该文件。`,
        }],
        systemPrompt,
        allowedTools: ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_search'],
        maxTurns: 3,
        thinkingDisabled: true,
      });
    } catch {
      // best-effort
    } finally {
      this.sessionMemoryExtracting = false;
    }
  }

  private showMemoryStatus(): void {
    const memoryDir = getMemoryDir();
    const files = scanMemoryFiles(memoryDir);
    const indexPath = `${memoryDir}MEMORY.md`;

    if (files.length === 0) {
      this.showMessage('当前项目没有记忆文件', 3000);
      return;
    }

    const lines = files.map(f => {
      const tag = f.type ? `[${f.type}]` : '';
      const days = Math.floor((Date.now() - f.mtimeMs) / 86400000);
      const age = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
      return `${tag} ${f.filename} (${age})`;
    });

    const totalCount = files.length;
    const typeCounts: Record<string, number> = {};
    for (const f of files) {
      const t = f.type ?? 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    const summary = `${totalCount} memories (${Object.entries(typeCounts).map(([k, v]) => `${k}:${v}`).join(', ')})`;
    this.showMessage(`记忆索引: ${indexPath}\n${summary}`, 0);

    // Also log to system log for visibility
    import('../../store/logAtom.js').then(({ appendSystemLog }) => {
      appendSystemLog(`[memory] ${summary}\n${lines.join('\n')}`);
    });
  }
}

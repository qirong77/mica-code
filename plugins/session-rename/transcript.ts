import { COMPACT_BOUNDARY_PREFIX, COMPACT_SUMMARY_PREFIX } from '@packages/mica-context/CompactionService.js';
import { stripMediaPlaceholders } from '@packages/mica-common/promptText.js';
import type { MicaUiContentBlockParam, MicaUiConversationMessage } from '@packages/mica-ui/index.js';

/**
 * 把会话消息压成「用户说了什么 / 模型答了什么」的纯文本。
 *
 * 三件东西必须排除，否则交给标题模型的是噪声：
 * - 工具调用与工具结果：它们不是对话内容，而且往往比正文长几十倍；
 * - 插件注入的 prompt（`displayContent` 与 `content` 不同）：那不是用户写的；
 * - compact 的边界与摘要：那是压缩产物，不是这一轮在聊的东西。
 */
export type TranscriptEntry = {
  role: 'user' | 'assistant';
  text: string;
};

export type TranscriptOptions = {
  /** 最多取最近几条（用户与助手合计）。 */
  maxMessages: number;
  /** 单条最多保留多少字符，超出截断。 */
  maxCharsPerMessage?: number;
};

const DEFAULT_MAX_CHARS_PER_MESSAGE = 600;

export function buildTranscript(
  messages: readonly MicaUiConversationMessage[],
  options: TranscriptOptions,
): TranscriptEntry[] {
  const maxChars = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;
  const entries: TranscriptEntry[] = [];

  for (const message of messages) {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (isPluginInjected(message)) continue;

    const text = messageText(message.content);
    if (!text) continue;
    if (role === 'user' && isCompactArtifact(text)) continue;

    entries.push({ role, text: truncate(text, maxChars) });
  }

  return options.maxMessages > 0 ? entries.slice(-options.maxMessages) : entries;
}

/** 成对出现的对话文本，直接作为标题模型的输入。 */
export function formatTranscript(entries: readonly TranscriptEntry[]): string {
  return entries.map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`).join('\n\n');
}

export function messageText(content: string | MicaUiContentBlockParam[]): string {
  const raw = typeof content === 'string' ? content : joinTextBlocks(content);
  return stripMediaPlaceholders(raw)
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function joinTextBlocks(content: readonly MicaUiContentBlockParam[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 插件注入的消息以 `displayText` 提交：展示给用户的和真正发给模型的不一样。
 * 只有两者一致时才是用户自己敲进去的话。
 */
function isPluginInjected(message: MicaUiConversationMessage): boolean {
  if (message.displayContent === undefined) return false;
  return messageText(message.displayContent) !== messageText(message.content);
}

function isCompactArtifact(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith(COMPACT_BOUNDARY_PREFIX) || head.startsWith(COMPACT_SUMMARY_PREFIX);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

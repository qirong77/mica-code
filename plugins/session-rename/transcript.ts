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
  /**
   * 本轮正在执行的用户输入。
   *
   * `turn:before` 时它还不在 agent history 里（TUI 只进了 `uiState`，headless 只是
   * `pendingUserMessage`），所以只能由 hook 事件补进来——而它正是标题要概括的东西。
   */
  latestUserText?: string;
};

const DEFAULT_MAX_CHARS_PER_MESSAGE = 600;

export function buildTranscript(
  messages: readonly MicaUiConversationMessage[],
  options: TranscriptOptions,
): TranscriptEntry[] {
  const maxChars = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;
  const entries: TranscriptEntry[] = [];

  // 只抽取最终会发送的后缀，避免每轮都清洗整条长会话。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (options.maxMessages > 0 && entries.length >= options.maxMessages) break;
    const message = messages[index]!;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (isPluginInjected(message)) continue;

    const text = messageText(message.content);
    if (!text) continue;
    if (role === 'user' && isCompactArtifact(text)) continue;

    entries.push({ role, text: truncate(text, maxChars) });
  }

  entries.reverse();
  appendLatestUserText(entries, options.latestUserText, maxChars);
  return options.maxMessages > 0 ? entries.slice(-options.maxMessages) : entries;
}

/** 成对出现的对话文本，直接作为标题模型的输入。 */
export function formatTranscript(entries: readonly TranscriptEntry[]): string {
  return entries.map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`).join('\n\n');
}

/**
 * 标题模型的输入：先给上下文，再单独点出「最新请求」。
 *
 * 两段分开写，是因为标题要概括的是**这一轮**在做什么；混成一段时模型很容易被前面几轮
 * 的内容带跑（尤其是旧任务比新请求长得多的时候）。
 */
export function formatTitleInput(entries: readonly TranscriptEntry[]): string {
  let latestIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === 'user') {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return ['对话记录（从旧到新）：', formatTranscript(entries)].join('\n');

  const latest = entries[latestIndex]!;
  const earlier = entries.filter((_, index) => index !== latestIndex);
  return [
    ...(earlier.length > 0 ? ['对话记录（从旧到新，仅用于理解上下文）：', formatTranscript(earlier), ''] : []),
    '用户最新请求（标题概括这一段）：',
    `用户：${latest.text}`,
  ].join('\n');
}

/** 与 `buildTranscript` 的截断规则一致，重复的输入不会被算成两条对话。 */
function appendLatestUserText(entries: TranscriptEntry[], latestUserText: string | undefined, maxChars: number): void {
  const text = latestUserText ? messageText(latestUserText) : '';
  if (!text) return;
  const latest = truncate(text, maxChars);
  const last = entries.at(-1);
  if (last?.role === 'user' && last.text === latest) return;
  entries.push({ role: 'user', text: latest });
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

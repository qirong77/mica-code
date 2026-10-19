/**
 * 「这条消息说的是什么」的唯一归一化实现。
 *
 * 编辑重发（desktop 双击用户消息）与回退点都要按文本定位一条已存在的用户消息
 * ——持久化历史没有逐条消息 id。但界面与 provider history 是两套投影，同一句话
 * 在两边长得并不一样：
 *
 * - 块连接：CLI 侧 `contentText` 用换行拼块，桌面侧按原样拼；
 * - 图片：输入原文是 `[Image](路径)`，provider 侧是 `[Image]`，桌面侧是 `[图片]`，
 *   而 Chat Completions 的历史投影还会把所有图片兜底文本并为末尾一个文本块
 *   （连顺序都变了）。
 *
 * 所以定位不能「把一方的写法换成另一方的写法」，只能**把媒体占位符整体剥掉**
 * 再折叠空白——剩下的文本才是两侧真正共有的部分。CLI 的
 * `apps/cli/src/runtime/conversationHistory.ts` 与桌面端的
 * `ChatView.jsx`（`promptOccurrenceFromEnd`）共用这一份，不要再各写一套。
 */

/**
 * 图片/媒体占位符的所有已知写法：输入原文、两种界面投影，以及 compact 与读取
 * 失败时的降级文本。`[Image](路径)` 必须排在 `[Image]` 之前，否则只吃掉前半截、
 * 把括号里的路径留在比较文本里。
 */
const MEDIA_PLACEHOLDER_RE = /\[Image\]\([^)]*\)|\[图片\]|\[Image\]|\[image omitted[^\]]*\]/gi;

export function stripMediaPlaceholders(text: unknown): string {
  return String(text ?? '').replace(MEDIA_PLACEHOLDER_RE, '');
}

/**
 * 定位用的比较口径：剥掉媒体占位符、折叠空白。
 *
 * 只有媒体、没有文字的消息归一化后是空串——调用方必须把它当成「无法按文本
 * 定位」而不是「匹配到任意一条空消息」。
 */
export function comparableText(text: unknown): string {
  return stripMediaPlaceholders(text).replace(/\s+/g, ' ').trim();
}

/**
 * 消息 content 的定位投影：文本块直接拼接（不加分隔符——分隔符会伪装成用户
 * 打出的空格，而两侧块数与切分位置并不一致），媒体块按占位符计入再由
 * `comparableText` 剥掉。
 */
export function comparableContentText(content: unknown): string {
  if (typeof content === 'string') return comparableText(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    else if (typeof record.refusal === 'string') parts.push(record.refusal);
    else if (typeof record.type === 'string' && record.type.includes('image')) parts.push('[Image]');
  }
  return comparableText(parts.join(''));
}

export function comparableMessageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return '';
  return comparableContentText((message as { content: unknown }).content);
}

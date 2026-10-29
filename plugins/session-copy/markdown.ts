import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

/**
 * 会话 → Markdown 的纯函数实现。
 *
 * 只拼数据，不碰插件上下文：这样它可以被单测直接喂各种畸形消息（块数组、缺文本的图片、
 * 空历史），而复制动作本身只负责取数据与返回结果。
 */

export type SessionCopyMeta = {
  title?: string;
  sessionId?: string;
  cwd?: string;
  role?: string;
  provider?: string;
  model?: string;
};

/** 界面上标记为「这一条是谁说的」。notice 不在这里出现——它不是对话。 */
const ROLE_LABELS: Record<string, string> = {
  user: '用户',
  assistant: '助手',
};

/**
 * 一条消息的正文。
 *
 * `content` 可能是字符串，也可能是块数组（文本 + 图片）：文本块原样拼接，图片写成
 * `[图片]`——markdown 里没有本地图片路径可引用，硬塞一个读不到的地址只会让人以为坏了。
 * 空白折叠成单行以外的空行保留：对话里的分段就是用户敲出来的结构。
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    else if (typeof record.type === 'string' && record.type.includes('image')) parts.push('[图片]');
  }
  return parts.join('\n').trim();
}

/** 只留用户与助手的文本消息：工具调用、思考、notice 都不进导出（它们不是对话）。 */
export function conversationTurns(
  messages: readonly MicaUiConversationMessage[] | undefined,
): { role: 'user' | 'assistant'; text: string }[] {
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    // displayContent 是界面上那一份（用户带图片时的原文），比发给模型的投影更接近用户看到的东西。
    const raw = (message as { displayContent?: unknown }).displayContent ?? message.content;
    const text = messageText(raw);
    // 只有图片、没有文字的消息也保留一行 `[图片]`，否则对话里会莫名其妙少一条。
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

/** 一行元信息：字段有值才写，不留下 `- 模型：` 这种空行。 */
function metaLine(label: string, value: string | undefined): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? `- ${label}：${text}` : '';
}

/** 角色只有在真选了非默认角色时才写：`default` 是「没选角色」，写出来只是噪音。 */
function describeRole(meta: SessionCopyMeta): string {
  const role = meta.role?.trim() ?? '';
  return role && role !== 'default' ? role : '';
}

/** 模型那一行：`服务商 / 模型`（服务商与模型同名时只写一次）。 */
export function describeModel(meta: SessionCopyMeta): string {
  const provider = meta.provider?.trim() ?? '';
  const model = meta.model?.trim() ?? '';
  if (!provider) return model;
  if (!model || model === provider) return provider;
  // 模型名自己带 `provider/model` 前缀时不再重复服务商。
  if (model.startsWith(`${provider}/`)) return model;
  return `${provider} / ${model}`;
}

/**
 * 整份 Markdown。
 *
 * 结构是「一段元信息 + 逐轮对话」，因为这份文本最常见的去向是贴进工单、文档或另一条
 * 会话里：读者要先知道这是哪条会话、在哪个目录、用什么模型，再读对话。
 */
export function sessionMarkdown(
  meta: SessionCopyMeta,
  messages: readonly MicaUiConversationMessage[] | undefined,
): string {
  const turns = conversationTurns(messages);
  const title = meta.title?.trim() || meta.sessionId?.trim() || '未命名会话';
  const lines: string[] = [`# ${title}`, ''];
  const metaLines = [
    metaLine('会话 ID', meta.sessionId),
    metaLine('路径', meta.cwd),
    metaLine('模型', describeModel(meta)),
    metaLine('角色', describeRole(meta)),
    metaLine('对话条数', String(turns.length)),
  ].filter(Boolean);
  lines.push(...metaLines, '');
  if (turns.length === 0) {
    lines.push('（这条会话还没有对话内容）');
    return `${lines.join('\n').trimEnd()}\n`;
  }
  lines.push('## 对话', '');
  turns.forEach((turn, index) => {
    lines.push(`### ${index + 1}. ${ROLE_LABELS[turn.role]}`, '', turn.text, '');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

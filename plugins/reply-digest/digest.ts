import type { MicaUiContentBlockParam, MicaUiConversationMessage } from '@packages/mica-ui/index.js';

export const DEFAULT_CHAR_THRESHOLD = 1800;
export const DEFAULT_LINE_THRESHOLD = 36;
export const DEFAULT_INPUT_LIMIT = 12_000;
export const DEFAULT_SUMMARY_LIMIT = 600;

export type DigestLimits = {
  charThreshold: number;
  lineThreshold: number;
  inputLimit: number;
  summaryLimit: number;
};

export function lastAssistantText(messages: readonly MicaUiConversationMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    return messageText(message.content);
  }
  return '';
}

export function shouldDigest(text: string, limits: Pick<DigestLimits, 'charThreshold' | 'lineThreshold'>): boolean {
  if (!text) return false;
  const lines = text.split('\n').filter((line) => line.trim()).length;
  return text.length >= limits.charThreshold || lines >= limits.lineThreshold;
}

export function digestInput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function cleanSummary(raw: unknown, limit: number): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/```/g, '')
    .replace(/^\s*(?:摘要|简短摘要|summary)\s*[:：]\s*/i, '')
    .trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function messageText(content: string | MicaUiContentBlockParam[]): string {
  const raw =
    typeof content === 'string'
      ? content
      : content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .filter(Boolean)
          .join('\n');
  return raw.replace(/[ \t]+$/gm, '').trim();
}

export function parseSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

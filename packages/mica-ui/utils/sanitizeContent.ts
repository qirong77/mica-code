import type { MicaUiContentBlockParam, MicaUiTextBlock } from '../types.js';

export function sanitizeUiContent(
  content: string | MicaUiContentBlockParam[],
  maxChars: number,
): string | MicaUiContentBlockParam[] {
  if (typeof content === 'string') return truncateMiddleText(content, maxChars);

  const blocks: MicaUiContentBlockParam[] = [];
  let omittedImages = 0;
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: truncateMiddleText(block.text, maxChars) });
      continue;
    }
    omittedImages++;
  }

  if (omittedImages > 0 && blocks.length === 0) {
    blocks.push({ type: 'text', text: omittedImages === 1 ? '[Image]' : `[${omittedImages} images]` });
  }
  return blocks.length === 1 && blocks[0]!.type === 'text' ? (blocks[0] as MicaUiTextBlock).text : blocks;
}

function truncateMiddleText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[message stored for UI truncated, omitted ${text.length - maxChars} chars]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

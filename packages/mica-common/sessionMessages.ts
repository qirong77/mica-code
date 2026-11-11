import { comparableText } from './promptText.js';

/** Text shared by model history, display history and queued input. */
export function sessionContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as Record<string, unknown>;
      return typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/**
 * Compact can replace media blocks without changing the user's input. Match the
 * shared text first, then retained image references for a media-only prompt.
 * Inline pi images and input images use the same exact data identity when no
 * reference was recorded. No wire-protocol shapes belong on this runtime path.
 */
export function sessionPromptKey(content: unknown): string {
  const text = sessionContentText(content);
  const body = comparableText(text);
  if (body) return body;
  const refs = [...text.matchAll(/\[Image\]\(([^)]+)\)/gi)].map((match) => match[1]!.trim());
  if (refs.length) return `[media] ${refs.join(' ')}`;
  if (!Array.isArray(content)) return '';
  const images = content.flatMap((part): string[][] => {
    if (!part || typeof part !== 'object') return [];
    const block = part as Record<string, unknown>;
    if (block.type !== 'image') return [];
    if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return [[block.mimeType, block.data]];
    }
    const source = block.source as Record<string, unknown> | undefined;
    return source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string'
      ? [[source.media_type, source.data]]
      : [];
  });
  return images.length ? `[inline-media] ${JSON.stringify(images)}` : '';
}

export function sameSessionUserContent(left: unknown, right: unknown): boolean {
  const key = sessionPromptKey(left);
  return Boolean(key) && key === sessionPromptKey(right);
}

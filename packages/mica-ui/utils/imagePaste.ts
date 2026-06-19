import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const IMAGES_DIR = resolve(homedir(), '.mica', 'images');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

export function saveClipboardImage(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });
    const filePath = resolve(IMAGES_DIR, `image-${randomUUID()}.png`);
    execFileSync(
      'osascript',
      [
        '-e',
        `set png_data to (the clipboard as «class PNGf»)\nset fp to open for access POSIX file "${filePath}" with write permission\nwrite png_data to fp\nclose access fp`,
      ],
      { stdio: 'ignore', timeout: 5000 },
    );
    return `~/.mica/images/${filePath.split('/').pop()}`;
  } catch {
    return null;
  }
}

const IMAGE_REF_RE = /\[Image\]\(([^)]+)\)/g;

export function parseImageRefs(text: string): string | import('../types.js').MicaUiContentBlockParam[] {
  const blocks: import('../types.js').MicaUiContentBlockParam[] = [];
  let lastIndex = 0,
    match: RegExpExecArray | null;
  while ((match = IMAGE_REF_RE.exec(text)) !== null) {
    const [full, imgPath] = match,
      idx = match.index;
    if (idx > lastIndex) blocks.push({ type: 'text', text: text.slice(lastIndex, idx) });
    try {
      const resolved = imgPath.startsWith('~') ? resolve(homedir(), imgPath.slice(2)) : imgPath;
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        blocks.push({ type: 'text', text: `${full} [image omitted: not a file]` });
        lastIndex = idx + full.length;
        continue;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        blocks.push({ type: 'text', text: `${full} [image omitted: file exceeds ${formatBytes(MAX_IMAGE_BYTES)}]` });
        lastIndex = idx + full.length;
        continue;
      }
      const mediaType = mediaTypeFromPath(resolved);
      if (!mediaType) {
        blocks.push({ type: 'text', text: `${full} [image omitted: unsupported image type]` });
        lastIndex = idx + full.length;
        continue;
      }
      const buffer = readFileSync(resolved);
      blocks.push(
        { type: 'text', text: full },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
      );
    } catch {
      blocks.push({ type: 'text', text: full });
    }
    lastIndex = idx + full.length;
  }
  if (lastIndex < text.length) blocks.push({ type: 'text', text: text.slice(lastIndex) });
  if (blocks.length === 0) return text;
  if (blocks.length === 1 && blocks[0]!.type === 'text')
    return (blocks[0] as import('../types.js').MicaUiTextBlock).text;
  return blocks;
}

function mediaTypeFromPath(path: string): (typeof SUPPORTED_IMAGE_TYPES)[keyof typeof SUPPORTED_IMAGE_TYPES] | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] as keyof typeof SUPPORTED_IMAGE_TYPES | undefined;
  return ext ? (SUPPORTED_IMAGE_TYPES[ext] ?? null) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

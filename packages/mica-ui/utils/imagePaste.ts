import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TEMP_IMAGE_DIR = resolve(homedir(), '.mica', 'tmp-images');
const IMAGES_DIR = resolve(homedir(), '.mica', 'images');

export interface ImageData {
  base64: string;
  mediaType: string;
  path: string;
}

function ensureTempDir(): void {
  if (!existsSync(TEMP_IMAGE_DIR)) mkdirSync(TEMP_IMAGE_DIR, { recursive: true });
}

export function hasImageInClipboard(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('osascript', ['-e', 'the clipboard as «class PNGf»'], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function getImageFromClipboard(): ImageData | null {
  if (process.platform !== 'darwin') return null;
  try {
    ensureTempDir();
    const filePath = resolve(TEMP_IMAGE_DIR, `paste-${randomUUID()}.png`);
    execFileSync(
      'osascript',
      [
        '-e',
        `set png_data to (the clipboard as «class PNGf»)\nset fp to open for access POSIX file "${filePath}" with write permission\nwrite png_data to fp\nclose access fp`,
      ],
      { stdio: 'ignore', timeout: 5000 },
    );
    return { base64: readFileSync(filePath).toString('base64'), mediaType: 'image/png', path: filePath };
  } catch {
    return null;
  }
}

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

export function saveImage(base64: string, mediaType: string): string {
  ensureTempDir();
  const ext = mediaType.split('/')[1] || 'png';
  const filePath = resolve(TEMP_IMAGE_DIR, `paste-${randomUUID()}.${ext}`);
  writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
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
      const buffer = readFileSync(resolved);
      const rawExt = resolved.toLowerCase().match(/\.(\w+)$/)?.[1] || 'png';
      const mediaType = (rawExt === 'jpg' ? 'image/jpeg' : `image/${rawExt}`) as
        | 'image/jpeg'
        | 'image/png'
        | 'image/gif'
        | 'image/webp';
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

function cleanupTempDir(): void {
  try {
    if (!existsSync(TEMP_IMAGE_DIR)) return;
    const entries = readdirSync(TEMP_IMAGE_DIR)
      .map((name) => {
        const p = join(TEMP_IMAGE_DIR, name);
        try {
          return { name, path: p, mtime: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length > 100) {
      for (const f of entries.slice(100)) rmSync(f.path, { force: true });
    }
  } catch {
    /* ignore */
  }
}
cleanupTempDir();

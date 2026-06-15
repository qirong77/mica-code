import type { ContentBlockParam, ImageBlockParam, TextBlock } from '../../types.js';
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
  if (!existsSync(TEMP_IMAGE_DIR)) {
    mkdirSync(TEMP_IMAGE_DIR, { recursive: true });
  }
}

export function hasImageInClipboard(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('osascript', ['-e', 'the clipboard as «class PNGf»'], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export function getImageFromClipboard(): ImageData | null {
  if (process.platform !== 'darwin') return null;

  try {
    ensureTempDir();
    const filename = `paste-${randomUUID()}.png`;
    const filePath = resolve(TEMP_IMAGE_DIR, filename);

    execFileSync('osascript', [
      '-e',
      `set png_data to (the clipboard as «class PNGf»)
set fp to open for access POSIX file "${filePath}" with write permission
write png_data to fp
close access fp`,
    ], { stdio: 'ignore', timeout: 5000 });

    const buffer = readFileSync(filePath);
    return {
      base64: buffer.toString('base64'),
      mediaType: 'image/png',
      path: filePath,
    };
  } catch {
    return null;
  }
}

export function saveClipboardImage(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    if (!existsSync(IMAGES_DIR)) {
      mkdirSync(IMAGES_DIR, { recursive: true });
    }
    const filename = `image-${randomUUID()}.png`;
    const filePath = resolve(IMAGES_DIR, filename);

    execFileSync('osascript', [
      '-e',
      `set png_data to (the clipboard as «class PNGf»)
set fp to open for access POSIX file "${filePath}" with write permission
write png_data to fp
close access fp`,
    ], { stdio: 'ignore', timeout: 5000 });

    return `~/.mica/images/${filename}`;
  } catch {
    return null;
  }
}

export function saveImage(base64: string, mediaType: string): string {
  ensureTempDir();
  const ext = mediaType.split('/')[1] || 'png';
  const filename = `paste-${randomUUID()}.${ext}`;
  const filePath = resolve(TEMP_IMAGE_DIR, filename);
  writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

const IMAGE_REF_RE = /\[Image\]\(([^)]+)\)/g;

export function parseImageRefs(text: string): string | ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = IMAGE_REF_RE.exec(text)) !== null) {
    const [full, imgPath] = match;
    const idx = match.index;

    if (idx > lastIndex) {
      blocks.push({ type: 'text', text: text.slice(lastIndex, idx) });
    }

    try {
      const imgPathResolved = imgPath.startsWith('~')
        ? resolve(homedir(), imgPath.slice(2))
        : imgPath;
      const buffer = readFileSync(imgPathResolved);
      const rawExt = imgPathResolved.toLowerCase().match(/\.(\w+)$/)?.[1] || 'png';
      const mediaType = (rawExt === 'jpg' ? 'image/jpeg' : `image/${rawExt}`) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

      blocks.push({ type: 'text', text: full });
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      } as ImageBlockParam);
    } catch {
      blocks.push({ type: 'text', text: full });
    }

    lastIndex = idx + full.length;
  }

  if (lastIndex < text.length) {
    blocks.push({ type: 'text', text: text.slice(lastIndex) });
  }

  if (blocks.length === 0) return text;
  // If only text blocks and just one, return plain string
  if (blocks.length === 1 && blocks[0]!.type === 'text') return (blocks[0] as TextBlock).text;
  return blocks;
}

function cleanupTempDir(): void {
  try {
    if (!existsSync(TEMP_IMAGE_DIR)) return;
    const entries = readdirSync(TEMP_IMAGE_DIR).map((name) => {
      const p = join(TEMP_IMAGE_DIR, name);
      try { return { name, path: p, mtime: statSync(p).mtimeMs }; }
      catch { return null; }
    }).filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length > 100) {
      for (const f of entries.slice(100)) rmSync(f.path, { force: true });
    }
  } catch {
    // ignore
  }
}

cleanupTempDir();

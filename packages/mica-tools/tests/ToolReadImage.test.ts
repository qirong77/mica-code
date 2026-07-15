import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolReadImage } from '../ToolReadImage.js';
import type { ToolResultImageBlock } from '../types.js';
import { getToolDefinitions, isToolReadOnly } from '../registry.js';

let tempDir: string;
let pngBuffer: Buffer;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mica-read-image-'));
  pngBuffer = await sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  })
    .png()
    .toBuffer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ToolReadImage', () => {
  it('is registered as a read-only builtin tool', () => {
    expect(getToolDefinitions().some((tool) => tool.name === 'read_image')).toBe(true);
    expect(isToolReadOnly('read_image')).toBe(true);
  });

  it('reads a local image and returns text plus a base64 image block', async () => {
    const filePath = join(tempDir, 'sample.png');
    writeFileSync(filePath, pngBuffer);

    const result = await new ToolReadImage().execute({ source: filePath });
    const image = imageBlock(result);

    expect(image.source.media_type).toBe('image/png');
    expect(Buffer.from(image.source.data, 'base64')).toEqual(pngBuffer);
    expect(JSON.stringify(result)).toContain('Dimensions: 3x2');
  });

  it('resolves relative paths against the tool context cwd', async () => {
    writeFileSync(join(tempDir, 'relative.png'), pngBuffer);

    const result = await new ToolReadImage().execute({ source: 'relative.png' }, { context: { cwd: tempDir } });

    expect(imageBlock(result).source.media_type).toBe('image/png');
  });

  it('downloads an HTTP image and validates its actual format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from(pngBuffer), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ToolReadImage().execute({ source: 'https://example.com/image' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(imageBlock(result).source.media_type).toBe('image/png');
  });

  it('rejects unsupported URL schemes and invalid image data', async () => {
    const tool = new ToolReadImage();
    await expect(tool.execute({ source: 'file:///tmp/image.png' })).rejects.toThrow('不支持的 URL 协议');

    const filePath = join(tempDir, 'fake.png');
    writeFileSync(filePath, 'not an image');
    await expect(tool.execute({ source: filePath })).rejects.toThrow('unsupported image format');
  });

  it('keeps failures as textual tool results through executeTimed', async () => {
    const result = await new ToolReadImage().executeTimed({ source: join(tempDir, 'missing.png') });

    expect(result).toEqual(expect.stringContaining('read_image'));
  });
});

function imageBlock(result: Awaited<ReturnType<ToolReadImage['execute']>>): ToolResultImageBlock {
  if (typeof result === 'string') throw new Error(`Expected rich tool result, received: ${result}`);
  const image = result.find((block): block is ToolResultImageBlock => block.type === 'image');
  if (!image) throw new Error('Expected an image block');
  return image;
}

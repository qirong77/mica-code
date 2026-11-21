import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ToolImageMediaType, ToolResultBlock } from '@packages/mica-tools/index.js';
import type { ConnectedMcpServer } from './client.js';
import { connections } from './client.js';
import * as mcpClient from './client.js';
import { fetchToolsForServer } from './tools.js';

describe('MCP proxy tools', () => {
  afterEach(() => {
    connections.delete('test');
    vi.restoreAllMocks();
  });

  async function createProxyTool(
    result: CallToolResult = { content: [{ type: 'text', text: 'ok' }] },
    signal?: AbortSignal,
  ) {
    const request = vi.fn(async (..._args: unknown[]) => ({
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    }));
    const callTool = vi.fn(async (..._args: unknown[]) => result);
    const cleanup = vi.fn(async () => undefined);
    const server = {
      name: 'test',
      config: { command: 'test' },
      cleanup,
      client: { request, callTool },
    } as unknown as ConnectedMcpServer;
    connections.set(server.name, server);

    const [tool] = await fetchToolsForServer(server, signal);
    if (!tool) throw new Error('Expected a proxy tool');
    return { tool, request, callTool, cleanup, server };
  }

  it('forwards the agent abort signal to tools/list and tools/call', async () => {
    const controller = new AbortController();
    const { tool, request, callTool } = await createProxyTool(undefined, controller.signal);
    await tool.execute({}, { signal: controller.signal });

    expect(request.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(callTool.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(callTool.mock.calls[0]?.[0]).toEqual({ name: 'lookup', arguments: {} });
  });

  it.each([
    [{}, 120_000],
    [{ timeoutMs: 500 }, 120_000],
    [{ timeoutMs: 300_000 }, 305_000],
    [{ action: 'wait', params: { timeoutMs: 1_800_000 } }, 1_805_000],
    [{ timeoutMs: 2_147_483_647 }, 2_147_483_647],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, 120_000],
    [{ timeoutMs: 'private' }, 120_000],
  ])('keeps the existing timeout floor while respecting a longer declared budget (%j)', async (args, timeout) => {
    const controller = new AbortController();
    const { tool, callTool } = await createProxyTool();

    await tool.execute(args, { signal: controller.signal });

    expect(callTool.mock.calls[0]?.[2]).toMatchObject({ timeout, signal: controller.signal });
  });

  it('keeps text-only results as newline-joined strings', async () => {
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    expect(await tool.execute({})).toBe('first\nsecond');
  });

  it('keeps the original text-only output limit and truncation notice', async () => {
    const { tool } = await createProxyTool({
      content: [{ type: 'text', text: `head${'a'.repeat(70_000)}tail` }],
    });
    const result = await tool.execute({});
    expect(typeof result).toBe('string');
    expect(result.length).toBeLessThanOrEqual(60_000);
    expect(result).toContain('MCP test.lookup 输出过大');
    expect(result).toContain('head');
    expect(result).toContain('tail');
  });

  it('preserves empty-content and empty-text results', async () => {
    const { tool, callTool } = await createProxyTool({ content: [] });
    expect(await tool.execute({})).toBe('[]');
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: '' }] });
    expect(await tool.execute({})).toBe('(no output)');
  });

  it('keeps mixed text and multiple images in their original order', async () => {
    const png = pngFixture(6, 4);
    const jpeg = jpegFixture(6, 4);
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        { type: 'text', text: 'between' },
        { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') },
        { type: 'text', text: 'after' },
      ],
    });
    expect(await tool.execute({})).toEqual([
      { type: 'text', text: 'before' },
      expectedImageBlock(png, 'image/png'),
      { type: 'text', text: 'between' },
      expectedImageBlock(jpeg, 'image/jpeg'),
      { type: 'text', text: 'after' },
    ]);
  });

  it.each<ToolImageMediaType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])(
    'maps image-only %s results to standard tool image blocks',
    async (mimeType) => {
      const payload = imageFixture(mimeType);
      const { tool } = await createProxyTool({
        content: [{ type: 'image', mimeType, data: payload.toString('base64') }],
      });
      expect(await tool.execute({})).toEqual([expectedImageBlock(payload, mimeType)]);
    },
  );

  it('does not truncate large images or serialize them through the text budget', async () => {
    const payload = pngFixture(800, 600);
    const { tool, callTool } = await createProxyTool({
      content: [{ type: 'image', mimeType: 'image/png', data: payload.toString('base64') }],
    });
    const image = expectedImageBlock(payload, 'image/png');
    expect(await tool.execute({})).toEqual([image]);

    callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'caption'.repeat(12_000) },
        { type: 'image', mimeType: 'image/png', data: payload.toString('base64') },
      ],
    });
    const mixed = await tool.execute({});
    if (typeof mixed === 'string') throw new Error('Expected image blocks');
    expect(mixed[0]).toMatchObject({ type: 'text', text: expect.stringContaining('输出过大') });
    expect(mixed[1]).toEqual(image);
  });

  it('shares the mixed-result text budget across blocks without changing image or empty text blocks', async () => {
    const png = pngFixture(4, 4);
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'a'.repeat(40_000) },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        { type: 'text', text: '' },
        { type: 'text', text: 'b'.repeat(40_000) },
      ],
    });
    const result = await tool.execute({});
    if (typeof result === 'string') throw new Error('Expected image blocks');
    expect(
      result.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0),
    ).toBeLessThanOrEqual(60_000);
    expect(result[1]).toEqual(expectedImageBlock(png, 'image/png'));
    expect(result[2]).toEqual({ type: 'text', text: '' });
  });

  it('reports unsupported image MIME types without including their base64 data', async () => {
    const data = 'PRIVATE_BASE64_PAYLOAD'.repeat(30_000);
    const { tool } = await createProxyTool({
      content: [{ type: 'image', mimeType: 'image/svg+xml', data }],
    });
    const result = await tool.execute({});
    expect(typeof result).toBe('string');
    expect(result).toContain('unsupported MIME type image/svg+xml');
    expect(result).not.toContain('PRIVATE_BASE64_PAYLOAD');
    expect(result.length).toBeLessThan(500);
  });

  it('summarizes unsupported content without serializing its payload or dropping supported images', async () => {
    const png = pngFixture(4, 4);
    const data = 'PRIVATE_BASE64_PAYLOAD'.repeat(30_000);
    const unsupported: ContentBlock[] = [
      { type: 'audio', mimeType: 'audio/wav', data },
      { type: 'resource', resource: { uri: 'file:///data.bin', mimeType: 'application/octet-stream', blob: data } },
    ];
    const { tool, callTool } = await createProxyTool({ content: unsupported });
    const text = await tool.execute({});
    expect(text).toContain('audio content omitted');
    expect(text).toContain('resource content omitted');
    expect(text).not.toContain('PRIVATE_BASE64_PAYLOAD');
    expect(text.length).toBeLessThan(1000);

    callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'caption' },
        ...unsupported,
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      ],
    });
    const mixed = await tool.execute({});
    if (typeof mixed === 'string') throw new Error('Expected image blocks');
    expect(mixed[0]).toEqual({ type: 'text', text: 'caption' });
    expect(mixed[1]).toMatchObject({ type: 'text', text: expect.stringContaining('audio content omitted') });
    expect(mixed[3]).toEqual(expectedImageBlock(png, 'image/png'));
    expect(JSON.stringify(mixed)).not.toContain('PRIVATE_BASE64_PAYLOAD');
  });

  it('preserves readable resource text and bounded resource links', async () => {
    const { tool } = await createProxyTool({
      content: [
        { type: 'resource', resource: { uri: 'file:///report.txt', text: 'actual report' } },
        { type: 'resource_link', name: 'report', uri: 'file:///report.txt' },
      ],
    });
    expect(await tool.execute({})).toBe('actual report\nreport: file:///report.txt');
  });

  it('still throws joined MCP error text and uses the generic error when there is no text', async () => {
    const png = pngFixture(2, 2);
    const { tool, callTool } = await createProxyTool({
      isError: true,
      content: [
        { type: 'text', text: 'failed' },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        { type: 'text', text: 'details' },
      ],
    });
    await expect(tool.execute({})).rejects.toThrow('failed\ndetails');
    callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
    });
    await expect(tool.execute({})).rejects.toThrow('MCP tool returned an error');
  });

  it('retries an expired MCP session once and preserves image results and the abort signal', async () => {
    const png = pngFixture(3, 2);
    const controller = new AbortController();
    const { tool, callTool, cleanup, server } = await createProxyTool();
    callTool.mockRejectedValueOnce(new Error('Session not found'));
    const retriedCall = vi.fn(async (..._args: unknown[]) => ({
      content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
    }));
    const reconnected = { ...server, client: { callTool: retriedCall } } as unknown as ConnectedMcpServer;
    const connect = vi.spyOn(mcpClient, 'connectToServer').mockResolvedValueOnce(reconnected);
    expect(await tool.execute({ query: 'test' }, { signal: controller.signal })).toEqual([
      expectedImageBlock(png, 'image/png'),
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('test', server.config, controller.signal);
    expect(retriedCall.mock.calls[0]?.[0]).toEqual({ name: 'lookup', arguments: { query: 'test' } });
    expect(retriedCall.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('does not reconnect an expired session after the agent aborts', async () => {
    const controller = new AbortController();
    const { tool, callTool, cleanup } = await createProxyTool();
    callTool.mockRejectedValueOnce(new Error('Session not found'));
    const connect = vi.spyOn(mcpClient, 'connectToServer');
    controller.abort();
    await expect(tool.execute({}, { signal: controller.signal })).rejects.toThrow('Session not found');
    expect(connect).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('downscales an oversized PNG and states the original and actual size before the image', async () => {
    const oversized = pngFixture(12_000, 8);
    const small = pngFixture(5, 5);
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: oversized.toString('base64') },
        { type: 'image', mimeType: 'image/png', data: small.toString('base64') },
      ],
    });

    const result = await tool.execute({});
    if (typeof result === 'string') throw new Error('Expected image blocks');
    expect(result[0]).toEqual({ type: 'text', text: 'screenshot' });
    const note = result[1];
    if (note?.type !== 'text') throw new Error('Expected a size note before the downscaled image');
    expect(note.text).toContain('12000x8');
    expect(note.text).toContain('1568x1');
    expect(note.text).toContain('crop');
    expect(note.text).toContain('sections');
    expect(note.text).not.toContain(oversized.toString('base64').slice(0, 32));

    const downscaled = result[2];
    if (downscaled?.type !== 'image') throw new Error('Expected the downscaled image');
    expect(downscaled.source.media_type).toBe('image/png');
    expect(downscaled.source.data).not.toBe(oversized.toString('base64'));
    const bytes = Buffer.from(downscaled.source.data, 'base64');
    expect(bytes.readUInt32BE(16)).toBe(1568);
    expect(bytes.readUInt32BE(20)).toBe(1);

    // 没缩的图不加说明、不改字节，两张图仍按原顺序跟着各自的说明走。
    expect(result[3]).toEqual(expectedImageBlock(small, 'image/png'));
    expect(result).toHaveLength(4);
  });

  it.each(['', 'not an image at all', 'PRIVATE_BASE64_PAYLOAD'.repeat(200)])(
    'replaces one undecodable image with a short note and keeps the other content (%#)',
    async (brokenPayload) => {
      const png = pngFixture(6, 6);
      const jpeg = jpegFixture(6, 4);
      const { tool } = await createProxyTool({
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
          { type: 'image', mimeType: 'image/png', data: brokenPayload },
          { type: 'text', text: 'after' },
          { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') },
        ],
      });

      const result = await tool.execute({});
      if (typeof result === 'string') throw new Error('Expected image blocks');
      expect(result[0]).toEqual({ type: 'text', text: 'before' });
      expect(result[1]).toEqual(expectedImageBlock(png, 'image/png'));
      const failure = result[2];
      if (failure?.type !== 'text') throw new Error('Expected a text replacement for the failed image');
      expect(failure.text).toContain('MCP image omitted');
      expect(failure.text).toContain('image/png');
      expect(failure.text.length).toBeLessThan(600);
      expect(failure.text).not.toContain('PRIVATE_BASE64_PAYLOAD');
      expect(result[3]).toEqual({ type: 'text', text: 'after' });
      expect(result[4]).toEqual(expectedImageBlock(jpeg, 'image/jpeg'));
      expect(result).toHaveLength(5);
    },
  );

  it('keeps an image result whose only image failed as plain text', async () => {
    const { tool } = await createProxyTool({
      content: [{ type: 'image', mimeType: 'image/png', data: 'not-a-real-png' }],
    });
    const result = await tool.execute({});
    expect(typeof result).toBe('string');
    expect(result).toContain('MCP image omitted');
    expect(result).not.toContain('not-a-real-png');
  });

  it('rejects an image that stays over the API long-edge limit instead of sending it', async () => {
    const png = pngFixture(4, 4);
    const { tool } = await createProxyTool({
      content: [
        // JPEG 在本机不重编码，9000px 长边只能拦下：发出去只会换来一条服务端 400。
        { type: 'image', mimeType: 'image/jpeg', data: jpegFixture(10, 9_000).toString('base64') },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      ],
    });
    const result = await tool.execute({});
    if (typeof result === 'string') throw new Error('Expected image blocks');
    const rejected = result[0];
    if (rejected?.type !== 'text') throw new Error('Expected the oversized image to be replaced by text');
    expect(rejected.text).toContain('MCP image omitted');
    expect(rejected.text).toContain('8192');
    expect(rejected.text.length).toBeLessThan(600);
    expect(result[1]).toEqual(expectedImageBlock(png, 'image/png'));
  });

  it('omits a PNG over the local decode-pixel cap with a crop-or-read-in-sections hint', async () => {
    const png = pngFixture(4, 4);
    // 2360x32000 = 7552 万像素，超过本机 16Mi 的解码上限：闸在 inflate 之前就拦下，
    // 所以这里只需要声明尺寸的真 PNG 头，不需要那 300MB 的像素数据。
    const huge = pngHeaderFixture(2_360, 32_000);
    const { tool } = await createProxyTool({
      content: [
        { type: 'image', mimeType: 'image/png', data: huge.toString('base64') },
        { type: 'text', text: 'after' },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      ],
    });

    const result = await tool.execute({});
    if (typeof result === 'string') throw new Error('Expected image blocks');
    const omitted = result[0];
    if (omitted?.type !== 'text') throw new Error('Expected the oversized PNG to be replaced by text');
    expect(omitted.text).toContain('MCP image omitted');
    expect(omitted.text).toContain('2360x32000');
    expect(omitted.text).toContain('分段');
    expect(omitted.text).not.toContain(huge.toString('base64').slice(0, 32));
    expect(result[1]).toEqual({ type: 'text', text: 'after' });
    expect(result[2]).toEqual(expectedImageBlock(png, 'image/png'));
    expect(result).toHaveLength(3);
  });

  it('omits a PNG with broken zlib data instead of falling back to the original bytes', async () => {
    const png = pngFixture(4, 4);
    const broken = pngHeaderFixture(4, 4, Buffer.from('definitely not a zlib stream'));
    const { tool } = await createProxyTool({
      content: [
        { type: 'image', mimeType: 'image/png', data: broken.toString('base64') },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      ],
    });

    const result = await tool.execute({});
    if (typeof result === 'string') throw new Error('Expected image blocks');
    const omitted = result[0];
    if (omitted?.type !== 'text') throw new Error('Expected corrupted data to be replaced by text');
    expect(omitted.text).toContain('MCP image omitted');
    expect(omitted.text).toContain('image/png');
    expect(omitted.text.length).toBeLessThan(600);
    // 坏数据不能被当成图片塞回上下文，哪怕原字节还在手里。
    expect(result.some((block) => block.type === 'image' && block.source.data === broken.toString('base64'))).toBe(
      false,
    );
    expect(result[1]).toEqual(expectedImageBlock(png, 'image/png'));
  });

  it('uses the media type the payload actually is when the MIME label disagrees', async () => {
    const gif = gifFixture(8, 4);
    const { tool } = await createProxyTool({
      content: [
        { type: 'image', mimeType: 'image/jpeg', data: VERIFIED_1X1_PNG.toString('base64') },
        { type: 'image', mimeType: 'image/png', data: gif.toString('base64') },
      ],
    });
    expect(await tool.execute({})).toEqual([
      expectedImageBlock(VERIFIED_1X1_PNG, 'image/png'),
      expectedImageBlock(gif, 'image/gif'),
    ]);
  });

  it.each([
    ['VP8X', webpFixture(4, 3)],
    ['VP8L', webpLosslessFixture(4, 3)],
    ['VP8', webpLossyFixture(4, 3)],
  ] as Array<[string, Buffer]>)(
    'keeps %s WebP payloads as images instead of replacing them',
    async (_variant, payload) => {
      const { tool } = await createProxyTool({
        content: [{ type: 'image', mimeType: 'image/webp', data: payload.toString('base64') }],
      });
      expect(await tool.execute({})).toEqual([expectedImageBlock(payload, 'image/webp')]);
    },
  );
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** zlib 校验和有效的完整 1x1 PNG 样本。 */
const VERIFIED_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 夹具自己拼真图片字节，也不 mock `prepareImageForApi`：准备函数会真的解码 PNG、
 * 校验尺寸与图头，拿 'cG5n' 这种假字符串只能测到「原样透传」，测不到压缩与拒绝。
 */
function pngFixture(width: number, height: number): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 4;
      raw[offset] = x & 0xff;
      raw[offset + 1] = y & 0xff;
      raw[offset + 2] = 0x80;
      raw[offset + 3] = 0xff;
    }
  }
  return pngHeaderFixture(width, height, deflateSync(raw));
}

/**
 * 只有签名 + IHDR（声明尺寸）+ 给定 IDAT 的 PNG。用来构造「像素上限在 inflate 之前
 * 就拦下」和「IDAT 是坏 zlib」这两种图：它们都到不了真正的像素解码。
 */
function pngHeaderFixture(width: number, height: number, idat = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 只带 APP0 + SOF0 的 JPEG 头：尺寸识别走真实解析路径，不需要真的像素数据。 */
function jpegFixture(width: number, height: number): Buffer {
  const app0 = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof0 = Buffer.alloc(15);
  sof0[0] = 8;
  sof0.writeUInt16BE(height, 1);
  sof0.writeUInt16BE(width, 3);
  sof0[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    app0,
    Buffer.from([0xff, 0xc0, 0x00, 0x11]),
    sof0,
    Buffer.alloc(64, 7),
  ]);
}

/** GIF89a 文件头 + 逻辑屏幕描述符 + trailer：类型与尺寸都从真实头里读。 */
function gifFixture(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return Buffer.concat([header, Buffer.from([0x3b])]);
}

/** RIFF/WEBP 容器 + VP8X 块：24 位宽高存在块头后面。 */
function webpFixture(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  writeUInt24LE(buffer, width - 1, 24);
  writeUInt24LE(buffer, height - 1, 27);
  return buffer;
}

/** VP8L（无损）头：0x2f 之后 4 字节小端位域，宽高各占 14 位。 */
function webpLosslessFixture(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(25);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer.writeUInt32LE(9, 16);
  buffer[20] = 0x2f;
  const bits = (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0;
  buffer.writeUInt32LE(bits, 21);
  return buffer;
}

/** VP8（有损）头：3 字节帧标签 + 同步码 9d 01 2a，再是两个 14 位宽高。 */
function webpLossyFixture(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer.writeUInt32LE(14, 16);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(buffer, 23);
  buffer.writeUInt16LE(width & 0x3fff, 26);
  buffer.writeUInt16LE(height & 0x3fff, 28);
  return buffer;
}

function writeUInt24LE(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
}

function imageFixture(mediaType: ToolImageMediaType): Buffer {
  if (mediaType === 'image/jpeg') return jpegFixture(4, 3);
  if (mediaType === 'image/gif') return gifFixture(4, 3);
  if (mediaType === 'image/webp') return webpFixture(4, 3);
  return pngFixture(4, 3);
}

function expectedImageBlock(payload: Buffer, mediaType: ToolImageMediaType): ToolResultBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: payload.toString('base64') },
  };
}

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_API_LONG_EDGE, IMAGE_MAX_LONG_EDGE, prepareImageForApi } from './image.js';
import { decodePng, encodePng } from './imagePng.js';
import { downscaleAreaAverage } from './imageResample.js';

/** 测试自己拼 PNG，不经过被测的编码器：两个方向各错一次才不会被同一个 bug 一起糊过去。 */
function buildPng(
  width: number,
  height: number,
  options: { colorType: 0 | 2 | 3 | 4 | 6; bitDepth: number },
  pixel: (x: number, y: number) => number[],
): Buffer {
  const { colorType, bitDepth } = options;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const stride = width * channels * bytesPerSample;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const samples = pixel(x, y);
      for (let channel = 0; channel < channels; channel++) {
        const value = samples[channel] ?? 0;
        const offset = y * (stride + 1) + 1 + x * channels * bytesPerSample + channel * bytesPerSample;
        if (bytesPerSample === 2) raw.writeUInt16BE(value, offset);
        else raw[offset] = value;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
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

/** 只带 APP0 + SOF0 的 JPEG 头，给尺寸识别走真实解析路径，不需要真的像素数据。 */
function buildJpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(16 - 2);
  Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]).copy(app0);
  const sof0 = Buffer.alloc(17 - 2);
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

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pixelAt(image: { width: number; channels: 3 | 4; data: Uint8Array }, x: number, y: number): number[] {
  const offset = (y * image.width + x) * image.channels;
  return Array.from(image.data.subarray(offset, offset + image.channels));
}

function hash(x: number, y: number, salt: number): number {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 1274126177);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) & 0xff;
}

describe('prepareImageForApi', () => {
  it('小图原样透传，一个字节都不改', async () => {
    const png = buildPng(64, 48, { colorType: 6, bitDepth: 8 }, (x, y) => [x * 3, y * 5, 200, 255]);
    const processed = await prepareImageForApi(png);
    expect(processed.resized).toBe(false);
    expect(processed.buffer.equals(png)).toBe(true);
    expect(processed.width).toBe(64);
    expect(processed.sourceWidth).toBe(64);
  });

  it('超过长边上限的截图按比例缩小，且比例近似不变', async () => {
    const png = buildPng(3200, 2000, { colorType: 6, bitDepth: 8 }, () => [40, 90, 160, 255]);
    const processed = await prepareImageForApi(png);
    expect(processed.resized).toBe(true);
    expect(Math.max(processed.width!, processed.height!)).toBe(IMAGE_MAX_LONG_EDGE);
    expect(processed.width! / processed.height!).toBeCloseTo(3200 / 2000, 2);
    expect(processed.sourceWidth).toBe(3200);
    expect(processed.buffer.length).toBeLessThan(png.length);

    const decoded = decodePng(processed.buffer);
    expect([decoded.width, decoded.height]).toEqual([processed.width, processed.height]);
    // 纯色图缩放后仍是同一个颜色：面积平均不该把颜色算歪。
    expect(pixelAt(decoded, 10, 10)).toEqual([40, 90, 160]);
  });

  it('本身就是 16bit 的 macOS 截图降到 8bit，取高字节', async () => {
    const png = buildPng(8, 8, { colorType: 2, bitDepth: 16 }, () => [0x1234, 0x56ab, 0xde00]);
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(3);
    expect(pixelAt(decoded, 0, 0)).toEqual([0x12, 0x56, 0xde]);
  });

  it('不透明的 RGBA 去掉 alpha 通道，像素不变', async () => {
    // 用噪声像素把体积撑过重打包阈值：纯色小图会被策略直接透传，压不到这条路径。
    const width = 1200;
    const height = 900;
    const color = (x: number, y: number) => [hash(x, y, 1), hash(x, y, 2), hash(x, y, 3)];
    const png = buildPng(width, height, { colorType: 6, bitDepth: 8 }, (x, y) => [...color(x, y), 255]);
    const processed = await prepareImageForApi(png);
    expect(processed.buffer.length).toBeLessThan(png.length);

    const decoded = decodePng(processed.buffer);
    expect(decoded.channels).toBe(3);
    expect(pixelAt(decoded, 5, 7)).toEqual(color(5, 7));
  });

  it('真有透明像素时保留 alpha', async () => {
    const png = buildPng(3200, 1600, { colorType: 6, bitDepth: 8 }, (x, y) =>
      x === y ? [0, 0, 0, 0] : [255, 255, 255, 255],
    );
    const processed = await prepareImageForApi(png);
    const decoded = decodePng(processed.buffer);
    expect(decoded.channels).toBe(4);
    // 缩小之后没有「完全透明」的像素了（面积平均会混进邻居），但 alpha 必须还在。
    const alphas = new Set<number>();
    for (let y = 0; y < decoded.height; y += 5) alphas.add(pixelAt(decoded, y, y)[3]!);
    expect(Math.min(...alphas)).toBeLessThan(255);
  });

  it('解不开的 PNG 退回原图，读图不因为这个失败', async () => {
    const png = buildPng(3200, 2000, { colorType: 6, bitDepth: 8 }, () => [1, 2, 3, 255]);
    const broken = png.subarray(0, 40);
    const processed = await prepareImageForApi(broken);
    expect(processed.buffer.equals(broken)).toBe(true);
  });

  it('非 PNG 格式原样透传（重编码要先自己写解码器）', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
    const processed = await prepareImageForApi(jpeg);
    expect(processed.mediaType).toBe('image/jpeg');
    expect(processed.buffer.equals(jpeg)).toBe(true);
  });

  it('长边超过接口硬上限的非 PNG 直接报错，不发出去换 400', async () => {
    const jpeg = buildJpegHeader(14075, 6530);
    await expect(prepareImageForApi(jpeg)).rejects.toThrow(
      `图片尺寸 14075x6530，长边超过接口上限 ${IMAGE_MAX_API_LONG_EDGE}px`,
    );
    // 刚好在上限上的图照旧透传。
    const edge = buildJpegHeader(IMAGE_MAX_API_LONG_EDGE, 100);
    const processed = await prepareImageForApi(edge);
    expect(processed.buffer.equals(edge)).toBe(true);
  });

  it('PNG 解不开又超过接口硬上限时报错，而不是把原图发出去', async () => {
    const png = buildPng(9000, 100, { colorType: 6, bitDepth: 8 }, () => [1, 2, 3, 255]);
    await expect(prepareImageForApi(png.subarray(0, 40))).rejects.toThrow('PNG 的无损缩放没能把它缩到这个尺寸以内');
  });

  it('空文件与不认识的格式抛错', async () => {
    await expect(prepareImageForApi(Buffer.alloc(0))).rejects.toThrow('image file is empty');
    await expect(prepareImageForApi(Buffer.from('hello world'))).rejects.toThrow('unsupported image format');
  });
});

describe('downscaleAreaAverage', () => {
  it('2:1 缩小时等权平均，棋盘格缩成中灰', () => {
    const data = new Uint8Array(4 * 4 * 3);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const value = (x + y) % 2 === 0 ? 255 : 0;
        const offset = (y * 4 + x) * 3;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
      }
    }
    const scaled = downscaleAreaAverage({ width: 4, height: 4, channels: 3, data }, 2, 2);
    expect([scaled.width, scaled.height]).toEqual([2, 2]);
    // 每个输出像素都是 2×2 的等量混合：127.5 → 128。
    expect(pixelAt(scaled, 0, 0)).toEqual([128, 128, 128]);
    expect(pixelAt(scaled, 1, 1)).toEqual([128, 128, 128]);
  });

  it('半透明像素按预乘 alpha 平均，边缘不会被拖黑', () => {
    const data = new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255]);
    const scaled = downscaleAreaAverage({ width: 2, height: 2, channels: 4, data }, 1, 1);
    // 一半全透明、一半不透明白：颜色应该还是白，alpha 是 128。
    expect(pixelAt(scaled, 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it('已经是目标尺寸时原样返回', () => {
    const image = { width: 2, height: 2, channels: 3 as const, data: new Uint8Array(12) };
    expect(downscaleAreaAverage(image, 2, 2)).toBe(image);
  });
});

describe('encodePng / decodePng', () => {
  it('往返之后像素完全一致（无损）', () => {
    const width = 96;
    const height = 64;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 251;
    const decoded = decodePng(encodePng({ width, height, channels: 4, data }));
    expect(decoded.width).toBe(width);
    expect(decoded.channels).toBe(4);
    expect(Buffer.from(decoded.data).equals(Buffer.from(data))).toBe(true);
  });
});

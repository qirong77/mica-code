import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PNG 的解码与编码，只覆盖「重新打包一次」需要的子集：非隔行、灰度 / RGB /
 * 灰度+alpha / RGBA（8bit 与 16bit），以及任意位深的调色板图。其余变体
 * （Adam7 隔行）抛错，由调用方退回原图字节。
 *
 * 16bit 会降到 8bit（取高字节）：macOS 从剪贴板写出的截图就是 16bit RGB，
 * 而模型接口只吃 8bit——留着 16bit 既没人能看，又白占一倍体积。
 *
 * 不用 `sharp` 这类原生依赖：这条链路在 CLI、app-server、桌面渲染层都会跑，
 * 加一个带平台二进制的包会把打包与交叉编译一起拖进来。纯 zlib 够用——PNG 的
 * 压缩层本来就是 deflate。
 */

export type RasterImage = {
  width: number;
  height: number;
  /** 3 = RGB，4 = RGBA；8bit 逐像素紧密排列。 */
  channels: 3 | 4;
  data: Uint8Array;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PngChunk = { type: string; data: Buffer };

type PngHeader = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
};

export function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function decodePng(buffer: Buffer): RasterImage {
  if (!isPng(buffer)) throw new Error('not a png');
  const chunks = readChunks(buffer);
  const headerChunk = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!headerChunk || headerChunk.data.length < 13) throw new Error('png missing IHDR');
  const header: PngHeader = {
    width: headerChunk.data.readUInt32BE(0),
    height: headerChunk.data.readUInt32BE(4),
    bitDepth: headerChunk.data[8]!,
    colorType: headerChunk.data[9]!,
    interlace: headerChunk.data[12]!,
  };
  if (header.interlace !== 0) throw new Error('interlaced png unsupported');
  if (header.width <= 0 || header.height <= 0) throw new Error('png has empty dimensions');
  const paletteSamples = header.colorType === 3 && [1, 2, 4, 8].includes(header.bitDepth);
  const directSamples = header.colorType !== 3 && (header.bitDepth === 8 || header.bitDepth === 16);
  if (!paletteSamples && !directSamples) {
    throw new Error(`unsupported png bit depth ${header.bitDepth} for color type ${header.colorType}`);
  }

  const paletteChunk = chunks.find((chunk) => chunk.type === 'PLTE');
  const transparencyChunk = chunks.find((chunk) => chunk.type === 'tRNS');
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (!idat.length) throw new Error('png missing IDAT');

  const channels = channelsOf(header.colorType);
  const bitsPerPixel = channels * header.bitDepth;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((header.width * bitsPerPixel) / 8);
  const raw = inflateSync(idat);
  if (raw.length < (stride + 1) * header.height) throw new Error('png pixel data truncated');
  unfilter(raw, stride, header.height, bytesPerPixel);

  const outChannels: 3 | 4 = header.colorType === 6 || header.colorType === 4 || transparencyChunk ? 4 : 3;
  const data = new Uint8Array(header.width * header.height * outChannels);
  expand(raw, stride, header, outChannels, data, paletteChunk?.data, transparencyChunk?.data);
  return { width: header.width, height: header.height, channels: outChannels, data };
}

/**
 * 逐行挑 filter（PNG 规范推荐的「最小绝对值和」启发式），再交给 zlib 最高级别
 * 压一次。这一步是无损的：像素一个不差，只是把字节数压下来。
 */
export function encodePng(image: RasterImage): Buffer {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  const current = Buffer.allocUnsafe(stride);
  const previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    for (let i = 0; i < stride; i++) {
      current[i] = data[rowStart + i]!;
      previous[i] = y === 0 ? 0 : data[rowStart - stride + i]!;
    }
    const bestFilter = pickFilter(current, previous, channels);
    raw[y * (stride + 1)] = bestFilter;
    writeFiltered(bestFilter, current, previous, channels, raw, y * (stride + 1) + 1);
  }

  // 级别 6 与 9 的差别只有 2–4% 体积，却差好几倍时间；这里换时间。
  const compressed = deflateSync(raw, { level: 6, memLevel: 9 });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function hasTransparentPixels(image: RasterImage): boolean {
  if (image.channels !== 4) return false;
  const { data } = image;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`unsupported png color type ${colorType}`);
  }
}

function readChunks(buffer: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error('png chunk truncated');
    chunks.push({ type, data: buffer.subarray(start, end) });
    if (type === 'IEND') break;
    offset = end + 4;
  }
  return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 原地反滤波：每个 scanline 头部的 filter 字节占 1 位，处理后仍留在原位置。 */
function unfilter(raw: Buffer, stride: number, height: number, bytesPerPixel: number): void {
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const start = y * (stride + 1) + 1;
    const previousStart = start - (stride + 1);
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bytesPerPixel; i < stride; i++)
          raw[start + i] = (raw[start + i]! + raw[start + i - bytesPerPixel]!) & 0xff;
        break;
      case 2:
        if (y === 0) break;
        for (let i = 0; i < stride; i++) raw[start + i] = (raw[start + i]! + raw[previousStart + i]!) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= bytesPerPixel ? raw[start + i - bytesPerPixel]! : 0;
          const up = y === 0 ? 0 : raw[previousStart + i]!;
          raw[start + i] = (raw[start + i]! + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const left = i >= bytesPerPixel ? raw[start + i - bytesPerPixel]! : 0;
          const up = y === 0 ? 0 : raw[previousStart + i]!;
          const upLeft = i >= bytesPerPixel && y > 0 ? raw[previousStart + i - bytesPerPixel]! : 0;
          raw[start + i] = (raw[start + i]! + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`unsupported png filter ${filter}`);
    }
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** 把解出来的扫描线展开成 8bit RGB / RGBA。 */
function expand(
  raw: Buffer,
  stride: number,
  header: PngHeader,
  outChannels: 3 | 4,
  out: Uint8Array,
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
): void {
  const { width, height, bitDepth, colorType } = header;
  // 16bit 取样是大端两字节，高字节才是 8bit 精度里该留的那一档。
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * outChannels;
      if (colorType === 3) {
        if (!palette) throw new Error('palette png missing PLTE');
        const index = readSample(raw, start, x, bitDepth);
        const base = index * 3;
        if (base + 2 >= palette.length) throw new Error('palette index out of range');
        out[target] = palette[base]!;
        out[target + 1] = palette[base + 1]!;
        out[target + 2] = palette[base + 2]!;
        if (outChannels === 4)
          out[target + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
        continue;
      }
      const offset = start + x * (colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1) * sampleBytes;
      if (colorType === 0) {
        const gray = raw[offset]!;
        out[target] = gray;
        out[target + 1] = gray;
        out[target + 2] = gray;
      } else if (colorType === 4) {
        const gray = raw[offset]!;
        out[target] = gray;
        out[target + 1] = gray;
        out[target + 2] = gray;
        out[target + 3] = raw[offset + sampleBytes]!;
      } else if (colorType === 2) {
        out[target] = raw[offset]!;
        out[target + 1] = raw[offset + sampleBytes]!;
        out[target + 2] = raw[offset + sampleBytes * 2]!;
      } else {
        out[target] = raw[offset]!;
        out[target + 1] = raw[offset + sampleBytes]!;
        out[target + 2] = raw[offset + sampleBytes * 2]!;
        out[target + 3] = raw[offset + sampleBytes * 3]!;
      }
      if (outChannels === 4 && colorType !== 4 && colorType !== 6) out[target + 3] = 255;
    }
  }
}

function readSample(raw: Buffer, rowStart: number, index: number, bitDepth: number): number {
  if (bitDepth === 8) return raw[rowStart + index]!;
  const perByte = 8 / bitDepth;
  const byte = raw[rowStart + Math.floor(index / perByte)]!;
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/**
 * 一趟扫描同时给 5 个 filter 打分（负值按有符号字节取绝对值累加），选最小的那个。
 * Paeth 只算一次而不是每个 filter 各算一次，是这段最费时的循环里最值钱的优化。
 */
function pickFilter(current: Buffer, previous: Buffer, bytesPerPixel: number): number {
  const length = current.length;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  for (let i = 0; i < length; i++) {
    const value = current[i]!;
    const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
    const up = previous[i]!;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
    s0 += absSigned(value);
    s1 += absSigned((value - left) & 0xff);
    s2 += absSigned((value - up) & 0xff);
    s3 += absSigned((value - ((left + up) >> 1)) & 0xff);
    s4 += absSigned((value - paeth(left, up, upLeft)) & 0xff);
  }
  let best = 0;
  let bestScore = s0;
  if (s1 < bestScore) {
    best = 1;
    bestScore = s1;
  }
  if (s2 < bestScore) {
    best = 2;
    bestScore = s2;
  }
  if (s3 < bestScore) {
    best = 3;
    bestScore = s3;
  }
  if (s4 < bestScore) best = 4;
  return best;
}

function absSigned(byte: number): number {
  return byte < 128 ? byte : 256 - byte;
}

function writeFiltered(
  filter: number,
  current: Buffer,
  previous: Buffer,
  bytesPerPixel: number,
  out: Buffer,
  offset: number,
): void {
  const length = current.length;
  switch (filter) {
    case 0:
      current.copy(out, offset);
      return;
    case 1:
      for (let i = 0; i < length; i++) {
        out[offset + i] = (current[i]! - (i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0)) & 0xff;
      }
      return;
    case 2:
      for (let i = 0; i < length; i++) out[offset + i] = (current[i]! - previous[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < length; i++) {
        const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
        out[offset + i] = (current[i]! - ((left + previous[i]!) >> 1)) & 0xff;
      }
      return;
    default:
      for (let i = 0; i < length; i++) {
        const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
        const up = previous[i]!;
        const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
        out[offset + i] = (current[i]! - paeth(left, up, upLeft)) & 0xff;
      }
  }
}

let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

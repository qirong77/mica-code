import { decodePng, encodePng, hasTransparentPixels, isPng, type RasterImage } from './imagePng.js';
import { downscaleAreaAverage } from './imageResample.js';

export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type ProcessedImage = {
  buffer: Buffer;
  mediaType: SupportedImageMediaType;
  /** 实际发送的像素尺寸。 */
  width?: number;
  height?: number;
  /** 原图像素尺寸，与上一组不同就说明缩过。 */
  sourceWidth?: number;
  sourceHeight?: number;
  /** 像素尺寸是否被缩小（只是无损重打包时为 false）。 */
  resized: boolean;
};

/**
 * 发送给模型的长边上限。
 *
 * Retina 截图动辄 3024×1964、单张 base64 就有 4–5MB，十几张就能把一次请求顶到
 * 网关的请求体上限（实测 DeepSeek 8/16/24/32MB 能过、48MB 起 413）。1568 是视觉
 * 模型实际能看清的上限区间：截图的逻辑分辨率通常就在 1440–1728，缩到这个尺寸
 * 仍然是「人眼看到的那一版」，而不是把字模糊掉。
 */
export const IMAGE_MAX_LONG_EDGE = 1568;

/**
 * 小于这个字节数的 PNG 不重打包。重编码本身无损，但只有几 KB 的小图不值得为它
 * 花一次解码 + deflate 的时间。
 */
export const IMAGE_MIN_REPACK_BYTES = 512 * 1024;

/**
 * 接口对单边像素长度的硬上限。
 *
 * DeepSeek 的 `/responses` 实测：8192×4096 能过，8193×100 起直接 400，报错文案却是
 * 「unsupported image … formats: webp, png, jpeg, and gif」——它按尺寸拒收，却说自己
 * 不认格式。这条 400 不可重试，整个 turn 直接失败，所以要在本机拦住。
 *
 * PNG 走下面的缩放，到不了这里；JPEG/GIF/WebP 不重编码，超限只能报错让模型换手段
 * （缩小、裁剪，或分段读）。
 */
export const IMAGE_MAX_API_LONG_EDGE = 8192;

/**
 * 校验图片，并在需要时压小它。
 *
 * 策略（只对 PNG 生效，其它格式原样透传——重编码 JPEG/WebP 需要先自己写解码器，
 * 见下面 `packages/mica-agent/providers/imageBudget.ts` 里按请求总量兜底的那一层）：
 * - 已经够小：字节一个不改，完全无损；
 * - 尺寸超出长边上限：面积平均缩到上限，再无损重编码；
 * - 只是字节偏大：只重打包，像素一个不差；
 * - 任何一步失败：退回原图，压缩不能挡住「读这张图」这件事。
 * - 最终长边仍超过接口硬上限（8192）：抛错，而不是让请求在服务端 400。
 */
export async function prepareImageForApi(imageBuffer: Buffer): Promise<ProcessedImage> {
  if (imageBuffer.length === 0) throw new Error('image file is empty');

  const mediaType = detectImageMediaType(imageBuffer);
  if (!mediaType) throw new Error('unsupported image format');

  const dimensions = detectImageDimensions(imageBuffer, mediaType);
  const original: ProcessedImage = {
    buffer: imageBuffer,
    mediaType,
    ...dimensions,
    sourceWidth: dimensions.width,
    sourceHeight: dimensions.height,
    resized: false,
  };

  if (mediaType !== 'image/png' || !isPng(imageBuffer)) return assertWithinApiLimit(original);
  const longestEdge = Math.max(dimensions.width ?? 0, dimensions.height ?? 0);
  const overLimit = longestEdge > IMAGE_MAX_LONG_EDGE;
  if (!overLimit && imageBuffer.length <= IMAGE_MIN_REPACK_BYTES) return assertWithinApiLimit(original);

  let processed = original;
  try {
    processed = squeezePng(imageBuffer) ?? original;
  } catch {
    processed = original;
  }
  return assertWithinApiLimit(processed);
}

/**
 * 发送前的最后一道尺寸闸：超过接口硬上限的图发出去只会换来一条 400，
 * 报错文案还说自己不认格式。在这里抛，模型拿到的是一条能照做的提示。
 */
function assertWithinApiLimit(image: ProcessedImage): ProcessedImage {
  const longestEdge = Math.max(image.width ?? 0, image.height ?? 0);
  if (longestEdge <= IMAGE_MAX_API_LONG_EDGE) return image;
  const reason =
    image.mediaType === 'image/png'
      ? 'PNG 的无损缩放没能把它缩到这个尺寸以内'
      : `${image.mediaType} 在本机不重编码，会原样上行`;
  throw new Error(
    `图片尺寸 ${image.width}x${image.height}，长边超过接口上限 ${IMAGE_MAX_API_LONG_EDGE}px（${reason}）。` +
      '请先缩小或裁剪再读，例如 `sips -Z 1568 <原图> --out <新路径>`；原图信息需要细分时按区域分段截图。',
  );
}

function squeezePng(buffer: Buffer): ProcessedImage | null {
  const raster = decodePng(buffer);
  const target = fitWithinLongEdge(raster.width, raster.height, IMAGE_MAX_LONG_EDGE);
  const scaled = downscaleAreaAverage(raster, target.width, target.height);
  const encoded = encodePng(dropAlphaIfOpaque(scaled));
  const resized = scaled.width !== raster.width || scaled.height !== raster.height;
  // 没缩尺寸、重打包反而更大：留着原字节，别做赔本买卖。
  if (!resized && encoded.length >= buffer.length) return null;
  return {
    buffer: encoded,
    mediaType: 'image/png',
    width: scaled.width,
    height: scaled.height,
    sourceWidth: raster.width,
    sourceHeight: raster.height,
    resized,
  };
}

/** 完全不透明的图去掉 alpha 通道：像素不变，原始数据少四分之一。 */
function dropAlphaIfOpaque(image: RasterImage): RasterImage {
  if (image.channels !== 4 || hasTransparentPixels(image)) return image;
  const data = new Uint8Array(image.width * image.height * 3);
  for (let source = 0, target = 0; source < image.data.length; source += 4, target += 3) {
    data[target] = image.data[source]!;
    data[target + 1] = image.data[source + 1]!;
    data[target + 2] = image.data[source + 2]!;
  }
  return { width: image.width, height: image.height, channels: 3, data };
}

export function fitWithinLongEdge(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function detectImageMediaType(buffer: Buffer): SupportedImageMediaType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
    return 'image/png';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

function detectImageDimensions(
  buffer: Buffer,
  mediaType: SupportedImageMediaType,
): { width?: number; height?: number } {
  if (mediaType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mediaType === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mediaType === 'image/webp' && buffer.length >= 30 && buffer.subarray(12, 16).toString('ascii') === 'VP8X') {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }
  if (mediaType === 'image/jpeg') return detectJpegDimensions(buffer);
  return {};
}

function detectJpegDimensions(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + segmentLength + 2 > buffer.length) return {};
    if (isJpegStartOfFrame(marker) && segmentLength >= 7) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += segmentLength + 2;
  }
  return {};
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

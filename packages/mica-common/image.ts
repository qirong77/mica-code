export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type ProcessedImage = {
  buffer: Buffer;
  mediaType: SupportedImageMediaType;
  width?: number;
  height?: number;
  resized: false;
};

/** Validate an image and preserve its original bytes for the upstream model API. */
export async function prepareImageForApi(imageBuffer: Buffer): Promise<ProcessedImage> {
  if (imageBuffer.length === 0) throw new Error('image file is empty');

  const mediaType = detectImageMediaType(imageBuffer);
  if (!mediaType) throw new Error('unsupported image format');

  const dimensions = detectImageDimensions(imageBuffer, mediaType);
  return {
    buffer: imageBuffer,
    mediaType,
    ...dimensions,
    resized: false,
  };
}

function detectImageMediaType(buffer: Buffer): SupportedImageMediaType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
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

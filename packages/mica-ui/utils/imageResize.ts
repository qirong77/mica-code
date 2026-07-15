import sharp from 'sharp';

export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;
export const IMAGE_TARGET_RAW_SIZE = Math.floor((API_IMAGE_MAX_BASE64_SIZE * 3) / 4);
export const IMAGE_MAX_WIDTH = 2000;
export const IMAGE_MAX_HEIGHT = 2000;

const JPEG_QUALITIES = [80, 60, 40, 20] as const;

export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type ProcessedImage = {
  buffer: Buffer;
  mediaType: SupportedImageMediaType;
  width?: number;
  height?: number;
  resized: boolean;
};

type ImageLimits = {
  targetRawSize: number;
  maxBase64Size: number;
  maxWidth: number;
  maxHeight: number;
};

const DEFAULT_LIMITS: ImageLimits = {
  targetRawSize: IMAGE_TARGET_RAW_SIZE,
  maxBase64Size: API_IMAGE_MAX_BASE64_SIZE,
  maxWidth: IMAGE_MAX_WIDTH,
  maxHeight: IMAGE_MAX_HEIGHT,
};

/** Resize and compress an image before embedding it in an API request. */
export async function prepareImageForApi(
  imageBuffer: Buffer,
  limits: Partial<ImageLimits> = {},
): Promise<ProcessedImage> {
  if (imageBuffer.length === 0) throw new Error('image file is empty');

  const configuredLimits = { ...DEFAULT_LIMITS, ...limits };
  const resolvedLimits = {
    ...configuredLimits,
    targetRawSize: Math.min(configuredLimits.targetRawSize, maxRawBytesForBase64(configuredLimits.maxBase64Size)),
  };
  let safeOriginal: ProcessedImage | null = null;
  try {
    const metadata = await sharp(imageBuffer).metadata();
    const mediaType = mediaTypeFromFormat(metadata.format) ?? detectImageMediaType(imageBuffer);
    if (!mediaType) throw new Error(`unsupported image format: ${metadata.format ?? 'unknown'}`);
    if (!metadata.width || !metadata.height) {
      throw new Error('unable to determine image dimensions');
    }

    const originalWidth = metadata.width;
    const originalHeight = metadata.height;
    const exceedsDimensionLimit = originalWidth > resolvedLimits.maxWidth || originalHeight > resolvedLimits.maxHeight;
    if (!exceedsDimensionLimit && base64Size(imageBuffer.length) <= resolvedLimits.maxBase64Size) {
      safeOriginal = {
        buffer: imageBuffer,
        mediaType,
        width: originalWidth,
        height: originalHeight,
        resized: false,
      };
    }
    if (
      imageBuffer.length <= resolvedLimits.targetRawSize &&
      originalWidth <= resolvedLimits.maxWidth &&
      originalHeight <= resolvedLimits.maxHeight
    ) {
      return {
        buffer: imageBuffer,
        mediaType,
        width: originalWidth,
        height: originalHeight,
        resized: false,
      };
    }

    const dimensions = fitInside(originalWidth, originalHeight, resolvedLimits.maxWidth, resolvedLimits.maxHeight);
    const needsDimensionResize = dimensions.width !== originalWidth || dimensions.height !== originalHeight;

    if (!needsDimensionResize && imageBuffer.length > resolvedLimits.targetRawSize) {
      const compressed = await compressToTarget(imageBuffer, mediaType, resolvedLimits.targetRawSize);
      if (compressed) return { ...compressed, width: originalWidth, height: originalHeight, resized: true };
    }

    const resizedBuffer = await sharp(imageBuffer)
      .resize(dimensions.width, dimensions.height, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    if (resizedBuffer.length <= resolvedLimits.targetRawSize) {
      return {
        buffer: resizedBuffer,
        mediaType,
        width: dimensions.width,
        height: dimensions.height,
        resized: true,
      };
    }

    const compressed = await compressToTarget(imageBuffer, mediaType, resolvedLimits.targetRawSize, dimensions);
    if (compressed) return { ...compressed, ...dimensions, resized: true };

    const smaller = fitInside(dimensions.width, dimensions.height, 1000, resolvedLimits.maxHeight);
    const buffer = await sharp(imageBuffer)
      .resize(smaller.width, smaller.height, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer();
    if (base64Size(buffer.length) > resolvedLimits.maxBase64Size) {
      throw new Error('compressed image still exceeds the API size limit');
    }
    return { buffer, mediaType: 'image/jpeg', ...smaller, resized: true };
  } catch (error) {
    // If image processing is unavailable, preserve a request-safe original image.
    if (safeOriginal) return safeOriginal;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to resize image: ${message}`);
  }
}

async function compressToTarget(
  imageBuffer: Buffer,
  mediaType: SupportedImageMediaType,
  targetBytes: number,
  dimensions?: { width: number; height: number },
): Promise<Pick<ProcessedImage, 'buffer' | 'mediaType'> | null> {
  const pipeline = () => {
    const image = sharp(imageBuffer);
    return dimensions
      ? image.resize(dimensions.width, dimensions.height, { fit: 'inside', withoutEnlargement: true })
      : image;
  };

  if (mediaType === 'image/png') {
    const buffer = await pipeline().png({ compressionLevel: 9, palette: true }).toBuffer();
    if (buffer.length <= targetBytes) return { buffer, mediaType: 'image/png' };
  }

  for (const quality of JPEG_QUALITIES) {
    const buffer = await pipeline().jpeg({ quality }).toBuffer();
    if (buffer.length <= targetBytes) return { buffer, mediaType: 'image/jpeg' };
  }
  return null;
}

function fitInside(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function base64Size(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

function maxRawBytesForBase64(maxBase64Size: number): number {
  return Math.floor(maxBase64Size / 4) * 3;
}

function mediaTypeFromFormat(format: string | undefined): SupportedImageMediaType | null {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

function detectImageMediaType(buffer: Buffer): SupportedImageMediaType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
    return 'image/png';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

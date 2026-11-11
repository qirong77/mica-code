export type ImageTransformResult = {
  src: string;
  width: number;
  height: number;
};

export type ImageCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MAX_OUTPUT_EDGE = 4096;
const MAX_OUTPUT_PIXELS = 16_000_000;
const INVALID_CROP = '裁剪范围无效，请在图片内重新选择区域。';

/** Intersect a normalized selection with the image; an empty selection is invalid. */
export function clampCrop(crop: ImageCropRect): ImageCropRect {
  if (
    ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
    crop.width <= 0 ||
    crop.height <= 0
  ) {
    throw new Error(INVALID_CROP);
  }

  const x = Math.max(0, crop.x);
  const y = Math.max(0, crop.y);
  const right = Math.min(1, crop.x + crop.width);
  const bottom = Math.min(1, crop.y + crop.height);
  if (right <= x || bottom <= y) {
    throw new Error(INVALID_CROP);
  }
  return {x, y, width: right - x, height: bottom - y};
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('图片尺寸无效，无法处理这张图片。');
  }
}

function fitOutputSize(width: number, height: number) {
  validateDimensions(width, height);
  const edgeScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));
  const boundedWidth = Math.max(1, Math.floor(width * edgeScale));
  const boundedHeight = Math.max(1, Math.floor(height * edgeScale));
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_OUTPUT_PIXELS / (boundedWidth * boundedHeight)),
  );
  return {
    width: Math.max(1, Math.floor(boundedWidth * pixelScale)),
    height: Math.max(1, Math.floor(boundedHeight * pixelScale)),
  };
}

function getCropPixels(width: number, height: number, crop: ImageCropRect) {
  validateDimensions(width, height);
  const normalized = clampCrop(crop);
  const x = Math.min(width - 1, Math.round(normalized.x * width));
  const y = Math.min(height - 1, Math.round(normalized.y * height));
  return {
    x,
    y,
    width: Math.min(width - x, Math.max(1, Math.round(normalized.width * width))),
    height: Math.min(height - y, Math.max(1, Math.round(normalized.height * height))),
  };
}

/** The dialog can show the exact output dimensions without loading or drawing an image. */
export function getCropOutputSize(
  width: number,
  height: number,
  crop: ImageCropRect,
): {width: number; height: number} {
  const pixels = getCropPixels(width, height, crop);
  return fitOutputSize(pixels.width, pixels.height);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!src.trim()) {
      reject(new Error('图片地址为空，无法处理图片。'));
      return;
    }

    const image = new Image();
    const clear = () => {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
    };
    const fail = () => {
      clear();
      reject(new Error('图片加载失败，请检查图片链接及跨域访问权限，或下载后重新插入。'));
    };
    const timeout = setTimeout(fail, 30_000);
    image.onload = () => {
      clear();
      try {
        validateDimensions(image.naturalWidth, image.naturalHeight);
        resolve(image);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = fail;
    // Set CORS before src, including for cached remote images. Local image URLs
    // do not need CORS, and the preview itself never processes the image.
    if (!/^(data:image\/|blob:)/i.test(src.trim())) {
      image.crossOrigin = 'anonymous';
    }
    image.src = src;
  });
}

function renderPNG(
  width: number,
  height: number,
  draw: (context: CanvasRenderingContext2D) => void,
): ImageTransformResult {
  const size = fitOutputSize(width, height);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('当前浏览器无法处理图片，请换用支持 Canvas 的浏览器。');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    draw(context);
    // PNG preserves transparency and never silently re-encodes as lossy JPEG.
    const src = canvas.toDataURL('image/png');
    if (!src.startsWith('data:image/png')) {
      throw new Error('浏览器无法生成图片，请缩小裁剪范围后重试。');
    }
    return {src, ...size};
  } catch (error) {
    if (error instanceof Error && error.name === 'SecurityError') {
      throw new Error('这张图片未允许跨域处理，无法裁剪或旋转。请下载后重新插入图片。');
    }
    if (error instanceof Error && /^(当前浏览器|浏览器无法)/.test(error.message)) {
      throw error;
    }
    throw new Error('图片处理失败，浏览器无法生成图片，请重试。');
  }
}

/** Called only by the explicit rotate action. Positive Canvas rotation is clockwise. */
export async function rotateImage(src: string): Promise<ImageTransformResult> {
  const image = await loadImage(src);
  const size = fitOutputSize(image.naturalHeight, image.naturalWidth);
  return renderPNG(size.width, size.height, (context) => {
    context.translate(size.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(image, 0, 0, size.height, size.width);
  });
}

/** Called only when the user applies a crop; the original src stays unchanged until then. */
export async function cropImage(
  src: string,
  crop: ImageCropRect,
): Promise<ImageTransformResult> {
  const normalized = clampCrop(crop);
  const image = await loadImage(src);
  const pixels = getCropPixels(image.naturalWidth, image.naturalHeight, normalized);
  const size = fitOutputSize(pixels.width, pixels.height);
  return renderPNG(size.width, size.height, (context) => {
    context.drawImage(
      image,
      pixels.x,
      pixels.y,
      pixels.width,
      pixels.height,
      0,
      0,
      size.width,
      size.height,
    );
  });
}

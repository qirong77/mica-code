import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  clampCrop,
  cropImage,
  getCropOutputSize,
  rotateImage,
  type ImageCropRect,
} from '../src/playground/ui/imageTransform';

const FULL_CROP = {x: 0, y: 0, width: 1, height: 1};
const PNG = 'data:image/png;base64,transformed';

function imageEnvironment({width = 1200, height = 800, loadFails = false} = {}) {
  const assignments: string[] = [];
  const images: MockImage[] = [];
  class MockImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private origin: string | null = null;
    private source = '';

    constructor() {
      images.push(this);
    }

    set crossOrigin(value: string | null) {
      this.origin = value;
      assignments.push(`crossOrigin:${value}`);
    }

    get crossOrigin() {
      return this.origin;
    }

    set src(value: string) {
      this.source = value;
      assignments.push(`src:${value}`);
      queueMicrotask(() => {
        if (loadFails) {
          this.onerror?.();
        } else {
          this.onload?.();
        }
      });
    }

    get src() {
      return this.source;
    }
  }

  const context = {
    drawImage: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn<() => typeof context | null>(() => context),
    toDataURL: vi.fn(() => PNG),
  };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal('Image', MockImage);
  vi.stubGlobal('document', {createElement});
  return {images, assignments, context, canvas, createElement};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalized image crops', () => {
  it('preserves an in-bounds rectangle without mutating it', () => {
    const crop = Object.freeze({x: 0.125, y: 0.25, width: 0.5, height: 0.5});
    expect(clampCrop(crop)).toEqual(crop);
  });

  it('intersects a selection with all four image boundaries', () => {
    expect(clampCrop({x: -0.25, y: -0.5, width: 1.5, height: 2})).toEqual(FULL_CROP);
    expect(clampCrop({x: 0.75, y: 0.5, width: 0.5, height: 0.75})).toEqual({
      x: 0.75, y: 0.5, width: 0.25, height: 0.5,
    });
  });

  it.each<ImageCropRect>([
    {x: 0, y: 0, width: 0, height: 1},
    {x: 0, y: 0, width: 1, height: -1},
    {x: 1, y: 0, width: 1, height: 1},
    {x: 0, y: -2, width: 1, height: 1},
    {x: Number.NaN, y: 0, width: 1, height: 1},
    {x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1},
  ])('rejects empty, non-finite, or completely outside selections: %j', (crop) => {
    expect(() => clampCrop(crop)).toThrow('裁剪范围无效');
  });

  it('reports pixel output without requiring any browser globals', () => {
    expect(getCropOutputSize(1200, 800, {x: 0.25, y: 0.25, width: 0.5, height: 0.5})).toEqual({
      width: 600, height: 400,
    });
    expect(getCropOutputSize(1200, 800, {x: 0.999999, y: 0.999999, width: 0.000001, height: 0.000001})).toEqual({
      width: 1, height: 1,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid source dimensions (%s)', (value) => {
    expect(() => getCropOutputSize(value, 800, FULL_CROP)).toThrow('图片尺寸无效');
    expect(() => getCropOutputSize(1200, value, FULL_CROP)).toThrow('图片尺寸无效');
  });
});

describe('image transforms', () => {
  it('converts a normalized crop to source pixels and encodes a transparent PNG', async () => {
    const {images, context, canvas, createElement} = imageEnvironment();
    const result = await cropImage('https://example.com/image.png', {
      x: 0.25, y: 0.25, width: 0.5, height: 0.5,
    });
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect(context.drawImage).toHaveBeenCalledWith(images[0], 300, 200, 600, 400, 0, 0, 600, 400);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(400);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
    expect(result).toEqual({src: PNG, width: 600, height: 400});
  });

  it('rotates clockwise: the original top left moves to the output top right', async () => {
    const {images, context, canvas, assignments} = imageEnvironment({width: 400, height: 200});
    const result = await rotateImage('https://example.com/image.png');
    expect(assignments).toEqual(['crossOrigin:anonymous', 'src:https://example.com/image.png']);
    expect([canvas.width, canvas.height]).toEqual([200, 400]);
    expect(context.translate).toHaveBeenCalledWith(200, 0);
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 400, 200);
    expect(context.translate.mock.invocationCallOrder[0]).toBeLessThan(context.rotate.mock.invocationCallOrder[0]);
    expect(context.rotate.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
    expect(result).toEqual({src: PNG, width: 200, height: 400});
  });

  it('clips a crop at the source edge and keeps even tiny selections drawable', async () => {
    const {images, context} = imageEnvironment({width: 100, height: 80});
    expect(await cropImage('blob:original', {x: 0.995, y: 0.995, width: 0.1, height: 0.1})).toEqual({
      src: PNG, width: 1, height: 1,
    });
    expect(context.drawImage).toHaveBeenCalledWith(images[0], 99, 79, 1, 1, 0, 0, 1, 1);
  });

  it('caps the long edge while retaining the rotation direction and aspect', async () => {
    const {images, context} = imageEnvironment({width: 10_000, height: 5000});
    expect(await rotateImage('blob:large')).toEqual({src: PNG, width: 2048, height: 4096});
    expect(context.translate).toHaveBeenCalledWith(2048, 0);
    expect(context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 4096, 2048);
  });

  it('also caps total pixels for a large square crop without lossy encoding', async () => {
    const {canvas} = imageEnvironment({width: 10_000, height: 10_000});
    const result = await cropImage('blob:large', FULL_CROP);
    expect(result).toEqual({src: PNG, width: 4000, height: 4000});
    expect(result.width * result.height).toBeLessThanOrEqual(16_000_000);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
  });

  it.each(['data:image/png;base64,original', 'blob:original'])('does not require CORS for local image URLs (%s)', async (src) => {
    const {images, assignments} = imageEnvironment();
    await rotateImage(src);
    expect(images[0].crossOrigin).toBeNull();
    expect(assignments).toEqual([`src:${src}`]);
  });

  it('rejects an invalid selection before creating an image or a canvas', async () => {
    const {images, createElement} = imageEnvironment();
    await expect(cropImage('blob:original', {...FULL_CROP, width: 0})).rejects.toThrow('裁剪范围无效');
    expect(images).toHaveLength(0);
    expect(createElement).not.toHaveBeenCalled();
  });

  it('reports a real image-load failure without attempting to draw', async () => {
    const {createElement} = imageEnvironment({loadFails: true});
    await expect(rotateImage('https://example.com/private.png')).rejects.toThrow('图片加载失败');
    expect(createElement).not.toHaveBeenCalled();
  });

  it('rejects a loaded image with invalid dimensions before allocating a canvas', async () => {
    const {createElement} = imageEnvironment({width: 0});
    await expect(rotateImage('blob:broken')).rejects.toThrow('图片尺寸无效');
    expect(createElement).not.toHaveBeenCalled();
  });

  it('reports an unavailable Canvas context in Chinese', async () => {
    const {canvas} = imageEnvironment();
    canvas.getContext.mockReturnValue(null);
    await expect(cropImage('blob:original', FULL_CROP)).rejects.toThrow('当前浏览器无法处理图片');
  });

  it('explains a tainted Canvas failure instead of exposing a browser exception', async () => {
    const {canvas} = imageEnvironment();
    const securityError = new Error('Tainted canvases may not be exported');
    securityError.name = 'SecurityError';
    canvas.toDataURL.mockImplementation(() => { throw securityError; });
    await expect(rotateImage('https://example.com/remote.png')).rejects.toThrow('这张图片未允许跨域处理');
  });

  it('reports unsuccessful PNG export instead of returning an empty data URL', async () => {
    const {canvas} = imageEnvironment();
    canvas.toDataURL.mockReturnValue('data:,');
    await expect(rotateImage('blob:original')).rejects.toThrow('浏览器无法生成图片');
  });
});

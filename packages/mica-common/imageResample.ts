import type { RasterImage } from './imagePng.js';

/**
 * 降采样用面积平均（box/area），不是双线性也不是 Lanczos。
 *
 * 缩小的场景里面积平均是唯一「每个源像素都被算进去」的滤波器：它等价于先低通
 * 再抽样，因此不会像最近邻那样丢掉细笔画，也不会像 Lanczos 那样在文字边缘留振铃。
 * Retina 截图按 2:1 缩回逻辑像素时权重退化成 2×2 四等分，等于把物理像素按颜色
 * 精确平均——这类图能做到的最好结果。
 *
 * 半透明像素按预乘 alpha 平均，否则透明区会把边缘拖黑。中间结果一律是预乘过的
 * Float32，只有最后一个通道写回 8bit 时才除回 alpha。
 */
export function downscaleAreaAverage(image: RasterImage, targetWidth: number, targetHeight: number): RasterImage {
  const width = Math.max(1, Math.min(targetWidth, image.width));
  const height = Math.max(1, Math.min(targetHeight, image.height));
  if (width === image.width && height === image.height) return image;

  const { channels } = image;
  const source = { data: image.data as Uint8Array | Float32Array, premultiplied: false };
  // 先横后竖还是先竖后横，取决于哪个中间缓冲更小：2 倍缩放的截图两边差一倍内存。
  if (width * image.height <= image.width * height) {
    const middle = resizeAxis(source, image.width, image.height, channels, width, 'x');
    const data = resizeAxis(
      { data: middle, premultiplied: channels === 4 },
      width,
      image.height,
      channels,
      height,
      'y',
      true,
    );
    return { width, height, channels, data: data as Uint8Array };
  }
  const middle = resizeAxis(source, image.width, image.height, channels, height, 'y');
  const data = resizeAxis(
    { data: middle, premultiplied: channels === 4 },
    image.width,
    height,
    channels,
    width,
    'x',
    true,
  );
  return { width, height, channels, data: data as Uint8Array };
}

type Contribution = { start: number; weights: Float32Array };

type AxisSource = { data: Uint8Array | Float32Array; premultiplied: boolean };

function axisContributions(sourceLength: number, targetLength: number): Contribution[] {
  const ratio = sourceLength / targetLength;
  const contributions: Contribution[] = [];
  for (let target = 0; target < targetLength; target++) {
    const from = target * ratio;
    const to = Math.min(sourceLength, (target + 1) * ratio);
    const first = Math.max(0, Math.floor(from));
    const last = Math.min(sourceLength - 1, Math.ceil(to) - 1);
    const weights = new Float32Array(Math.max(1, last - first + 1));
    let total = 0;
    for (let source = first; source <= last; source++) {
      const overlap = Math.min(to, source + 1) - Math.max(from, source);
      weights[source - first] = overlap > 0 ? overlap : 0;
      total += weights[source - first]!;
    }
    if (total > 0) for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! / total;
    contributions.push({ start: first, weights });
  }
  return contributions;
}

/**
 * 沿一个轴做加权平均。`quantize` 为真时输出 8bit（预乘过的颜色除回 alpha）。
 */
function resizeAxis(
  source: AxisSource,
  sourceWidth: number,
  sourceHeight: number,
  channels: number,
  targetLength: number,
  axis: 'x' | 'y',
  quantize = false,
): Uint8Array | Float32Array {
  const sourceLength = axis === 'x' ? sourceWidth : sourceHeight;
  const outerLength = axis === 'x' ? sourceHeight : sourceWidth;
  const contributions = axisContributions(sourceLength, targetLength);
  const targetWidth = axis === 'x' ? targetLength : sourceWidth;
  const targetHeight = axis === 'x' ? sourceHeight : targetLength;
  const out = quantize
    ? new Uint8Array(targetWidth * targetHeight * channels)
    : new Float32Array(targetWidth * targetHeight * channels);
  const needsPremultiply = channels === 4 && !source.premultiplied && source.data instanceof Uint8Array;
  const sums = new Float32Array(channels);

  for (let outer = 0; outer < outerLength; outer++) {
    for (let inner = 0; inner < targetLength; inner++) {
      const { start, weights } = contributions[inner]!;
      sums.fill(0);
      for (let i = 0; i < weights.length; i++) {
        const position = start + i;
        const pixel =
          axis === 'x' ? (outer * sourceWidth + position) * channels : (position * sourceWidth + outer) * channels;
        const weight = weights[i]!;
        for (let channel = 0; channel < channels; channel++) {
          const value = source.data[pixel + channel]!;
          sums[channel] =
            sums[channel]! +
            (needsPremultiply && channel < 3 ? value * (source.data[pixel + 3]! / 255) : value) * weight;
        }
      }
      const targetPixel =
        axis === 'x' ? (outer * targetLength + inner) * channels : (inner * sourceWidth + outer) * channels;
      writePixel(out, targetPixel, sums, channels, quantize);
    }
  }
  return out;
}

function writePixel(
  out: Uint8Array | Float32Array,
  offset: number,
  sums: Float32Array,
  channels: number,
  quantize: boolean,
): void {
  const alpha = channels === 4 ? sums[3]! : 255;
  for (let channel = 0; channel < channels; channel++) {
    let value = sums[channel]!;
    // 预乘过的颜色除回 alpha；alpha 为 0 时颜色取 0（全透明像素的颜色不可见）。
    if (quantize && channels === 4 && channel < 3) value = alpha > 0 ? (value * 255) / alpha : 0;
    out[offset + channel] = quantize ? clampByte(value) : value;
  }
}

function clampByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

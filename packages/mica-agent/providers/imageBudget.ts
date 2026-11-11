import type { Message } from '@earendil-works/pi-ai';

/**
 * 请求级的内联图片字节预算。
 *
 * 单张图压到 1568 长边之后仍然可能撞墙：一次请求会带上整段历史，十几张截图
 * 累加就是几十 MB。实测 DeepSeek 网关 8/16/24/32MB 能过、48MB 起回 413
 * （openresty 的 HTML 错误页），而 token 口径完全看不出这件事——155k/1M 的会话
 * 只有 20 万 token，字节却已经 53MB。所以这一层不按 token 算，按**发送字节**算。
 *
 * 策略是「留最近的、丢最旧的」：最新的那张图几乎总是当前正在讨论的东西，而更早
 * 被移除的图会留下一条明确的占位文本，模型知道它缺了什么，可以重新读取。
 */

/**
 * 一次请求的内联图片 + 文本总量上限。
 *
 * 取 20MB 而不是贴着实测的「32MB 能过」：这里算的是字符串字节，JSON 的键名与转义
 * 不算在内，留四成余量比事后排查 413 便宜。
 */
export const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
/** 单张图的上限：超过就换占位符（PNG 已在准备阶段压过，走到这里多半是别的格式）。 */
export const MAX_SINGLE_IMAGE_BYTES = 6 * 1024 * 1024;

export type ImageBudgetReport = {
  /** 裁剪前的请求正文字节数（文本 + 内联图片载荷）。 */
  bodyBytes: number;
  imageBytes: number;
  budgetBytes: number;
  keptImages: number;
  droppedImages: number;
  droppedBytes: number;
  /** 裁剪后的请求正文字节数；没丢图时与 `bodyBytes` 相同。 */
  resultBytes: number;
};

export type ImageBudgetOptions = {
  maxBodyBytes?: number;
  maxSingleImageBytes?: number;
};

export type ImageBudgetResult<T> = { value: T; report: ImageBudgetReport };

type ImageSlot = { index: number; bytes: number };

type Scan = { images: ImageSlot[]; textBytes: number };

const IMAGE_OMITTED_FOR_BUDGET =
  '[图片已省略] 这张较早的历史图片（{size}）已从本次请求中移除：会话里的内联图片总量超过接口请求体上限。需要它时请重新读取对应文件或重新截图，并如实告知用户这张图已被省略。';
const IMAGE_OMITTED_TOO_LARGE =
  '[图片已省略] 这张图片（{size}）超过单张上限 {limit}，本机压不下来（只有 PNG 会被重编码）。请先裁剪或缩小图片再读，并如实告知用户这张图已被省略。';

/**
 * 在发送副本中替换超限的图片块。返回的是新对象（原数组不被改动），没有超限时原样返回
 * 入参，避免为几十 MB 的历史白复制一遍。
 */
export function applyImageBudget(messages: Message[], options: ImageBudgetOptions = {}): ImageBudgetResult<Message[]> {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES;
  const maxSingleImageBytes = options.maxSingleImageBytes ?? MAX_SINGLE_IMAGE_BYTES;
  const scan = scanImages(messages);
  const imageBytes = scan.images.reduce((total, image) => total + image.bytes, 0);
  const budgetBytes = Math.max(0, maxBodyBytes - scan.textBytes);
  const report: ImageBudgetReport = {
    bodyBytes: scan.textBytes + imageBytes,
    imageBytes,
    budgetBytes,
    keptImages: scan.images.length,
    droppedImages: 0,
    droppedBytes: 0,
    resultBytes: scan.textBytes + imageBytes,
  };
  if (imageBytes <= budgetBytes && scan.images.every((image) => image.bytes <= maxSingleImageBytes)) {
    return { value: messages, report };
  }

  const omissions = new Map<number, string>();
  let remaining = budgetBytes;
  // 从最新往回留：最新的图最可能正在被讨论。
  for (let i = scan.images.length - 1; i >= 0; i--) {
    const image = scan.images[i]!;
    if (image.bytes > maxSingleImageBytes) {
      omissions.set(image.index, formatTooLarge(image.bytes, maxSingleImageBytes));
      continue;
    }
    if (image.bytes > remaining) {
      omissions.set(image.index, formatForBudget(image.bytes));
      continue;
    }
    remaining -= image.bytes;
  }

  for (const image of scan.images) {
    if (!omissions.has(image.index)) continue;
    report.droppedImages += 1;
    report.droppedBytes += image.bytes;
  }
  report.keptImages = scan.images.length - report.droppedImages;

  const value = rewriteImages(messages, omissions);
  // 占位文本本身也有体积（每条约 300 字节），报出来的结果得是真正要发的那份。
  const after = scanImages(value);
  report.resultBytes = after.textBytes + after.images.reduce((total, image) => total + image.bytes, 0);
  return { value, report };
}

/** 供调用方写一行日志；没有丢图时返回 null。 */
export function describeImageBudget(report: ImageBudgetReport): string | null {
  if (report.droppedImages === 0) return null;
  return (
    `[mica] 请求内联图片超出上限：移除 ${report.droppedImages} 张（${formatBytes(report.droppedBytes)}），` +
    `保留 ${report.keptImages} 张；正文 ${formatBytes(report.bodyBytes)} → ${formatBytes(report.resultBytes)}` +
    `（图片预算 ${formatBytes(report.budgetBytes)}）`
  );
}

function scanImages(messages: Message[]): Scan {
  const scan: Scan = { images: [], textBytes: 0 };
  for (const message of messages) {
    const { content, ...metadata } = message;
    scan.textBytes += stringBytes(metadata);
    if (typeof content === 'string') {
      scan.textBytes += stringBytes(content);
      continue;
    }
    for (const part of content) {
      if (message.role !== 'assistant' && part.type === 'image') {
        scan.images.push({ index: scan.images.length, bytes: Buffer.byteLength(part.data, 'utf8') });
      } else scan.textBytes += stringBytes(part);
    }
  }
  return scan;
}

function stringBytes(node: unknown): number {
  if (typeof node === 'string') return Buffer.byteLength(node, 'utf8');
  if (!node || typeof node !== 'object') return 0;
  return Object.values(node).reduce<number>((total, value) => total + stringBytes(value), 0);
}

function rewriteImages(messages: Message[], omissions: Map<number, string>): Message[] {
  let imageIndex = 0;
  return messages.map((message) => {
    if ((message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string')
      return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'image') return part;
      const omission = omissions.get(imageIndex++);
      if (!omission) return part;
      changed = true;
      return { type: 'text' as const, text: omission };
    });
    return changed ? { ...message, content } : message;
  });
}

function formatForBudget(bytes: number): string {
  return IMAGE_OMITTED_FOR_BUDGET.replace('{size}', formatBytes(bytes));
}

function formatTooLarge(bytes: number, limit: number): string {
  return IMAGE_OMITTED_TOO_LARGE.replace('{size}', formatBytes(bytes)).replace('{limit}', formatBytes(limit));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

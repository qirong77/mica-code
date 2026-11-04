import { Buffer } from 'node:buffer';

/** A local estimate for budgeting; provider-reported usage remains the billing source. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // Native byte counting avoids a JS scan or a second multi-megabyte string.
  // ASCII uses ~4 chars/token. A three-byte CJK character contributes ~1.5
  // tokens; other non-ASCII scripts receive the same conservative weighting.
  const nonAsciiBytes = Buffer.byteLength(text, 'utf8') - text.length;
  return Math.ceil(text.length / 4 + nonAsciiBytes * 0.625);
}

/**
 * 内联图片的 token：provider 按像素算（一张 1536×1024 约两千），不按 base64 字符数算。
 * 这里用「每 750 个 base64 字符 ≈ 1 token」折算（PNG 压缩后大致 1 token / 560 字节），
 * 并夹在 200–4000 之间，免得一张超大截图与一串短 URL 各走极端。
 */
function estimateInlineImageTokens(chars: number): number {
  return Math.min(4_000, Math.max(200, Math.round(chars / 750)));
}

const IMAGE_BLOCK_TYPES = new Set(['image', 'input_image', 'image_url']);

/** 最长的那段字符串就是图本身（`image_url` 可能是字符串，也可能是 `{ url }`）。 */
function longestString(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object') return 0;
  let longest = 0;
  for (const child of Object.values(value)) longest = Math.max(longest, longestString(child));
  return longest;
}

/**
 * 估算结构化 provider 消息，不序列化也不复制单条几十 MB 的载荷。
 *
 * 图片块按张计价：把它的 base64 当正文算会把一张截图估成二三十万 token，压缩阈值
 * 与界面上的上下文占用都会跟着虚高。反过来，工具输出里以 `data:` 开头的**文本**
 * 仍按文本算——provider 也是按文本计费的。
 */
export function estimateContextTokens(messages: readonly unknown[]): number {
  const visiting = new Set<object>();
  function estimate(value: unknown): number {
    if (typeof value === 'string') return estimateTextTokens(value);
    if (value === null || value === undefined) return 0;
    if (typeof value !== 'object') return 1;
    if (visiting.has(value)) return 0;
    visiting.add(value);
    if (!Array.isArray(value) && IMAGE_BLOCK_TYPES.has(String((value as { type?: unknown }).type))) {
      visiting.delete(value);
      return estimateInlineImageTokens(longestString(value));
    }
    let tokens = 0;
    if (Array.isArray(value)) {
      for (const item of value) tokens += estimate(item);
    } else {
      for (const [key, child] of Object.entries(value)) tokens += estimateTextTokens(key) + estimate(child) + 1;
    }
    visiting.delete(value);
    return tokens;
  }
  let total = 0;
  for (const message of messages) total += estimate(message) + 6;
  return total;
}

/**
 * 一份请求里消息之外的固定开销：系统提示词 + 工具定义。
 *
 * 压缩估出的 `beforeTokenEstimate` 只覆盖消息数组，而真实请求还把这两块一起发出去
 * （实测中位数两万 token 上下）。notice 与 ctx 徽标要能和 provider 的 inputTokens
 * 对上，就得把它们加回来——压缩不改系统提示词，所以压缩前后加的是同一个数。
 *
 * `measured` 是上一次真实请求与当时估算的差额（`lastUsage.inputTokens - 估算`）。
 * 它通常等于这块开销，但也可能掺进估算本身对正文的偏差：正文里 ASCII 代码与 JSON
 * 多时估算偏低，那份偏差会被当成开销，等这段正文被压掉之后就把数字抬得虚高。所以
 * 只在它不超过确定性估算 `estimated` 两倍时采信，否则退回 `estimated`。
 */
export function resolveRequestOverhead(input: { estimated: number; measured?: number }): number {
  const estimated = Math.max(0, Math.round(input.estimated || 0));
  const measured = Math.max(0, Math.round(input.measured || 0));
  if (measured <= 0) return estimated;
  if (estimated <= 0) return measured;
  return measured <= estimated * 2 ? measured : estimated;
}

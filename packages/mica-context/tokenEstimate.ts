import type { Message, TextContent, ImageContent } from '@earendil-works/pi-ai';
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text';

/**
 * 每类字符的实测折算（token/字符），用 10 万字符的真实语料向 provider 标定：英文文档
 * 0.263、中文文档 0.666、TypeScript 源码 0.254、内联 base64 0.692，再补一份「真实被
 * 会话压缩清掉的工具输出」0.344。旧实现按「ASCII 四字符一 token、CJK 每字 1.5 token」
 * 折算，中文高估 2.3 倍、长 base64/哈希串低估 2.8 倍。
 *
 * 标点单独计价是实测的结论：`{` `"` `:` `/` `=` 这类字符分词器基本一个字符一个 token，
 * 而工具输出里标点占到一成多。按「标点=正文」折算会把手里的文件、JSON、路径统统低估。
 */
const TOKENS_PER_WORD_CHAR = 0.255;
const TOKENS_PER_PUNCT_CHAR = 0.65;
const TOKENS_PER_NEWLINE = 0.6;
const TOKENS_PER_DENSE_CHAR = 0.7;
const TOKENS_PER_WIDE_CHAR = 0.65;
const TOKENS_PER_OTHER_CHAR = 0.6;

/** base64、十六进制、哈希这类不带分隔符的长串，分词器切得比正文碎得多。 */
const DENSE_RUN_MIN = 32;
const DENSE_RUN_CHAR = new Set('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/=_');

function isWide(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7ff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** A local estimate for budgeting; provider-reported usage remains the billing source. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let words = 0;
  let punct = 0;
  let newlines = 0;
  let dense = 0;
  let wide = 0;
  let other = 0;
  let run = 0;
  const flushRun = () => {
    if (run >= DENSE_RUN_MIN) dense += run;
    else words += run;
    run = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      if (DENSE_RUN_CHAR.has(text[i])) {
        run++;
        continue;
      }
      flushRun();
      if (code === 10 || code === 13) newlines++;
      else if (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 32 ||
        code === 9
      ) {
        words++;
      } else punct++;
      continue;
    }
    flushRun();
    if (isWide(code)) wide++;
    else other++;
  }
  flushRun();
  return Math.ceil(
    words * TOKENS_PER_WORD_CHAR +
      punct * TOKENS_PER_PUNCT_CHAR +
      newlines * TOKENS_PER_NEWLINE +
      dense * TOKENS_PER_DENSE_CHAR +
      wide * TOKENS_PER_WIDE_CHAR +
      other * TOKENS_PER_OTHER_CHAR,
  );
}

/**
 * 内联图片的 token：provider 按像素切块计费，与 base64 长度几乎无关。实测四张真实
 * 截图（18KB / 93KB / 406KB / 975KB）分别是 966 / 975 / 1751 / 1759 token——只随
 * 分辨率档位跳变。于是按「小图约 1000、超大图约 1760」插值，绝不按字符数折算：那会把
 * 一张 20KB 的截图估成 33 token（实为 966），大图又估成 1775（巧合同量级）。
 */
function estimateInlineImageTokens(chars: number): number {
  const scaled = 1_000 + Math.max(0, chars - 200_000) * 0.002;
  return Math.min(1_760, Math.round(scaled));
}

/** 实测每条消息约 2 token，含角色与分隔符。 */
const TOKENS_PER_MESSAGE = 2;

function estimateContent(content: string | readonly (TextContent | ImageContent)[]): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  let tokens = 0;
  for (const block of content) {
    tokens += block.type === 'image' ? estimateInlineImageTokens(block.data.length) : estimateTextTokens(block.text);
  }
  return tokens;
}

function estimateJson(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

/**
 * 只估算 pi 消息里会消费的正文、图片与工具参数，不序列化整份历史。
 *
 * 不使用 pi 的 usage 驱动估算：压缩前后的历史已经不同，旧 usage 不能描述新请求；
 * thinking、签名、provider/model、时间戳、工具 details/usage 等记录元信息也不参与预算。
 * 图片按张计价；工具输出里写成文本的 base64 仍按文本计价。
 */
export function estimateContextTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    let tokens = 0;
    if (message.role === 'system') {
      tokens = estimateTextTokens(getSystemMessageText(message));
      if (message.toolsAdded) tokens += estimateJson(message.toolsAdded);
      if (message.toolsRemoved) tokens += estimateJson(message.toolsRemoved);
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') tokens += estimateTextTokens(block.text);
        else if (block.type === 'toolCall') tokens += estimateTextTokens(block.name) + estimateJson(block.arguments);
      }
    } else {
      tokens = estimateContent(message.content);
    }
    total += tokens + TOKENS_PER_MESSAGE;
  }
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

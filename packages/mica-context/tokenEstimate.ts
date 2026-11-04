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

const IMAGE_BLOCK_TYPES = new Set(['image', 'input_image', 'image_url']);
/** 历史里的思考条目发送前一律被剥掉（`dropReplayedReasoningItems`），别把它们算进请求成本。 */
const REPLAY_DROPPED_TYPES = new Set(['reasoning']);
/**
 * 每条消息的固定开销。实测：把同一句 "ok" 的消息从 20 条加到 220 条，输入只涨 400
 * token——每条 2 token，含角色与分隔符。旧值 6 在几百条工具的会话里会凭空多出几千
 * token，还会把「实测开销」挤成负数，逼着通知退回确定性估算。
 */
const TOKENS_PER_MESSAGE = 2;

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
    const type = Array.isArray(value) ? '' : String((value as { type?: unknown }).type);
    if (REPLAY_DROPPED_TYPES.has(type)) {
      visiting.delete(value);
      return 0;
    }
    if (IMAGE_BLOCK_TYPES.has(type)) {
      visiting.delete(value);
      return estimateInlineImageTokens(longestString(value));
    }
    // 结构与键单独计价是实测不支持的：真实请求里一条消息的整套信封（角色、分隔符、
    // 键名）加起来才 ~2 token（见 TOKENS_PER_MESSAGE）。旧实现按「每个键 +1 再加键名
    // 文本」计价，在几百轮工具调用的会话里凭空多出上万 token。
    let tokens = 0;
    if (Array.isArray(value)) {
      for (const item of value) tokens += estimate(item);
    } else {
      for (const child of Object.values(value)) tokens += estimate(child);
    }
    visiting.delete(value);
    return tokens;
  }
  let total = 0;
  for (const message of messages) total += estimate(message) + TOKENS_PER_MESSAGE;
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

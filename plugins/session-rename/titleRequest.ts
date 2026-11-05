import type { PluginLlmApi, PluginModelUsage } from '@packages/mica-plugin/index.js';

/**
 * 起标题的那次模型请求。
 *
 * 模型配置与请求都交给 `ctx.llm`（清单里的 `llm` 声明）：插件只声明 system 与 user，
 * 「用哪个地址/协议/模型」和发出去、记账都由宿主负责。这笔开销因此会出现在会话的
 * Stats 里（插件自己 fetch 就没人记）。
 */
export type TitleRequestConfig = {
  prompt: string;
};

export type TitleRequestResult = {
  title: string;
  usage?: PluginModelUsage | null;
};

/**
 * 起标题的模型常是 reasoning 模型：实测同一份 prompt 耗时 5~14s，且 reasoning token
 * 占输出的绝大部分。20s 的上限会让「模型慢一点」直接表现成「插件坏了」。
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TITLE_WIDTH = 40;
/** 模型返回的「标题：xxx」「Title: xxx」这类前缀，剥掉。 */
const TITLE_PREFIX_PATTERN = /^\s*(?:标题|会话标题|title|session title)\s*[:：]\s*/i;
const WIDE_CHAR_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\uFF01-\uFF60\uFFE0-\uFFE6]/u;
const PROCESS_STATEMENT_PATTERNS = [
  /^(?:我(?:会|将|先|来|要|已|已经|正在|接下来)|我们(?:会|将|先|已|已经|正在)|(?:接下来|下一步|下面)(?:我|我们|会|将|先)|让我(?:先|来))/u,
  /^(?:先|首先)(?:核对|检查|确认|看|阅读|定位|分析|梳理)[^，,；;]*[，,；;](?:再|然后|随后|接着)/u,
  /^(?:(?:I|We)(?:['’](?:ll|ve|m|re)|\s+(?:will|have|am|are|already|checked|fixed|updated))\b|Let['’]s\b|(?:Next|First|Now|Then)[,:]?\s+(?:I|We)\b)/iu,
];

export type TitleRejectionReason = 'empty' | 'too-long' | 'process-statement';

export async function requestSessionTitle(
  llm: PluginLlmApi,
  config: TitleRequestConfig,
  transcript: string,
  options: { timeoutMs?: number; signal?: AbortSignal; owner?: unknown } = {},
): Promise<TitleRequestResult> {
  const result = await llm.request({
    purpose: '自动起标题',
    system: config.prompt,
    user: transcript,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
  });
  return { title: sanitizeTitle(result.text), usage: result.usage };
}

export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const withoutFences = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const firstLine =
    withoutFences
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const stripped = firstLine
    .replace(TITLE_PREFIX_PATTERN, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^[-*#>\s]+/, '')
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, '')
    .replace(/[。．.]+$/, '')
    .trim();
  if (!stripped) return '';
  return stripped;
}

export function titleRejectionReason(title: string): TitleRejectionReason | null {
  if (!title) return 'empty';
  let width = 0;
  for (const char of title) width += WIDE_CHAR_PATTERN.test(char) ? 2 : 1;
  if (width > MAX_TITLE_WIDTH) return 'too-long';
  if (PROCESS_STATEMENT_PATTERNS.some((pattern) => pattern.test(title))) return 'process-statement';
  return null;
}

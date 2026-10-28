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
const MAX_TITLE_CHARS = 60;
/** 模型返回的「标题：xxx」「Title: xxx」这类前缀，剥掉。 */
const TITLE_PREFIX_PATTERN = /^\s*(?:标题|会话标题|title|session title)\s*[:：]\s*/i;

export async function requestSessionTitle(
  llm: PluginLlmApi,
  config: TitleRequestConfig,
  transcript: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TitleRequestResult> {
  const result = await llm.request({
    purpose: '自动起标题',
    system: config.prompt,
    user: transcript,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
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
  return stripped.length > MAX_TITLE_CHARS ? stripped.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…' : stripped;
}

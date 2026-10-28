import type { ProviderProtocol } from '@packages/mica-config/index.js';
import type { PluginModelsApi, PluginModelUsage } from '@packages/mica-plugin/index.js';

/**
 * 起标题的那次模型请求。
 *
 * 请求本身交给宿主的 `ctx.models`：插件只声明「用哪个地址/协议/模型、system 与 user
 * 是什么」，发出去与记账都由宿主负责。这样这笔开销会出现在会话的 Stats 里（插件自己
 * fetch 就没人记），协议分支与超时也只有一份实现。
 */
export type TitleRequestConfig = {
  baseUrl: string;
  apiKey: string;
  protocol: ProviderProtocol;
  model: string;
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

export function isTitleRequestConfigured(config: TitleRequestConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.model.trim());
}

export async function requestSessionTitle(
  models: PluginModelsApi,
  config: TitleRequestConfig,
  transcript: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TitleRequestResult> {
  const result = await models.request({
    purpose: '自动起标题',
    system: config.prompt,
    user: transcript,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    protocol: config.protocol,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  });
  return { title: sanitizeTitle(result.text), usage: result.usage };
}

/**
 * 把模型返回的东西压成一个能当标题的字符串。
 *
 * 模型常常带解释、加引号、套代码块，或者直接给出两行；标题只要第一行正文。
 */
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

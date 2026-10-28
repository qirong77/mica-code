import { runModelTextRequest, type ModelTextRequest } from './modelText.js';

/**
 * 「这个配置能通吗」的一次最小请求。
 *
 * 走的就是插件真正会用的那条路（`runModelTextRequest`），只是不记账、只问一句
 * 「回复 OK」：用户在配置页点一下就能知道地址 / Key / 协议 / 模型哪一项不对，
 * 而不是等到某个后台任务静默失败。
 */

export type ModelProbeConfig = {
  baseUrl: string;
  apiKey?: string;
  protocol?: 'openai_chat_completions' | 'openai_responses';
  model: string;
  timeoutMs?: number;
};

export type ModelProbeResult = {
  ok: boolean;
  /** 失败原因（已去掉可能的 Key 片段）；成功时为空串。 */
  message: string;
  latencyMs: number;
  /** 实际请求的模型，便于确认「用的是哪一个」。 */
  model: string;
  /** 模型返回的原文（截断），确认不是连到了别的服务。 */
  reply?: string;
};

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

export async function probeModelConnection(
  config: ModelProbeConfig,
  options: Pick<ModelTextRequest, 'createClient'> = {},
): Promise<ModelProbeResult> {
  const model = config.model.trim();
  const startedAt = Date.now();
  if (!config.baseUrl.trim() || !model) {
    return { ok: false, message: '接口地址与模型都必须填写', latencyMs: 0, model };
  }
  try {
    const result = await runModelTextRequest({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      protocol: config.protocol,
      model,
      system: 'You are a connection check. Answer with a single word.',
      user: 'Reply with exactly: OK',
      timeoutMs: config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      createClient: options.createClient,
    });
    const reply = result.text.trim();
    return {
      ok: true,
      message: '',
      latencyMs: Date.now() - startedAt,
      model,
      reply: reply.slice(0, 40),
    };
  } catch (error) {
    return {
      ok: false,
      message: describeProbeError(error, config.apiKey),
      latencyMs: Date.now() - startedAt,
      model,
    };
  }
}

/**
 * 错误信息会原样显示在配置页上，所以先清掉 Key：provider 的报错里偶尔会带上请求头。
 * 再把常见的三种失败换成「该改哪里」，其它原样给出，不吞细节。
 */
function describeProbeError(error: unknown, apiKey: string | undefined): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = apiKey && apiKey.length >= 8 ? raw.split(apiKey).join('***') : raw;
  if (/401|unauthorized|invalid api key|authentication/i.test(cleaned)) {
    return `认证失败，检查 API Key（${cleaned}）`;
  }
  // SDK 在缺 Key 时给的是这句英文；用户看到「Missing credentials」并不知道要填哪里。
  if (/missing credentials|api key is required|no api key/i.test(cleaned)) {
    return '还没有填 API Key：本地网关通常可以不填，其它服务需要填上';
  }
  if (/404|not found/i.test(cleaned)) {
    return `接口地址可能不对，需要写到 /v1 这类前缀（${cleaned}）`;
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(cleaned)) {
    return `连不上这个地址，检查网络或接口地址（${cleaned}）`;
  }
  return cleaned;
}

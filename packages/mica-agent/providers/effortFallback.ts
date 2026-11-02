import { markEffortLevelRejected, type EffortOption, type ProviderDefinition } from '@packages/mica-config/index.js';

/** 服务端抱怨某个取值不被接受时的措辞（OpenAI / 兼容网关大同小异）。 */
const REJECTION_PATTERN = /unsupported|not supported|invalid|unknown variant|不支持/i;

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** 请求里会原样出现在报错里的字符串取值（`none` / `disabled` / `high` …）。 */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, out);
  return out;
}

/**
 * 这次失败是不是「服务端不接受我们带上的推理档位」。
 *
 * models.dev 的档位是社区数据，并不总等于某台网关的真实枚举（同一个 `gpt-6.1-terra`
 * 在一处声明 `none`、在另一处只认 low…max）。这类错误是 400，报错里会引用我们发出去的
 * 那个取值，和「请求本身有问题」区分得开——前者可以丢掉推理参数重发，后者重发也没用。
 */
export function isUnsupportedReasoningError(error: unknown, params: Record<string, unknown>): boolean {
  const values = stringValues(params);
  if (values.length === 0) return false;
  const status = statusOf(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  const message = messageOf(error);
  if (!REJECTION_PATTERN.test(message)) return false;
  if (/reasoning|effort|thinking/i.test(message)) return true;
  return values.some((value) => message.includes(`'${value}'`) || message.includes(`"${value}"`));
}

export type EffortFallbackRequest<T> = {
  provider: ProviderDefinition;
  model: string;
  effort: EffortOption | undefined;
  /** 这次真的会发出去的推理参数；为空表示本来就没带，不必降级。 */
  params: Record<string, unknown>;
  send: (params: Record<string, unknown>) => Promise<T>;
};

/**
 * 带推理参数发一次；服务端明确拒绝时丢掉推理参数重发一次，并记住该档位不再发送。
 *
 * 发不出去就退化成「不发推理参数」而不是让整个请求失败：压缩摘要、起标题、子代理这些
 * 路径的 effort 不是用户选的，为一个元数据错误把整轮任务打掉没有道理。`withRetry` 仍然
 * 包在外面，所以这次重发同样受「还没有输出才安全重发」的约束。
 */
export async function sendWithEffortFallback<T>(request: EffortFallbackRequest<T>): Promise<T> {
  try {
    return await request.send(request.params);
  } catch (error) {
    if (!isUnsupportedReasoningError(error, request.params)) throw error;
    const level = request.effort ?? 'none';
    markEffortLevelRejected(request.provider, request.model, level);
    console.error(
      `[mica] ${request.provider.id}/${request.model} 不接受 effort '${level}'，改为不发送推理参数：${messageOf(error)}`,
    );
    return request.send({});
  }
}

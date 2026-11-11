/**
 * 中转网关（codex 反代、omniroute 这类）拒绝请求时常用 `{"detail": ...}` /
 * `{"message": ...}` 回话，而 OpenAI SDK 只认 `body.error.message`：body 解析成功
 * 却取不到 `error` 时，它把整段原因丢掉，最终只向用户抛 `400 status code (no body)`。
 * 这里在 fetch 层把这种 body 改写成 SDK 认得的结构，让真实原因显示出来。
 */

const MAX_ERROR_MESSAGE_CHARS = 800;

/** 从 `{"detail": ...}` / `{"message": ...}` 里取一句话原因；SDK 自己读得懂时返回 undefined。 */
export function errorMessageFromBody(text: string): string | undefined {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 纯文本 body SDK 会原样带进 message，不必改写。
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const body = parsed as Record<string, unknown>;
  if (body.error) return undefined;
  const detail = body.detail ?? body.message ?? body.msg;
  if (detail === undefined) return undefined;
  const message = (typeof detail === 'string' ? detail : JSON.stringify(detail)).trim();
  if (!message) return undefined;
  return message.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function rebuild(text: string, response: Response): Response {
  const headers = new Headers(response.headers);
  // body 已被读过：长度与压缩编码都不再等于原始报文。
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/** 包一层 fetch：非 2xx 响应若把原因放在 `detail` / `message` 里，改写成 SDK 认得的 `error.message`。 */
export function fetchWithReadableErrors(fetchImpl: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    const message = errorMessageFromBody(text);
    if (!message) return rebuild(text, response);
    // Preserve structured retry hints when moving a gateway's reason into the SDK's error shape.
    const body = JSON.parse(text) as Record<string, unknown>;
    return rebuild(
      JSON.stringify({
        error: {
          message,
          ...(typeof body.code === 'string' ? { code: body.code } : {}),
          ...(typeof body.type === 'string' ? { type: body.type } : {}),
        },
      }),
      response,
    );
  };
}

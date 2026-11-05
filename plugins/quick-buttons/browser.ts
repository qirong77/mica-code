/**
 * 把地址交给**受控浏览器**（桌面端主进程里那个可以继续被 agent 操作的窗口）。
 *
 * 地址来自运行时注入的 `MICA_BROWSER_URL`，端点目录在
 * `apps/desktop/src/main/browser/browser-docs.js`。这不是宿主给插件的私有约定：同一份
 * HTTP 接口就是 agent 通过 MCP 用这个浏览器的那一份，插件只是从一个按钮触发它。
 *
 * 归属（`x-mica-owner`）必须带上：没有归属的窗口在顶栏没有任何入口，主进程会把它回收掉，
 * 用户点了按钮却什么都没看见。桌面端给每个会话进程注入了 `MICA_BROWSER_OWNER`。
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type OpenInBrowserResult = { ok: true } | { ok: false; error: string };

export const BROWSER_OPEN_TIMEOUT_MS = 5000;

export async function openInControlledBrowser(input: {
  url: string;
  label?: string;
  owner?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<OpenInBrowserResult> {
  const base = String(input.baseUrl ?? process.env.MICA_BROWSER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) {
    return { ok: false, error: '这个宿主没有受控浏览器（只有桌面端提供）' };
  }
  const owner = String(input.owner ?? process.env.MICA_BROWSER_OWNER ?? '').trim();
  if (!owner) {
    // 宁可报错也不建一个无主窗口：它在页面上没有任何入口，关也关不掉。
    return { ok: false, error: '拿不到会话归属，打开的窗口没有入口可以再关' };
  }
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return { ok: false, error: '这个运行时没有 fetch' };

  try {
    const response = await fetchImpl(`${base}/browser/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mica-owner': owner },
      body: JSON.stringify({
        url: input.url,
        label: labelOf(input.label),
        // 用户点的是「打开」，窗口就该出现在眼前；agent 自己在后台用的时候才不显示。
        show: true,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload: { ok?: boolean; error?: string } | null = null;
    try {
      payload = text ? (JSON.parse(text) as { ok?: boolean; error?: string }) : null;
    } catch {
      return { ok: false, error: `受控浏览器返回了非 JSON：${text.slice(0, 120)}` };
    }
    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: payload?.error || `受控浏览器返回 HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 窗口标题：顶栏图标要靠它区分同一个会话里的几个窗口。 */
function labelOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 24) : '快捷按钮';
}

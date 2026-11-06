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
    const signal = AbortSignal.timeout(input.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS);
    const request = async (path: string, body?: unknown, allowConflict = false) => {
      const response = await fetchImpl(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-mica-owner': owner },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      let payload: { ok?: boolean; error?: string; browsers?: Array<{ id: string }> } | null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`受控浏览器返回了非 JSON：${text.slice(0, 120)}`);
      }
      if ((!response.ok || payload?.ok === false) && !(allowConflict && response.status === 409)) {
        throw new Error(payload?.error || `受控浏览器返回 HTTP ${response.status}`);
      }
      return { response, payload };
    };
    const existingBrowser = async () => {
      const { payload } = await request('/browser/browsers');
      return payload?.browsers?.find((browser) => typeof browser.id === 'string' && browser.id)?.id;
    };
    let browserId = await existingBrowser();
    if (!browserId) {
      const created = await request(
        '/browser/browsers',
        { url: input.url, label: labelOf(input.label), show: true },
        true,
      );
      if (created.response.status !== 409) return { ok: true };
      browserId = await existingBrowser();
      if (!browserId) throw new Error(created.payload?.error || '受控浏览器窗口冲突，重新查询后仍未找到窗口');
    }
    await request('/browser/tabs', { browserId, url: input.url });
    await request(`/browser/browsers/${encodeURIComponent(browserId)}/show`, {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 首次创建窗口时的顶栏标签。 */
function labelOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 24) : '快捷按钮';
}

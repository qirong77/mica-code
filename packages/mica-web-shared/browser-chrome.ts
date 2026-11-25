/**
 * 受控浏览器顶栏 / 最近访问浮层与主进程之间的消息约定。
 *
 * 这两块界面是真正的渲染入口（`apps/desktop/src/renderer/browser-chrome.html`），
 * 但**没有 preload**：页面把动作写成一行 `console.log(前缀 + JSON)`，主进程在
 * `console-message` 里认前缀；主进程推状态用 `executeJavaScript('window.__micaChrome.update(…)')`。
 * 前缀与解析放在共享包里，两侧 import 同一份实现，不会各写一个字符串再对不上。
 *
 * 消息只承载「哪个动作 + 它的参数」，鉴权不在这一层：顶栏窗口只由主进程加载，
 * 页面能做的动作也只有这里列出的几种（导航、切标签页、剪贴板、最近访问浮层）。
 */

export const CHROME_MESSAGE_PREFIX = '__mica_chrome__';

export interface ChromeMessage {
  action: string;
  [key: string]: unknown;
}

/** 页面 → 主进程：把一条动作编码成日志行。 */
export function encodeChromeMessage(message: ChromeMessage): string {
  return `${CHROME_MESSAGE_PREFIX}${JSON.stringify(message)}`;
}

/** 主进程 → 页面状态：拼出 `executeJavaScript` 要执行的调用。 */
export function chromeUpdateScript(target: 'bar' | 'recent', state: unknown): string {
  const name = target === 'recent' ? '__micaRecent' : '__micaChrome';
  return `window.${name}.update(${JSON.stringify(state ?? null)})`;
}

/** 解析页面回传的控制消息；不是我们的消息就返回 null（由调用方决定要不要吞掉日志）。 */
export function parseChromeMessage(message: unknown): ChromeMessage | null {
  const raw = String(message ?? '');
  if (!raw.startsWith(CHROME_MESSAGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(CHROME_MESSAGE_PREFIX.length));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') return null;
    return parsed as ChromeMessage;
  } catch {
    return null;
  }
}

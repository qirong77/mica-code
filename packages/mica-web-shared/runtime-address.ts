import { DEFAULT_RUNTIME_PORT } from './runtime-port.js';

/**
 * 「一台 Mica 运行时」的地址处理。
 *
 * 页面由哪台运行时托管就代表在用哪台，所以一台运行时在界面上就是一个 origin：切换运行
 * 时 = 打开那个地址。规范化与判断有三处消费者——运行时侧探活、桌面端打开新窗口、插件
 * 维护的连接清单——规则只在这里写一份，免得「输入 `192.168.1.5` 该补哪个端口」在两处
 * 各答一次。
 */

/**
 * 规范成某个运行时的 origin（`[http://]host[:port]` 一律补端口、丢掉路径）。
 *
 * 非法输入返回 null，包含两件事：不是 http(s)、没有主机名、地址里带空白（用户粘贴了
 * 一整句说明而不是地址）。这几种都不该在探活阶段变成一次莫名其妙的网络错误。
 */
export function normalizeRuntimeAddress(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${bareIpv6(raw) ? `[${raw}]` : raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  // `url.port` 会把协议默认端口（http 的 80）吞成空串，所以显式端口从原文里认。
  const authority = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  const explicit = authority.match(/:(\d+)$/);
  const port = explicit ? explicit[1] : String(DEFAULT_RUNTIME_PORT);
  // IPv6 的 hostname 规范上带方括号，兜底再加一层以免拼出 [[::1]]
  const host = url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname;
  return `${url.protocol}//${host}:${port}`;
}

/**
 * 裸写的 IPv6 地址（`::1`、`fe80::1`）要先套上方括号才成 host。
 *
 * 只认「整串就是一个地址」这一种：`::1:8787` 也是全 IPv6 字符集，但没有方括号时本来
 * 就无法表达「IPv6 + 端口」，按地址理解比按「主机 ::1 + 端口 8787」更接近本意。
 */
function bareIpv6(text: string): boolean {
  return /^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2;
}

function parseAddress(value: unknown): URL | null {
  try {
    return new URL(String(value ?? ''));
  } catch {
    return null;
  }
}

/** 这个地址是不是本机（回环）：界面上它叫「本机」，回程入口也只在不是本机时才有意义。 */
export function isLoopbackRuntime(value: unknown): boolean {
  const url = parseAddress(value);
  if (!url) return false;
  return (
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
  );
}

/** 两个地址是不是同一台运行时（按 host:port 比，协议与路径不参与）。 */
export function isSameRuntime(a: unknown, b: unknown): boolean {
  const left = parseAddress(a);
  const right = parseAddress(b);
  if (!left || !right) return false;
  return left.host === right.host;
}

/**
 * 界面上代表这台运行时的名字：回环一律叫「本机」，其余用 host:port。
 *
 * 拿不到 host 时退回原串而不是空：一条认不出来的记录也比一行空白好排查。
 */
export function runtimeLabel(value: unknown): string {
  const url = parseAddress(value);
  if (!url) return String(value ?? '');
  if (isLoopbackRuntime(value)) return '本机';
  return url.host || url.hostname;
}

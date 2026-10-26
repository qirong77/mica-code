/**
 * 运行时端口：整个应用只有这一个 TCP 端口，默认 `8787`。
 *
 * 桌面运行时（`out/server/index.mjs`）监听它，页面、分享视图、终端控制窗口、受控浏览器与
 * 终端的代理、两个 MCP 端点全部在这一个端口上按路径区分（约定在 `app-paths.ts`）。浏览器与
 * 终端服务本身跑在 Unix socket 上，不占 TCP 端口。所以「换端口」只改这里一处。
 *
 * 端口可以被 `MICA_DESKTOP_PORT`（或运行时的 `--port`）覆盖，被别的进程占着时还会回退到
 * 随机端口——因此任何**拼给用户的地址**都要拿运行时上报的实际端口（`ready` 行、`access:info`）
 * 现拼，不能假设默认值仍然成立。这个模块只提供常量、默认值和「本机地址」这一层的拼法。
 *
 * 这里同时收着另一个独立宿主的默认端口：Config Web（`apps/config-web`，`mica` 在浏览器里
 * 打开配置页时用的那个 Bun 服务）。它和桌面运行时是两套进程，端口各自独立，但同样是
 * 「一个默认值 + 一个环境变量覆盖」的形态，所以放在一起，别再往各自主入口里抄字面量。
 *
 * 刻意写成纯 JS（带 JSDoc 类型）而不是 `.ts`：vite 配置、`scripts/*.mjs` 这些用 node
 * 直接跑的入口也要读同一份常量，它们装不了 TS 转译。
 */

/** 默认端口：没有任何配置时运行时监听它，也是「本机」这个地址的端口。 */
export const DEFAULT_RUNTIME_PORT = 8787;

/** 覆盖默认端口的变量：运行时、Electron 外壳、Vite dev server 的代理都读同一个。 */
export const RUNTIME_PORT_ENV = 'MICA_DESKTOP_PORT';

/** Config Web 的默认端口（`apps/config-web`，独立于桌面运行时）。 */
export const DEFAULT_CONFIG_WEB_PORT = 13987;

/** 覆盖 Config Web 端口的变量。 */
export const CONFIG_WEB_PORT_ENV = 'MICA_CONFIG_WEB_PORT';

/** 回环地址：外壳、页面和 agent 都从这台机器上的这个地址进运行时。 */
export const RUNTIME_LOOPBACK_HOST = '127.0.0.1';

/**
 * 把端口值（env 字符串、命令行参数、数字）解析成端口号。
 *
 * 非法值（空、不是整数、超出 1-65535）一律落回 `fallback`，调用方不用各自写一遍
 * 「`parseInt` 之后判 `NaN`」——以前这几处就是这么分叉的。
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function parseRuntimePort(value, fallback = DEFAULT_RUNTIME_PORT) {
  // 数字直接判；字符串要求整串都是数字——`parseInt('12.5')`/`'9000abc'` 会悄悄截出 12 和 9000，
  // 那种「填错了却还能启动」比直接落回默认值更难查。
  const text = typeof value === 'number' ? null : String(value ?? '').trim();
  const parsed = text === null ? value : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

/**
 * 某个端口上的回环地址：这台机器上的那台运行时，也就是界面里的「本机」。
 *
 * @param {number | string} [port]
 * @returns {string}
 */
export function loopbackRuntimeUrl(port = DEFAULT_RUNTIME_PORT) {
  return `http://${RUNTIME_LOOPBACK_HOST}:${parseRuntimePort(port)}`;
}

/** 默认端口的回环地址，给「没有配置时就该是这个」的调用方用。 */
export const DEFAULT_RUNTIME_URL = loopbackRuntimeUrl();

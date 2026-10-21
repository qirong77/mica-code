import {
  browserControlTargetPath,
  createBrowserControlProxy,
  isBrowserControlPath
} from './browser-control-proxy.js'
import { TERMINAL_CONTROL_PREFIX } from './terminal-control-core.js'

/**
 * 把运行时的 `/remote/terminal/*` 转发给主进程的终端服务（Unix socket）。
 *
 * 与受控浏览器共用同一套流式转发：终端页面的 SSE 输出、AI 的读写请求都走这里，
 * 所以整个能力挂在**运行时已有的端口**上，agent 拿到的就是普通地址
 * （`MICA_TERMINAL_URL` = 运行时地址 + 这个前缀）。
 */

export function isTerminalControlPath(pathname) {
  return isBrowserControlPath(pathname, TERMINAL_CONTROL_PREFIX)
}

/**
 * 端点路径相对服务根（`/sessions`、`/events`…），所以整段前缀都要剥掉，
 * `$MICA_TERMINAL_URL/sessions` 才能落到主进程的 `/sessions`。
 */
const STRIP_PREFIX = TERMINAL_CONTROL_PREFIX

export function terminalControlTargetPath(pathname, search = '') {
  return browserControlTargetPath(pathname, search, TERMINAL_CONTROL_PREFIX, STRIP_PREFIX)
}

export function createTerminalControlProxy({ socketPath } = {}) {
  return createBrowserControlProxy({
    socketPath,
    prefix: TERMINAL_CONTROL_PREFIX,
    stripPrefix: STRIP_PREFIX,
    label: '终端控制服务'
  })
}

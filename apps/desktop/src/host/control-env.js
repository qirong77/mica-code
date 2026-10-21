/**
 * 会话进程的环境：agent 只该拿到「怎么访问运行时」，不该拿到「怎么绕过运行时」。
 *
 * 主进程的受控浏览器与终端服务都只监听 Unix socket，运行时再把它代理成自己端口上的
 * `/remote/*`（Host/Origin 校验就在这一层）。socket 路径留在子进程 env 里，agent 就能用
 * `curl --unix-socket` 跳过那道校验，等于多开一条没人守的门。
 */

const INTERNAL_ENV_KEYS = ['MICA_TERMINAL_SOCKET', 'MICA_BROWSER_SOCKET']

/** 去掉运行时内部通道，其余环境原样保留。 */
export function stripControlSockets(env = {}) {
  const next = { ...env }
  for (const key of INTERNAL_ENV_KEYS) delete next[key]
  return next
}

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTerminalSessions } from './terminal-sessions.js'
import { createTerminalService } from './terminal-service.js'
import { createTerminalWindows } from './terminal-window.js'

/**
 * 终端控制的宿主：真实 PTY 会话 + 后台窗口 + Unix socket 上的 HTTP 服务。
 *
 * 由 Electron 外壳启动（只有主进程开得了窗口，node-pty 也在这里加载）。服务**不占 TCP
 * 端口**：socket 路径经 `MICA_TERMINAL_SOCKET` 交给运行时，运行时在自己已有的端口上把
 * `/remote/terminal/*` 代理过来，再把那个地址以 `MICA_TERMINAL_URL` 注入给每个会话
 * 进程——agent 于是只需要一个普通 HTTP 地址。
 */

/** Unix socket 路径上限（macOS 104 字节、Linux 108 字节）；留点余量给平台差异。 */
const MAX_SOCKET_PATH = 100

/** 路径太长（用户名很长）就退到临时目录里一个按 userData 派生的名字 */
export function resolveTerminalSocketPath(userDataDir) {
  const preferred = join(userDataDir, 'terminal-control.sock')
  if (preferred.length <= MAX_SOCKET_PATH) return preferred
  const tag = createHash('sha1').update(String(userDataDir)).digest('hex').slice(0, 12)
  return join(tmpdir(), `mica-terminal-${tag}.sock`)
}

export async function startTerminalHost({
  socketPath,
  getPageUrl = () => '',
  isQuitting = () => false
} = {}) {
  if (!socketPath) throw new Error('startTerminalHost 需要 socketPath')

  let service = null
  // 会话先建：它的 onChange 要引用稍后才创建的服务（闭包延迟解析，避免循环构造）
  const sessions = createTerminalSessions({
    onChange: (event) => service?.onSessionEvent(event)
  })
  const windows = createTerminalWindows({
    getPageUrl,
    isQuitting,
    onVisibleChange: (id, visible) => sessions.setWindowVisible(id, visible)
  })
  service = createTerminalService({ sessions, windows })

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => {})
  await service.listenSocket(socketPath)

  return {
    socketPath,
    sessions,
    windows,
    async close() {
      // 先同步收掉 shell 与窗口，再关服务：service.close() 可能被在途请求拖住，
      // 而退出流程不会等这个 promise，排在后面前面的清理会被跳过
      sessions.shutdown()
      windows.destroyAll()
      await service.close().catch(() => {})
    }
  }
}

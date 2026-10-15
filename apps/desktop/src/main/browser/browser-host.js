import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createBrowserManager } from './browser-manager.js'
import { createBrowserService } from './browser-service.js'

/**
 * 受控浏览器的宿主：把「窗口管理器」和「HTTP 服务」接起来，交给 Electron 外壳启动
 * （见 src/main/index.js）。
 *
 * 服务**不占 TCP 端口**：它只监听一个 Unix socket（路径由外壳算好并传进来），运行时在
 * 自己已有的端口上把 `/remote/control/*` 代理过去。这样「受控浏览器」不新增任何监听端口
 * ——agent 用的还是一个普通的 HTTP 地址（运行时的地址 + `/remote/control`），
 * 而这个地址由运行时通过 `MICA_BROWSER_URL` 注入给每个会话进程。
 */

/** Unix socket 路径上限（macOS 104 字节、Linux 108 字节）；留点余量给平台差异。 */
const MAX_SOCKET_PATH = 100

/**
 * 选一个能用的 socket 路径。优先放在应用自己的 userData 目录（同机多用户不互相影响），
 * 路径太长就退到临时目录里一个按目录名派生的名字——Unix socket 路径有长度上限，
 * `~/Library/Application Support/<app>/...` 在用户名很长时会超。
 */
export function resolveBrowserSocketPath(userDataDir) {
  const preferred = join(userDataDir, 'browser-control.sock')
  if (preferred.length <= MAX_SOCKET_PATH) return preferred
  const tag = createHash('sha1').update(String(userDataDir)).digest('hex').slice(0, 12)
  return join(tmpdir(), `mica-browser-${tag}.sock`)
}

export async function startBrowserHost({
  socketPath,
  cacheDir = '',
  isQuitting = () => false
} = {}) {
  if (!socketPath) throw new Error('startBrowserHost 需要 socketPath')
  let manager = null

  const service = createBrowserService({ getManager: () => manager, cacheDir })

  manager = createBrowserManager({
    onChange: () => service.broadcast(),
    isQuitting
  })

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => {})
  await service.listenSocket(socketPath)

  return {
    socketPath,
    manager,
    broadcast: service.broadcast,
    async close() {
      manager.closeAll()
      await service.close()
    }
  }
}

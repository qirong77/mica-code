import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { shell, systemPreferences } from 'electron'
import { buildSystemChecks, parseClangVersion, parseXcodeSelectPath } from './system-core.js'
import { createSystemService } from './system-service.js'

/**
 * 系统检查的宿主：把「探测」和「Unix socket 上的 HTTP 服务」接起来，交给 Electron 外壳
 * 启动（见 src/main/index.js）。
 *
 * 为什么必须在主进程：辅助功能与屏幕录制属于**有 app 身份的那个进程**（TCC 按 bundle
 * 授予），运行时进程是 `ELECTRON_RUN_AS_NODE` 的纯 Node，`systemPreferences` 在那边是空壳；
 * `openExternal('x-apple.systempreferences:...')` 也被页面的 http(s) 过滤挡着。于是探测与
 * 打开面板都留在这里，运行时经 `MICA_SYSTEM_SOCKET` 问它。
 */

/** Unix socket 路径上限（macOS 104 字节、Linux 108 字节）；留点余量给平台差异。 */
const MAX_SOCKET_PATH = 100

/** 路径太长（用户名很长）就退到临时目录里一个按 userData 派生的名字 */
export function resolveSystemSocketPath(userDataDir) {
  const preferred = join(userDataDir, 'system-checks.sock')
  if (preferred.length <= MAX_SOCKET_PATH) return preferred
  const tag = createHash('sha1').update(String(userDataDir)).digest('hex').slice(0, 12)
  return join(tmpdir(), `mica-system-${tag}.sock`)
}

/** 跑一条探测命令：起的来且退出码为 0 才算有输出。 */
function runCommand(command, args, { run = spawnSync } = {}) {
  try {
    const result = run(command, args, { encoding: 'utf8', timeout: 5000 })
    return result?.status === 0 ? String(result.stdout || '') : ''
  } catch {
    return ''
  }
}

/** 读一次系统状态。`preferences`/`run` 可注入，方便单测替身。 */
export function probeSystemChecks({
  platform = process.platform,
  preferences = systemPreferences,
  run = runCommand
} = {}) {
  if (platform !== 'darwin') return buildSystemChecks({ platform })

  return buildSystemChecks({
    platform,
    // false = 不弹授权窗，只问当前状态
    accessibility: preferences.isTrustedAccessibilityClient(false) === true ? 'granted' : 'denied',
    screenRecording: preferences.getMediaAccessStatus('screen'),
    commandLineTools: {
      xcodePath: parseXcodeSelectPath(run('xcode-select', ['-p'])),
      clangVersion: parseClangVersion(run('clang', ['--version']))
    }
  })
}

export async function startSystemHost({ socketPath } = {}) {
  if (!socketPath) throw new Error('startSystemHost 需要 socketPath')

  const service = createSystemService({
    probe: () => probeSystemChecks(),
    openSettings: (pane) => shell.openExternal(pane)
  })

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => {})
  await service.listenSocket(socketPath)

  return {
    socketPath,
    probe: () => probeSystemChecks(),
    async close() {
      await service.close().catch(() => {})
    }
  }
}

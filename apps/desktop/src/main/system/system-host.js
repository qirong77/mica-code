import { spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, shell, systemPreferences } from 'electron'
import {
  buildSystemChecks,
  parseClangVersion,
  parseXcodeSelectPath,
  requirePromptableCheck
} from './system-core.js'
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

/** 全磁盘访问探测用的那个文件：TCC 的数据库，只有拿到权限的进程读得开，且每台 macOS 上都有。 */
export function fullDiskAccessProbePath(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
}

/**
 * 真去开一次受保护的文件：开得起来 = 有全磁盘访问。
 *
 * 不用 `accessSync` 的返回值凑：「文件在不在」与「读不读得到」是两件事，这里要的是后者。
 * 打不开时按 errno 分：EPERM/EACCES 是权限没给，ENOENT 之类问不出来。
 */
export function probeFullDiskAccess({ platform = process.platform, path = '', open = openSync, close = closeSync } = {}) {
  if (platform !== 'darwin') return 'unknown'
  try {
    const fd = open(path || fullDiskAccessProbePath(), 'r')
    close(fd)
    return 'granted'
  } catch (error) {
    const code = String(error?.code || '')
    if (code === 'EPERM' || code === 'EACCES') return 'denied'
    return 'unknown'
  }
}

/** 读一次系统状态。`preferences`/`run` 可注入，方便单测替身。 */
export function probeSystemChecks({
  platform = process.platform,
  preferences = systemPreferences,
  run = runCommand,
  probeDisk = probeFullDiskAccess,
  execPath = process.execPath,
  packaged = false
} = {}) {
  if (platform !== 'darwin') return buildSystemChecks({ platform })

  return buildSystemChecks({
    platform,
    app: { path: execPath, packaged },
    // false = 不弹授权窗，只问当前状态
    accessibility: preferences.isTrustedAccessibilityClient(false) === true ? 'granted' : 'denied',
    screenRecording: preferences.getMediaAccessStatus('screen'),
    commandLineTools: {
      xcodePath: parseXcodeSelectPath(run('xcode-select', ['-p'])),
      clangVersion: parseClangVersion(run('clang', ['--version']))
    },
    fullDiskAccess: probeDisk({ platform })
  })
}

/**
 * 主动让系统登记**当前这个构建**：`isTrustedAccessibilityClient(true)` 会弹系统授权窗，
 * 并把正在运行的这个进程加进「辅助功能」列表。
 *
 * 这是本文件存在的核心理由之一。只查不登记（传 false）时，重新打包后的新构建根本不在
 * 列表里——用户在系统设置里勾的是上一次构建留下的那一行，勾了也不会生效。
 *
 * 返回值是「调用之后的当前状态」，通常仍是 false：申请只是把行加进列表，勾选还得用户做。
 */
export function requestCheckAccess(id, { platform = process.platform, preferences = systemPreferences } = {}) {
  const check = requirePromptableCheck(id)
  // 这个 API 只有 macOS 实现：别的平台上不调，如实回到「没有授权」而不是赌它不抛
  if (platform !== 'darwin') return { id: check, granted: false }
  if (check === 'accessibility') {
    return { id: check, granted: preferences.isTrustedAccessibilityClient(true) === true }
  }
  return { id: check, granted: false }
}

export async function startSystemHost({ socketPath, snapshotHeap } = {}) {
  if (!socketPath) throw new Error('startSystemHost 需要 socketPath')

  const service = createSystemService({
    probe: () => probeSystemChecks({ execPath: app.getPath('exe'), packaged: app.isPackaged }),
    openSettings: (pane) => shell.openExternal(pane),
    requestAccess: (id) => requestCheckAccess(id),
    snapshotHeap
  })

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => {})
  await service.listenSocket(socketPath)

  return {
    socketPath,
    probe: () => probeSystemChecks({ execPath: app.getPath('exe'), packaged: app.isPackaged }),
    async close() {
      await service.close().catch(() => {})
    }
  }
}

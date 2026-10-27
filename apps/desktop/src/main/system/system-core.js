/**
 * 系统检查的纯逻辑：把主进程能探测到的原始状态翻译成页面认得的三种状态
 * （`granted` / `denied` / `unknown`），并守住「只打开清单里声明过的设置面板」。
 *
 * 这一层刻意不 import electron：权限探测在 system-host.js（TCC 只属于有 app 身份的那个
 * 进程），这里只做映射与解析，bun test 可以直接覆盖。
 */

import { DESKTOP_CHECKS } from '@packages/mica-plugin/index.js'

export const SYSTEM_SERVICE_APP = 'mica-code-system'
export const SYSTEM_SERVICE_VERSION = 1

/** 页面上只有三种状态：开着、没开、问不出来（非 macOS，或没有桌面应用在跑）。 */
export const CHECK_STATUSES = ['granted', 'denied', 'unknown']

export class SystemRequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SystemRequestError'
    this.status = status
  }
}

export function normalizeCheckStatus(value) {
  return CHECK_STATUSES.includes(value) ? value : 'unknown'
}

/**
 * 允许打开的系统设置面板：**只有**清单里声明过的 `pane`。
 *
 * 这是个白名单而不是校验器：`open-settings` 最终会交给 `shell.openExternal`，
 * 放任意 URL 进来等于把「点一下跳设置」变成「点一下开任意 scheme」。
 */
const ALLOWED_PANES = new Set(DESKTOP_CHECKS.map((check) => check.pane).filter(Boolean))

export function allowedPanels() {
  return [...ALLOWED_PANES]
}

export function isAllowedPane(pane) {
  return typeof pane === 'string' && ALLOWED_PANES.has(pane.trim())
}

/** 没写或写了清单外的面板都拒绝，交给调用方转成 4xx。 */
export function requireAllowedPane(pane) {
  const value = typeof pane === 'string' ? pane.trim() : ''
  if (!value) throw new SystemRequestError('缺少 pane（要打开的系统设置面板）')
  if (!ALLOWED_PANES.has(value)) throw new SystemRequestError(`不认识的系统设置面板：${value}`)
  return value
}

/** `xcode-select -p` 只输出一行路径；命令失败时是空串。 */
export function parseXcodeSelectPath(output) {
  return (
    String(output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] || ''
  )
}

/** `clang --version` 首行形如 `Apple clang version 16.0.0 (clang-1600.0.26.6)`。 */
export function parseClangVersion(output) {
  const match = /clang(?:\s|-)?version\s+([0-9][^\s(]*)/i.exec(String(output || ''))
  return match ? match[1] : ''
}

/**
 * 辅助功能：主进程能直接给出布尔值（`isTrustedAccessibilityClient(false)` 不弹窗）。
 * 字符串分支留给测试与非 darwin 平台的调用方。
 */
export function describeAccessibility(value) {
  if (value === true || value === 'granted') return { status: 'granted', detail: '' }
  if (value === false || value === 'denied')
    return { status: 'denied', detail: '系统里还没有授予辅助功能权限' }
  return { status: 'unknown', detail: '' }
}

/** 屏幕录制：`systemPreferences.getMediaAccessStatus('screen')` 的几个取值。 */
export function describeScreenRecording(value) {
  const status = String(value || '').toLowerCase()
  if (status === 'granted') return { status: 'granted', detail: '' }
  if (status === 'restricted') {
    return { status: 'denied', detail: '这台机器限制了屏幕录制权限，需要管理员解除' }
  }
  if (status === 'not-determined') {
    return { status: 'denied', detail: '还没有授权过：在系统设置里勾选 Mica 后重启应用' }
  }
  if (status === 'denied')
    return { status: 'denied', detail: '系统里已经拒绝，勾选 Mica 后重启应用' }
  return { status: 'unknown', detail: '' }
}

/** 命令行工具：xcode-select 指得到路径、clang 也能跑，才算真的可用。 */
export function describeCommandLineTools({ platform, xcodePath = '', clangVersion = '' } = {}) {
  if (platform !== 'darwin') return { status: 'unknown', detail: '仅支持 macOS' }
  if (!xcodePath) {
    return {
      status: 'denied',
      detail: '未找到 Xcode Command Line Tools，执行 xcode-select --install 安装'
    }
  }
  if (!clangVersion) return { status: 'denied', detail: `${xcodePath} 下找不到可用的 clang` }
  return { status: 'granted', detail: `${xcodePath}（clang ${clangVersion}）` }
}

/**
 * 组装成页面与运行时都能直接吃的形状：顺序、文案、pane 全部来自 `DESKTOP_CHECKS`，
 * 新增一项检查只需要在主进程补一个探测器。
 */
export function buildSystemChecks({
  platform = process.platform,
  accessibility,
  screenRecording,
  commandLineTools
} = {}) {
  const resolved = {
    accessibility: describeAccessibility(accessibility),
    'screen-recording': describeScreenRecording(screenRecording),
    'command-line-tools': describeCommandLineTools({ platform, ...commandLineTools })
  }

  return {
    platform,
    checks: DESKTOP_CHECKS.map((check) => {
      const state = resolved[check.id] || { status: 'unknown', detail: '' }
      const entry = {
        id: check.id,
        label: check.label,
        description: check.description,
        status: normalizeCheckStatus(state.status),
        // 非 macOS 上「问不出来」要说明原因，否则页面只显示一个「未知」
        detail: state.detail || (platform === 'darwin' ? '' : '仅支持 macOS')
      }
      if (check.pane) entry.pane = check.pane
      return entry
    })
  }
}

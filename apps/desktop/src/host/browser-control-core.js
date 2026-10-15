/**
 * 受控浏览器在运行时的纯逻辑：快照归一化、技能文件写入判定、设置页详情装配、SSE 解析。
 *
 * 不 import electron、不发请求 —— 请求与 IPC 在 browser-control.js，这里只放能直接测的部分。
 */

/**
 * 地址、归属与 socket 三个变量名：一起写进技能文档与设置页，别在两处各写一份。
 *
 * 浏览器宿主活在 Electron 主进程里，它**不占 TCP 端口**，只监听一个 Unix socket；
 * 运行时在**自己已有的端口**上把 `/remote/control/*` 代理过去（见 browser-control-proxy.js），
 * 所以 agent 只需要一个普通的 HTTP 地址（`MICA_BROWSER_URL`），少开一个端口、也少一处
 * 需要单独做 Host/Origin 校验的入口。
 */
export const BROWSER_URL_ENV = 'MICA_BROWSER_URL'
export const BROWSER_OWNER_ENV = 'MICA_BROWSER_OWNER'
export const BROWSER_SOCKET_ENV = 'MICA_BROWSER_SOCKET'
/** 运行时把主进程的浏览器服务挂在哪个路径下（`MICA_BROWSER_URL` 的路径部分） */
export const BROWSER_CONTROL_PREFIX = '/remote/control'

/** 技能文件固定落在 `$MICA_HOME/skills/mica-browser/SKILL.md` */
export const SKILL_DIR_NAME = 'mica-browser'
export const SKILL_FILE_NAME = 'SKILL.md'

export function emptyBrowserSnapshot(error = null) {
  return { available: false, serviceUrl: null, browsers: [], skillPath: null, error }
}

/**
 * 归一化服务端返回的窗口列表：只保留界面真正会用的字段。服务端多给字段不会让界面出问题，
 * 少给字段则一律有默认值 —— 界面不该因为一次字段改名整块空掉。
 */
export function normalizeBrowserSummaries(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const tabs = Array.isArray(item.tabs)
        ? item.tabs.map((tab) => ({
            id: String(tab?.id || ''),
            title: String(tab?.title || ''),
            url: String(tab?.url || ''),
            active: Boolean(tab?.active)
          }))
        : []
      return {
        id: String(item.id || ''),
        owner: item.owner ? String(item.owner) : null,
        label: String(item.label || ''),
        title: String(item.title || ''),
        url: String(item.url || ''),
        visible: Boolean(item.visible),
        loading: Boolean(item.loading),
        activeTabId: item.activeTabId ? String(item.activeTabId) : null,
        tabs
      }
    })
    .filter((item) => item && item.id)
}

/** 只有内容真的变了才写技能文件：每次启动都重写会把用户的文件时间戳刷得没有意义 */
export function skillNeedsWrite(existing, next) {
  if (typeof next !== 'string' || !next.trim()) return false
  return existing !== next
}

export function skillFilePath(homeDir, separator = '/') {
  return [homeDir, 'skills', SKILL_DIR_NAME, SKILL_FILE_NAME].join(separator)
}

export function detailsFrom({ docs, browsers, serviceUrl, skillPath, error = null }) {
  const available = Boolean(serviceUrl)
  return {
    available,
    serviceUrl: serviceUrl || null,
    version: Number(docs?.version) || 0,
    skillPath: skillPath || null,
    error,
    browsers: normalizeBrowserSummaries(browsers),
    endpoints: Array.isArray(docs?.endpoints) ? docs.endpoints : [],
    markdown: typeof docs?.markdown === 'string' ? docs.markdown : '',
    skillMarkdown: typeof docs?.skillMarkdown === 'string' ? docs.skillMarkdown : '',
    envVars: { url: BROWSER_URL_ENV, owner: BROWSER_OWNER_ENV }
  }
}

/** 从 SSE 帧里取出 `channel` 与 `payload`；不是我们的帧就返回 null */
export function parseSseData(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  try {
    const parsed = JSON.parse(raw.slice(5).trim())
    if (!parsed || typeof parsed.channel !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** 快照是否与上一份等价：等价就不广播，避免每秒一次的无效重渲染 */
export function sameBrowsers(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || [])
}

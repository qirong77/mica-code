import { resolveMicaHome } from '@packages/mica-config/index.js'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import {
  annotationCounts,
  annotationsOf,
  normalizeSessionAnnotations,
  readAllSessionAnnotations,
  readSessionAnnotations,
  sessionAnnotationsPath,
  sessionAnnotationsExists,
  setSessionAnnotations,
  toggleSessionAnnotation,
  writeSessionAnnotations
} from '@packages/mica-plugin/sessionAnnotations.js'

/**
 * 会话行标记（宿主的通用读取面）。
 *
 * 这里**不认识任何具体插件**：谁在 `$MICA_HOME/plugin-data/<id>/session-annotations.json`
 * 里声明了 options，谁就出现在侧栏的圆点与右键菜单里。加一个新插件（优先级、审阅状态…）
 * 只需要写同一份文件，宿主代码一行不用改。
 *
 * 回写也走同一份结构：菜单点一下 → 宿主按 pluginId 定位文件 → 只 toggle 一个 option。
 * 插件自己的业务逻辑（色槽能不能删、上限多少）不在宿主这边判断，插件读回文件就能看到变化。
 */

function micaHome() {
  return process.env.MICA_HOME || resolveMicaHome()
}

let broadcastAnnotations = () => {}

/**
 * 由 server 注入：插件的页面改了自己的色板之后，所有窗口的侧栏都得重读一次。
 *
 * 走独立通道而不是 `stats:changed`：后者会让每个窗口重新序列化整份会话列表，而这里
 * 变的只是会话行上那几个点。
 */
export function setAnnotationBroadcaster(fn) {
  broadcastAnnotations = typeof fn === 'function' ? fn : () => {}
}

/** 所有提供标记的插件；没有 options 的提供者不返回（画不出东西，只会多一层空菜单）。 */
export function listSessionAnnotations() {
  return { providers: readAllSessionAnnotations(micaHome()) }
}

/** pluginId 会被当成目录名用，必须拦住路径穿越。 */
function assertPluginId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) return { ok: false, error: '缺少 pluginId' }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id.includes('..')) {
    return { ok: false, error: 'pluginId 非法' }
  }
  return { ok: true, id }
}

/**
 * 插件的页面读自己那份色板（标签表）。
 *
 * 页面拿 `counts` 不是为了画点，而是为了告诉用户「这个标签挂在几个会话上」——删之前
 * 得知道自己会摘掉多少东西。
 */
export function readAnnotationOptions({ pluginId } = {}) {
  const checked = assertPluginId(pluginId)
  if (!checked.ok) return { ok: false, error: checked.error }
  const home = micaHome()
  if (!sessionAnnotationsExists(home, checked.id)) return { ok: false, error: '插件还没有标记数据' }
  const data = readSessionAnnotations(home, checked.id)
  return { ok: true, name: data.name, options: data.options, counts: annotationCounts(data) }
}

/**
 * 整份替换色板（标签表的增删改都走这一条）。
 *
 * 宿主不判断「加得对不对、多了几个」——那是插件自己的规则。这里只保证三件事：跨进程
 * 互斥、按通用结构归一化（超长、非法颜色、重复 id 由 `normalizeSessionAnnotations` 收口）、
 * 删掉的项**同时**从会话归属里摘掉（否则文件里会留下永远画不出来的死 id）。
 */
export function replaceAnnotationOptions({ pluginId, options } = {}) {
  const checked = assertPluginId(pluginId)
  if (!checked.ok) return { ok: false, error: checked.error }
  if (!Array.isArray(options)) return { ok: false, error: 'options 必须是数组' }
  const home = micaHome()
  if (!sessionAnnotationsExists(home, checked.id)) return { ok: false, error: '插件没有提供会话标记' }

  const release = acquireProcessLock(`${sessionAnnotationsPath(home, checked.id)}.lock`)
  if (!release) return { ok: false, error: '其他会话正在更新标记，稍后重试' }
  try {
    const data = readSessionAnnotations(home, checked.id)
    const next = normalizeSessionAnnotations({ ...data, options })
    const known = new Set(next.options.map((option) => option.id))
    const assignments = {}
    for (const [sessionId, ids] of Object.entries(next.assignments)) {
      const kept = ids.filter((id) => known.has(id))
      if (kept.length > 0) assignments[sessionId] = kept
    }
    writeSessionAnnotations(home, checked.id, { ...next, assignments })
    broadcastAnnotations('annotations:changed', { pluginId: checked.id })
    return {
      ok: true,
      name: next.name,
      options: next.options,
      counts: annotationCounts({ ...next, assignments })
    }
  } finally {
    release()
  }
}

/** `on` 明确给了就按它来（同一项连点两下不会因为异步乱序打反），没给才当 toggle。 */
function applyAnnotation(data, sessionId, optionId, on) {
  if (typeof on !== 'boolean') return toggleSessionAnnotation(data, sessionId, optionId)
  const current = annotationsOf(data, sessionId)
  const next = on
    ? current.includes(optionId) ? current : [...current, optionId]
    : current.filter((item) => item !== optionId)
  return setSessionAnnotations(data, sessionId, next)
}

/**
 * 切换某个会话上的一个 option。
 *
 * 只接受「文件已经存在且插件声明过这个 option」的情况：拼错的 pluginId / optionId 直接拒绝，
 * 免得在 `plugin-data/` 下凭客户端输入创建出目录来。
 */
export function setSessionAnnotation({ pluginId, sessionId, optionId, on } = {}) {
  const home = micaHome()
  const checked = assertPluginId(pluginId)
  if (!checked.ok) return { ok: false, error: checked.error }
  const id = checked.id
  const session = typeof sessionId === 'string' ? sessionId.trim() : ''
  const option = typeof optionId === 'string' ? optionId.trim() : ''
  if (!session || !option) return { ok: false, error: '缺少 sessionId / optionId' }
  if (!sessionAnnotationsExists(home, id)) return { ok: false, error: '插件没有提供会话标记' }

  // 和插件自己的命令共用同一把跨进程锁：两边都先读再写，否则后写的一方会覆盖另一方的修改。
  const release = acquireProcessLock(`${sessionAnnotationsPath(home, id)}.lock`)
  if (!release) return { ok: false, error: '其他会话正在更新标记，稍后重试' }
  try {
    const data = readSessionAnnotations(home, id)
    if (!data.options.some((item) => item.id === option)) return { ok: false, error: '未知的标记项' }

    writeSessionAnnotations(home, id, applyAnnotation(data, session, option, on))
    return { ok: true, providers: readAllSessionAnnotations(home) }
  } finally {
    release()
  }
}

import { resolveMicaHome } from '@packages/mica-config/index.js'
import {
  annotationsOf,
  readAllSessionAnnotations,
  readSessionAnnotations,
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

/** 所有提供标记的插件；没有 options 的提供者不返回（画不出东西，只会多一层空菜单）。 */
export function listSessionAnnotations() {
  return { providers: readAllSessionAnnotations(micaHome()) }
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
  const id = typeof pluginId === 'string' ? pluginId.trim() : ''
  const session = typeof sessionId === 'string' ? sessionId.trim() : ''
  const option = typeof optionId === 'string' ? optionId.trim() : ''
  if (!id || !session || !option) return { ok: false, error: '缺少 pluginId / sessionId / optionId' }
  // pluginId 直接当目录名用，必须拦住路径穿越。
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id.includes('..')) {
    return { ok: false, error: 'pluginId 非法' }
  }
  if (!sessionAnnotationsExists(home, id)) return { ok: false, error: '插件没有提供会话标记' }

  const data = readSessionAnnotations(home, id)
  if (!data.options.some((item) => item.id === option)) return { ok: false, error: '未知的标记项' }

  writeSessionAnnotations(home, id, applyAnnotation(data, session, option, on))
  return { ok: true, providers: readAllSessionAnnotations(home) }
}

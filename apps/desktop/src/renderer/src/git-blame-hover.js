/**
 * 给 diff 编辑器接上「悬停显示这一行的作者 / 提交 / 时间」（GitLens 的行为）。
 *
 * 只对 diff 编辑器创建的 model 生效：模型在 `GitDiffEditor` 里建的时候登记进 WeakMap，
 * 别的编辑器（普通文件）由同一个 provider 直接放行，不查 blame 也不增加请求。
 *
 * provider 按语言注册而不是按 scheme：`LanguageSelector` 里的 scheme 过滤依赖
 * Monaco 内部的注册表匹配规则，按语言注册则是它最常用的那条路径，行为确定。
 */
import { createBlameResolver } from './git-blame'

const models = new WeakMap()
const registeredLanguages = new Set()
let resolver = null

function ensureProvider(monaco, languageId) {
  if (!languageId || registeredLanguages.has(languageId)) return
  registeredLanguages.add(languageId)
  monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      const meta = models.get(model)
      if (!meta || !resolver) return null
      const line = position.lineNumber
      const value = await resolver.lookup(meta, line)
      if (!value) return null
      return {
        range: new monaco.Range(line, 1, line, Math.max(1, model.getLineMaxColumn(line))),
        contents: [{ value }]
      }
    }
  })
}

/**
 * 把 diff 模型登记进来：`meta` 是 `{ cwd, path, blame, sourceLabel }`，其中 `blame`
 * 由 host 的 `git:file` 给出（告诉这里该读提交、索引还是工作区）。
 */
export function bindBlameModel(monaco, model, meta) {
  if (!monaco || !model || !meta?.blame) return
  models.set(model, meta)
  ensureProvider(monaco, model.getLanguageId())
}

/** 读 blame 的实现只在这里绑定一次（`window.mica.git.blame`）。 */
export function configureBlame(read) {
  resolver = createBlameResolver(read)
  return resolver
}

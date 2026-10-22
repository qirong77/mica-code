// 工具输出「在编辑器中打开」的页签规则（纯逻辑，不碰 monaco）。
//
// 为什么要抽出来：monaco 的 model 是按 URI 注册的全局资源，同一个 URI 建第二个 model
// 会直接抛 `ModelService: Cannot add model because it already exists!`。而「同一个工具
// 调用被点开两次」在回合日志里非常常见，所以「用哪个 URI、什么时候复用页签」必须是
// 可单测的规则，而不是散在组件里的 if。

const PREFIX = 'mica-document://'

/**
 * 文档在编辑器里的唯一标识。
 *
 * 用页面内的 `path` 字段承载（虚拟文档不进文件树，这个值只当 map key 与面包屑的判定依据）。
 * `encodeURIComponent` 保证 id 里的 `/`、`:`、`#` 不会让 monaco 把 URI 解析成另一条路径。
 */
export function documentKey(id) {
  const value = String(id ?? '').trim() || 'document'
  return `${PREFIX}${encodeURIComponent(value)}`
}

/** 这个 path 是不是虚拟文档（而不是工作区里的文件）。 */
export function isDocumentKey(path) {
  return String(path ?? '').startsWith(PREFIX)
}

/**
 * 打开一段文本时的决策：
 * - `reuse` 已经有了同一个文档的页签 → 只刷新内容并激活（不能新建 model）
 * - 否则新建页签
 */
export function planDocumentOpen(tabs, id) {
  const key = documentKey(id)
  const existing = (tabs || []).find((tab) => tab.path === key && tab.model) || null
  return { key, reuse: existing }
}

/**
 * 页签名去重。
 *
 * 同一个工具被调用多次时标题相同（都是「Shell 参数」），页签栏会退化成用父目录消歧——
 * 而虚拟文档没有目录，后缀会显示成 `mica-document:` 这种东西。这里直接给后者加序号，
 * 名字自己就能分清。
 */
export function uniqueDocumentTitle(tabs, title, key) {
  const base = String(title ?? '').trim() || '预览'
  const used = new Set((tabs || []).filter((tab) => tab.path !== key).map((tab) => tab.name || ''))
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base} (${index})`)) index += 1
  return `${base} (${index})`
}

/** 激活页签时要同步给共享 editor 的选项：虚拟文档只读，磁盘文件照旧可写。 */
export function editorOptionsForTab(tab) {
  return { readOnly: Boolean(tab && tab.readOnly) }
}

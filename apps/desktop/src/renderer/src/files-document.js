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

/**
 * 哪些文件默认交给 Markdown 编辑器。
 *
 * 只认 `.md` / `.markdown`：`.mdx` 里是 JSX，Markdown 往返表达不了，按普通文本开更安全。
 */
const MARKDOWN_EXTENSIONS = ['md', 'markdown']

export function isMarkdownFile(path) {
  const name = String(path ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .at(-1)
  if (!name || !name.includes('.')) return false
  return MARKDOWN_EXTENSIONS.includes(name.split('.').at(-1).toLowerCase())
}

/**
 * 这个页签当前用哪一套编辑界面。
 *
 * `markdown` 是共享 Lexical 编辑器的 Markdown 模式，`source` 是 monaco 纯文本。
 * 没有 `markdown` 标记的页签（普通文件、虚拟文档）永远走源码，与以前完全一致。
 */
export function editorSurface(tab) {
  return tab && tab.markdown ? 'markdown' : 'source'
}

/**
 * 新旧文本之间真正变化的那一段：公共前缀之后的 `[start, end)` 换成 `text`。
 *
 * Markdown 编辑器每敲一个字都会把整篇正文交回来。整篇 `setValue` 会让 monaco 丢掉撤销栈、
 * 并对整篇重新分词（大文档每敲一个字都卡一次）；只替换变化的那一段，撤销、分词和视口都
 * 保持增量。相同文本返回 null。
 */
export function planTextReplacement(previous, next) {
  if (previous === next) return null
  const shorter = Math.min(previous.length, next.length)
  let start = 0
  while (start < shorter && previous[start] === next[start]) start += 1
  let tail = 0
  while (tail < shorter - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail])
    tail += 1
  return { start, end: previous.length - tail, text: next.slice(start, next.length - tail) }
}

/**
 * 把整段文本写回 monaco 模型，只动变化的那一段。
 *
 * 先按 model 的换行符归一化：Monaco 写入时也会这样做，提前对齐才能识别没有变化的 flush，
 * 避免 CRLF 文件保存后又被同一份 LF Markdown 标成 dirty。
 */
export function writeModelText(model, next) {
  const previous = model.getValue()
  if (previous === next) return false
  const eol = model.getEOL()
  const normalized = eol === '\n' ? next.replace(/\r\n|\r/g, eol) : next.replace(/\r\n|\r|\n/g, eol)
  const change = planTextReplacement(previous, normalized)
  if (!change) return false
  const from = model.getPositionAt(change.start)
  const to = model.getPositionAt(change.end)
  model.applyEdits([
    {
      range: {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column
      },
      text: change.text
    }
  ])
  return true
}

/** 文档操作按发起顺序执行；一次失败不阻塞后续的保存、切换或关闭。 */
export function createDocumentTaskQueue() {
  let tail = Promise.resolve()
  return (operation) => {
    const result = tail.then(operation)
    tail = result.catch(() => {})
    return result
  }
}

/**
 * 保存绑定到发起时的 model。先加锁、取得最新 Markdown，再检查版本是否需要写盘。
 * findTab / updateTab 必须按 model 身份查找，不能把等待期间产生的新页签或 dirty 状态覆盖掉。
 */
export async function saveDocumentTab({ tab, findTab, updateTab, synchronize, write }) {
  const current = findTab(tab)
  if (!current?.model || current.readOnly || current.loading || current.saving) return null
  const model = current.model
  updateTab(current, { saving: true })
  try {
    await synchronize(current)
    const latest = findTab(current)
    if (!latest) return null
    const content = model.getValue()
    const savedVersion = model.getAlternativeVersionId()
    if (savedVersion === latest.savedVersion) return null
    const result = await write(latest.path, content, latest.diskVersion)
    if (!findTab(current)) return null
    const dirty = model.getAlternativeVersionId() !== savedVersion
    updateTab(current, { savedVersion, diskVersion: result.version, dirty })
    return { dirty }
  } finally {
    updateTab(current, { saving: false })
  }
}

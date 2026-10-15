import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowBackUp,
  IconArrowUpRight,
  IconChevronRight,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconX
} from '@tabler/icons-react'
import { FileSystemIcon } from './FileIcon'
import {
  codeColor,
  codeLabel,
  stagedCode,
  statusColor,
  statusLabel,
  worktreeCode
} from './git-decorations'

// 面板外壳的尺寸取自 VS Code 实测值：栏头 35px（标题 13px 半粗，左侧 16px 内边距），
// 行高 22px、圆角 2px，行内是「16px 图标格 + 5px 间隙」。
const PANEL_HEADER = 'flex h-[35px] shrink-0 items-center gap-1 pl-4 pr-2'
const PANEL_TITLE = 'min-w-0 flex-1 truncate text-[13px] font-semibold text-white/80'
const PANEL_ACTION =
  'grid size-6 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white'
// 列表行：22px 高、4px 圆角（VS Code 的列表行悬浮块），悬浮底色比面板更暗。
const ROW_BASE = 'flex h-[22px] w-full items-center rounded text-left'
const FIELD_BASE =
  'h-[26px] w-full rounded-[2px] border bg-white/[.02] px-2 text-[12px] text-white/85 placeholder:text-white/30 focus:outline-none'

function Spinner() {
  return (
    <span
      className="size-3 shrink-0 animate-spin rounded-full border border-white/25 border-t-white/75"
      aria-hidden="true"
    />
  )
}

/** VS Code 的搜索开关：Aa（区分大小写）/ ab（全字匹配）/ .*（正则）。 */
function Toggle({ active, label, title, onClick }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`grid h-5 min-w-5 shrink-0 place-items-center rounded-[3px] px-0.5 font-mono text-[11px] leading-none ${
        active ? 'bg-white/20 text-white' : 'text-white/45 hover:bg-white/[.08] hover:text-white/85'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/** 命中高亮：偏移由 host 算好（长行截断与正则模式下渲染层自己找不准）。 */
function Highlight({ text, range }) {
  const value = String(text ?? '')
  if (!range) return value
  const [start, end] = range
  if (!(start >= 0) || end <= start) return value
  return (
    <>
      {value.slice(0, start)}
      <mark className="rounded-[2px] bg-warn/25 font-semibold text-warn-soft">
        {value.slice(start, end)}
      </mark>
      {value.slice(end)}
    </>
  )
}

function groupResults(items) {
  const groups = new Map()
  for (const item of items) {
    const parts = String(item.relativePath || item.path).split('/')
    const name = parts.at(-1)
    const directory = parts.slice(0, -1).join('/')
    if (!groups.has(item.path))
      groups.set(item.path, { path: item.path, name, directory, matches: [] })
    groups.get(item.path).matches.push(item)
  }
  return [...groups.values()]
}

export function SearchPanel({ root, onOpenFile, activePath }) {
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [result, setResult] = useState({ items: [], truncated: false, error: null })
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())
  // 「刷新」按钮靠它重新跑一次同样的查询（查询串本身没变，没法当依赖用）
  const [nonce, setNonce] = useState(0)
  const requestRef = useRef(0)

  useEffect(() => {
    if (!root || !query.trim()) {
      requestRef.current += 1
      setResult({ items: [], truncated: false, error: null })
      setBusy(false)
      return undefined
    }
    const request = ++requestRef.current
    const timer = window.setTimeout(async () => {
      try {
        setBusy(true)
        const response = await window.mica.files.search(root, query, {
          matchCase,
          wholeWord,
          regex,
          include,
          exclude
        })
        if (request !== requestRef.current) return
        setResult(response || { items: [], truncated: false, error: null })
      } catch (error) {
        if (request !== requestRef.current) return
        setResult({ items: [], truncated: false, error: `搜索失败：${error?.message || error}` })
      } finally {
        if (request === requestRef.current) setBusy(false)
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      requestRef.current += 1
    }
  }, [query, root, matchCase, wholeWord, regex, include, exclude, nonce])

  useEffect(() => {
    if (!root) {
      setQuery('')
      setResult({ items: [], truncated: false, error: null })
    }
  }, [root])

  const groups = useMemo(() => groupResults(result.items), [result.items])
  const fileCount = groups.length
  const matchCount = result.items.length

  const toggleGroup = useCallback((path) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const status = !root
    ? '选择一个终端会话以搜索文件'
    : result.error
      ? result.error
      : query.trim() && !busy && matchCount === 0
        ? '没有匹配的结果'
        : ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={PANEL_HEADER}>
        <span className={PANEL_TITLE}>搜索</span>
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          className={PANEL_ACTION}
          onClick={() => setNonce((value) => value + 1)}
        >
          <IconRefresh size={15} />
        </button>
        <button
          type="button"
          title="清除搜索"
          aria-label="清除搜索"
          className={PANEL_ACTION}
          onClick={() => {
            setQuery('')
            setInclude('')
            setExclude('')
          }}
        >
          <IconX size={15} />
        </button>
      </header>
      <div className="shrink-0 space-y-1 px-2 pb-1">
        <div className="flex h-[26px] items-center gap-1 rounded-[2px] border border-white/[.12] bg-white/[.03] px-2 focus-within:border-accent/70">
          <input
            type="text"
            value={query}
            placeholder="搜索"
            aria-label="搜索文件内容"
            className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-white/90 placeholder:text-white/30 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
          {busy && <Spinner />}
          <Toggle
            active={matchCase}
            label="Aa"
            title="区分大小写"
            onClick={() => setMatchCase((v) => !v)}
          />
          <Toggle
            active={wholeWord}
            label="ab"
            title="全字匹配"
            onClick={() => setWholeWord((v) => !v)}
          />
          <Toggle
            active={regex}
            label=".*"
            title="使用正则表达式"
            onClick={() => setRegex((v) => !v)}
          />
        </div>
        <input
          type="text"
          value={include}
          placeholder="包含的文件"
          aria-label="包含的文件"
          title="逗号分隔的文件名或路径通配（*.ts、src/**）"
          className={`${FIELD_BASE} border-white/[.08]`}
          onChange={(event) => setInclude(event.target.value)}
        />
        <input
          type="text"
          value={exclude}
          placeholder="排除的文件"
          aria-label="排除的文件"
          title="逗号分隔的文件名或路径通配（*.test.ts、dist/**）"
          className={`${FIELD_BASE} border-white/[.08]`}
          onChange={(event) => setExclude(event.target.value)}
        />
      </div>
      {matchCount > 0 && (
        <div className="shrink-0 truncate px-4 pb-1 text-[12px] text-white/45">
          {fileCount} 个文件中有 {matchCount} 个结果
          {result.truncated ? '（已达上限）' : ''}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        {status && (
          <div className="px-3 py-4 text-[13px] leading-relaxed text-white/40">{status}</div>
        )}
        {groups.map((group) => {
          const closed = collapsed.has(group.path)
          return (
            <div key={group.path}>
              <button
                type="button"
                title={group.path}
                aria-expanded={!closed}
                className={`${ROW_BASE} gap-1 pl-1 pr-1.5 text-[13px] text-white/75 hover:bg-list-hover hover:text-white`}
                onClick={() => toggleGroup(group.path)}
              >
                <span
                  className={`grid size-4 shrink-0 place-items-center text-white/40 ${closed ? '' : 'rotate-90'}`}
                >
                  <IconChevronRight size={14} />
                </span>
                <span className="grid size-4 shrink-0 place-items-center text-white/50">
                  <FileSystemIcon name={group.name} className="size-4" />
                </span>
                <span className="ml-[5px] min-w-0 shrink-0 truncate">{group.name}</span>
                <span className="ml-1.5 min-w-0 flex-1 truncate text-[12px] text-white/35">
                  {group.directory}
                </span>
                <span className="ml-1.5 grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-white/10 px-1 text-[11px] leading-none text-white/70 tabular-nums">
                  {group.matches.length}
                </span>
              </button>
              {!closed &&
                group.matches.map((match, index) => (
                  <button
                    key={`${match.line}-${index}`}
                    type="button"
                    title={`${match.path}:${match.line}`}
                    className={`${ROW_BASE} pr-1.5 font-mono text-[12px] hover:bg-list-hover ${
                      activePath === match.path ? 'text-white' : 'text-white/60 hover:text-white/85'
                    }`}
                    style={{ paddingLeft: 22 }}
                    onClick={() => onOpenFile(match.path, match.line)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <Highlight text={match.preview} range={match.highlight} />
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 变更列表 / 变更树 */

/**
 * 行尾的 `+N -M`（对应 VS Code 的 `showDiffStats`）。二进制文件或纯重命名两侧都是 0
 * 时不占位——空白的 `+0 -0` 只会让行变吵。
 */
function GitDiffStat({ additions, deletions }) {
  if (!additions && !deletions) return null
  return (
    <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums">
      {additions ? <span style={{ color: 'var(--color-git-added)' }}>+{additions}</span> : null}
      {additions && deletions ? ' ' : null}
      {deletions ? <span style={{ color: 'var(--color-git-deleted)' }}>-{deletions}</span> : null}
    </span>
  )
}

/**
 * 工作区里还有没提交的改动。变更树比的是「工作区相对比较基线」，所以一个文件可能既有
 * 已提交的部分、又有还没提交的部分，小圆点就是这个提醒（悬浮提示里说明是哪一种）。
 */
function UncommittedDot({ title = '工作区里还有没提交的改动' }) {
  return (
    <span
      title={title}
      aria-label={title}
      className="ml-1.5 size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: 'var(--color-warn)', opacity: 0.85 }}
    />
  )
}

/** 行尾状态字母：CHANGES 列表用 porcelain 的单侧状态码，变更树只有三态。 */
function StatusLetter({ status, code }) {
  const letter = code ? codeLabel(code) : statusLabel(status)
  const color = code ? codeColor(code) : statusColor(status)
  return (
    <span className="ml-2 shrink-0 font-mono text-[11px] font-semibold" style={{ color }}>
      {letter}
    </span>
  )
}

/** 文件/目录行尾的「状态 + 统计 + 未提交点」，三段顺序两个变体共用。 */
function RowTrailing({ status, code, additions, deletions, uncommitted, uncommittedTitle }) {
  return (
    <>
      <GitDiffStat additions={additions} deletions={deletions} />
      {uncommitted && <UncommittedDot title={uncommittedTitle} />}
      <StatusLetter status={status} code={code} />
    </>
  )
}

/**
 * 文件行：与 VS Code 的源代码管理一致——文件图标 + 名字（普通前景色）、目录路径
 * 暗色跟在后面且空间不够时先被截断、状态字母贴右缘；鼠标悬浮时在字母左边浮出
 * 操作按钮（打开文件 / 放弃更改 / 暂存或取消暂存），路径同时被挤得更短。
 */
function GitFileRow({
  file,
  depth = 0,
  selected,
  section,
  onSelect,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  showDirectory,
  onContextMenu
}) {
  const parts = String(file.path).split('/')
  const name = file.name || parts.at(-1)
  const directory = parts.slice(0, -1).join('/')
  // 分段各自的状态字符：已暂存的段看索引侧，工作区段看工作区侧。GIT 变更树拿到的是
  // 「相对比较基线」的差异（`git diff --name-status`），没有 porcelain 的 XY，这时退回三态。
  const code = section === 'staged' ? stagedCode(file.code) : worktreeCode(file.code)
  const actions = []
  if (onOpen) {
    actions.push({
      key: 'open',
      label: '打开文件',
      Icon: IconArrowUpRight,
      run: () => onOpen(file)
    })
  }
  if (section === 'staged') {
    if (onUnstage) {
      actions.push({
        key: 'unstage',
        label: '取消暂存',
        Icon: IconMinus,
        run: () => onUnstage(file)
      })
    }
  } else {
    if (onDiscard) {
      actions.push({
        key: 'discard',
        label: '放弃更改',
        Icon: IconArrowBackUp,
        run: () => onDiscard(file)
      })
    }
    if (onStage) {
      actions.push({ key: 'stage', label: '暂存更改', Icon: IconPlus, run: () => onStage(file) })
    }
  }
  return (
    <div
      className={`group flex h-[22px] w-full items-center rounded-sm pr-1.5 ${
        selected ? 'bg-white/[.075]' : 'hover:bg-list-hover'
      }`}
      style={{ paddingLeft: 5 + depth * 8 }}
      onContextMenu={(event) => onContextMenu?.(event, file)}
    >
      <button
        type="button"
        title={file.path}
        onClick={() => onSelect(file, section)}
        className="flex min-w-0 flex-1 items-center text-left"
      >
        <span className="grid size-4 shrink-0 place-items-center">
          <FileSystemIcon name={name} className="size-4" />
        </span>
        <span
          className={`ml-[5px] min-w-0 shrink truncate text-[13px] ${
            selected ? 'text-white' : 'text-white/75 group-hover:text-white'
          }`}
        >
          {name}
        </span>
        {showDirectory && directory && (
          <span className="ml-1.5 min-w-0 flex-1 truncate text-[12px] text-white/[.58]">
            {directory}
          </span>
        )}
      </button>
      {/* 悬浮/聚焦才出现，键盘用户 tab 进来也能拿到（与 VS Code 一致） */}
      {actions.length > 0 && (
        <span className="ml-1 hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
          {actions.map(({ key, label, Icon, run }) => (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              className="grid size-5 shrink-0 place-items-center rounded-sm text-white/55 hover:bg-white/[.08] hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                run()
              }}
            >
              <Icon size={14} />
            </button>
          ))}
        </span>
      )}
      <RowTrailing
        status={file.status}
        code={code}
        additions={file.additions}
        deletions={file.deletions}
        uncommitted={!code && file.uncommitted}
        uncommittedTitle={
          file.status === 'added'
            ? '这个文件还没有提交过'
            : '工作区里还有没提交的改动，diff 里也含这部分'
        }
      />
    </div>
  )
}

/** Source control owns index/worktree actions; branch comparison has its own panel. */
export function GitPanel({
  cwd,
  repository,
  loading,
  onRefresh,
  onSelectFile,
  selectedPath,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard
}) {
  const [collapsed, setCollapsed] = useState(() => new Set())
  const files = repository?.files || []
  const sections = [
    { key: 'staged', label: '暂存的更改', files: files.filter((file) => stagedCode(file.code)) },
    { key: 'changes', label: '更改', files: files.filter((file) => worktreeCode(file.code)) }
  ]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={PANEL_HEADER}>
        <span className={PANEL_TITLE}>源代码管理</span>
        {loading && <Spinner />}
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          className={PANEL_ACTION}
          onClick={() => onRefresh?.()}
        >
          <IconRefresh size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        {!repository && (
          <div className="px-3 py-4 text-[13px] text-white/40">
            {loading
              ? '正在读取 Git 工作区…'
              : !cwd
                ? '选择一个会话以查看 Git 变化'
                : '当前目录不在 Git 仓库中'}
          </div>
        )}
        {repository &&
          sections
            .filter((section) => section.key === 'changes' || section.files.length)
            .map((section) => (
              <Fragment key={section.key}>
                <button
                  type="button"
                  aria-expanded={!collapsed.has(section.key)}
                  className={`${ROW_BASE} gap-1 pl-1 pr-1.5 text-[12px] font-semibold text-white/70 hover:bg-list-hover`}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (next.has(section.key)) next.delete(section.key)
                      else next.add(section.key)
                      return next
                    })
                  }
                >
                  <IconChevronRight
                    size={14}
                    className={collapsed.has(section.key) ? '' : 'rotate-90'}
                  />
                  <span className="min-w-0 flex-1">{section.label}</span>
                  <span className="text-[11px] tabular-nums">{section.files.length}</span>
                </button>
                {!collapsed.has(section.key) &&
                  section.files.map((file) => (
                    <GitFileRow
                      key={`${section.key}:${file.path}`}
                      file={file}
                      section={section.key}
                      selected={selectedPath === `${section.key}:${file.path}`}
                      onSelect={onSelectFile}
                      onOpen={onOpenFile}
                      onStage={onStage}
                      onUnstage={onUnstage}
                      onDiscard={onDiscard}
                      showDirectory
                    />
                  ))}
                {!collapsed.has(section.key) &&
                  section.key === 'changes' &&
                  !section.files.length && (
                    <div className="px-5 py-2 text-[12px] text-white/40">工作区没有文件变化</div>
                  )}
              </Fragment>
            ))}
      </div>
    </div>
  )
}

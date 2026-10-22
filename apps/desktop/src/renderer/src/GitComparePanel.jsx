import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowBackUp,
  IconArrowUpRight,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconDots,
  IconFileDiff,
  IconFolderOpen,
  IconGitBranch,
  IconGitCompare,
  IconList,
  IconRefresh,
  IconSearch,
  IconSquareMinus,
  IconSquarePlus,
  IconX
} from '@tabler/icons-react'
import { FileSystemIcon } from './FileIcon'
import { FloatingMenu, MenuItem, MenuSeparator } from './FloatingMenu'
import { GitComparePicker } from './GitComparePicker'
import { statusColor, statusLabel } from './git-decorations'
import { longPressHandlers } from './hooks'
import { setUiStateEntries, useUiStateValue } from './ui-state'
import {
  buildCompareRows,
  comparePreferences,
  compareTreeKey,
  filterCompareFiles,
  reconcileCompareFocus,
  revealComparePath,
  reviewSummary,
  visibleCompareRows
} from './git-compare-model'

const EMPTY_FILES = []
const EMPTY_REVIEWED = {}
const ACTION =
  'grid size-6 shrink-0 place-items-center rounded-sm text-white/50 hover:bg-white/[.08] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-30'

function ReviewCheckbox({ row, onToggle }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = row.mixed
  }, [row.mixed])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={row.checked}
      disabled={!onToggle}
      tabIndex={-1}
      aria-label={`${row.checked ? '标记为未审阅' : '标记为已审阅'}：${row.path}`}
      title={row.mixed ? '部分文件已审阅' : row.checked ? '已审阅 · 点击取消' : '标记为已审阅'}
      className="mx-1 size-3 shrink-0 cursor-pointer accent-accent opacity-65 hover:opacity-100"
      onClick={(event) => {
        event.stopPropagation()
        event.currentTarget.closest('[role="treeitem"]')?.focus()
      }}
      onChange={(event) => onToggle?.(row.files, event.target.checked)}
    />
  )
}

function CompareRow({
  row,
  selected,
  focused,
  closed,
  preferences,
  onFocus,
  onActivate,
  onPin,
  onKeyDown,
  onContextMenu,
  onToggleReviewed,
  onOpenFile,
  onDiscard,
  elementRef
}) {
  const directory = row.type === 'directory'
  const code = row.untracked
    ? 'U'
    : { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' }[row.status] || 'M'
  const badgeColor = row.untracked
    ? 'bg-fg-ghost'
    : row.status === 'added'
      ? 'bg-success-soft'
      : row.status === 'deleted'
        ? 'bg-git-deleted'
        : 'bg-info'
  return (
    <div
      ref={elementRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={directory ? !closed : undefined}
      aria-selected={selected}
      aria-checked={preferences.showCheckboxes ? (row.mixed ? 'mixed' : row.checked) : undefined}
      aria-label={`${row.path}, ${directory ? `${row.total} 个更改` : statusLabel(row.status)}`}
      tabIndex={focused ? 0 : -1}
      title={`${row.path}${row.uncommitted ? '\n包含未提交更改' : ''}${row.binary ? '\n二进制文件' : ''}`}
      className={`group relative flex h-[22px] shrink-0 cursor-default items-center pr-1 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${selected ? 'bg-accent/15 text-white' : 'text-white/75 hover:bg-list-hover'}`}
      style={{ paddingLeft: 5 + row.depth * 8 }}
      onFocus={onFocus}
      onClick={onActivate}
      onDoubleClick={directory ? undefined : onPin}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      {...longPressHandlers(onContextMenu)}
    >
      {Array.from({ length: row.depth }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 border-l border-white/[.08]"
          style={{ left: 12 + index * 8 }}
        />
      ))}
      <span className="grid size-4 shrink-0 place-items-center text-white/45">
        {directory && <IconChevronRight size={14} className={closed ? '' : 'rotate-90'} />}
      </span>
      {preferences.showCheckboxes && <ReviewCheckbox row={row} onToggle={onToggleReviewed} />}
      {directory || preferences.iconStyle === 'file' ? (
        <FileSystemIcon name={row.path} type={row.type} expanded={!closed} className="size-4" />
      ) : (
        <span
          aria-hidden="true"
          className={`grid size-4 shrink-0 place-items-center rounded-[5px] font-mono text-[11px] leading-none text-fg-max ${badgeColor}`}
        >
          {code}
        </span>
      )}
      <span className={`ml-[5px] min-w-0 truncate ${row.checked ? 'opacity-55' : ''}`}>
        {row.name}
      </span>
      {preferences.viewMode === 'list' && row.directory && (
        <span className="ml-1.5 min-w-0 flex-1 truncate text-[11px] text-white/35">
          {row.directory}
        </span>
      )}
      <span className="min-w-0 flex-1" />
      {/* 悬浮/聚焦才出现的行内操作（与 VS Code 的源代码管理一致）：先撤回再打开。
          撤回只对「工作区里还有未提交改动」的文件给出，撤的是工作区那份改动。 */}
      {!directory && (onDiscard || onOpenFile) && (
        <span className="ml-1 hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
          {onDiscard && row.uncommitted && (
            <button
              type="button"
              tabIndex={-1}
              title="放弃更改"
              aria-label={`放弃更改：${row.path}`}
              className="grid size-[18px] shrink-0 place-items-center rounded-sm text-white/50 hover:bg-white/10 hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                onDiscard(row.files)
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <IconArrowBackUp size={13} />
            </button>
          )}
          {onOpenFile && row.status !== 'deleted' && (
            <button
              type="button"
              tabIndex={-1}
              title="打开文件"
              aria-label={`打开文件：${row.path}`}
              className="grid size-[18px] shrink-0 place-items-center rounded-sm text-white/50 hover:bg-white/10 hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                onOpenFile(row.files[0])
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <IconArrowUpRight size={13} />
            </button>
          )}
        </span>
      )}
      {preferences.showStats && !row.binary && Boolean(row.additions || row.deletions) && (
        <span
          className="ml-1.5 flex shrink-0 gap-1 font-mono text-[10px] tabular-nums"
          aria-label={`新增 ${row.additions} 行，删除 ${row.deletions} 行`}
        >
          {row.additions > 0 && <span className="text-success-soft">+{row.additions}</span>}
          {row.deletions > 0 && <span className="text-danger-soft">−{row.deletions}</span>}
        </span>
      )}
      {row.uncommitted && (
        <span
          aria-label="包含未提交更改"
          title="包含未提交更改"
          className="ml-1.5 size-1 shrink-0 rounded-full bg-white/45"
        />
      )}
      {directory ? (
        <span className="ml-1.5 min-w-3 shrink-0 text-right text-[10px] tabular-nums text-white/35">
          {row.total}
        </span>
      ) : preferences.iconStyle === 'file' ? (
        <span
          className="ml-1.5 w-3 shrink-0 text-center text-[11px]"
          style={{ color: statusColor(row.status) }}
          aria-hidden="true"
        >
          {code}
        </span>
      ) : null}
    </div>
  )
}

/** Dedicated read-only Git Tree Compare surface. Reviewed fingerprints are owned by the parent. */
export function GitComparePanel({
  cwd,
  repository,
  loading,
  error,
  branch,
  compareBase,
  onCompareBaseChange,
  onRefresh,
  selectedPath,
  onSelectFile,
  onOpenFile,
  onDiscard,
  onRevealFile,
  onCopyPath,
  onOpenAll,
  reviewed = EMPTY_REVIEWED,
  onToggleReviewed
}) {
  const root = repository?.root || cwd || ''
  const preferencesByRoot = useUiStateValue('gitComparePreferences', EMPTY_REVIEWED)
  const preferences = useMemo(
    () => comparePreferences(preferencesByRoot?.[root]),
    [preferencesByRoot, root]
  )
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [rootCollapsed, setRootCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menu, setMenu] = useState(null)
  const [focusedId, setFocusedId] = useState(null)
  const treeRef = useRef(null)
  const rowRefs = useRef(new Map())
  const previousRowsRef = useRef([])
  const treeFocusedRef = useRef(false)
  const searchRef = useRef(null)
  const revealedRef = useRef('')
  const menuReturnRef = useRef(null)
  const menuScopeRef = useRef(null)
  const suppressClickUntilRef = useRef(0)
  const files = repository?.files || EMPTY_FILES
  const visibleFiles = useMemo(
    () => filterCompareFiles(files, query, preferences.unreviewedOnly, reviewed),
    [files, query, preferences.unreviewedOnly, reviewed]
  )
  const allRows = useMemo(
    () => buildCompareRows(visibleFiles, { ...preferences, reviewed }),
    [visibleFiles, preferences, reviewed]
  )
  const rows = useMemo(() => visibleCompareRows(allRows, collapsed), [allRows, collapsed])
  const progress = useMemo(() => reviewSummary(files, reviewed), [files, reviewed])
  const visibleProgress = useMemo(
    () => reviewSummary(visibleFiles, reviewed),
    [visibleFiles, reviewed]
  )
  const effectiveFocus = focusedId
    ? reconcileCompareFocus(rows, focusedId, previousRowsRef.current)
    : rows.find((row) => row.path === selectedPath)?.id || rows[0]?.id
  const repoName = root.split(/[\\/]/).filter(Boolean).at(-1) || '仓库'
  const branchName =
    (typeof branch === 'string' ? branch : branch?.name) || repository?.branch || 'HEAD'
  const baseName =
    compareBase?.kind === 'head'
      ? 'HEAD'
      : compareBase?.kind && compareBase.kind !== 'auto'
        ? compareBase.name || compareBase.ref || repository?.baseLabel || '选择基线'
        : repository?.baseLabel || '自动基线'
  const failure = error || repository?.error
  const headComparison = compareBase?.kind === 'head' || repository?.base === 'HEAD'
  const filtered = Boolean(query.trim() || preferences.unreviewedOnly)
  const unavailable = !cwd || !repository || Boolean(failure)

  const closeMenu = useCallback(() => {
    setMenu(null)
    if (menuReturnRef.current?.isConnected) menuReturnRef.current.focus()
  }, [])

  function setPreference(key, value) {
    if (root)
      setUiStateEntries('gitComparePreferences', { [root]: { ...preferences, [key]: value } })
  }

  useEffect(() => {
    setCollapsed(new Set())
    setRootCollapsed(false)
    setQuery('')
    setMenu(null)
    setPickerOpen(false)
    setFocusedId(null)
    revealedRef.current = ''
  }, [root])

  useEffect(() => {
    if (!selectedPath) return
    const key = `${root}:${preferences.viewMode}:${preferences.compactFolders}:${selectedPath}`
    if (
      revealedRef.current === key ||
      !allRows.some((row) => row.type === 'file' && row.path === selectedPath)
    )
      return
    revealedRef.current = key
    setCollapsed((current) => revealComparePath(allRows, selectedPath, current))
    setRootCollapsed(false)
    setFocusedId(`file:${selectedPath}`)
    requestAnimationFrame(() =>
      rowRefs.current.get(`file:${selectedPath}`)?.scrollIntoView?.({ block: 'nearest' })
    )
  }, [selectedPath, root, preferences.viewMode, preferences.compactFolders, allRows])

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    previousRowsRef.current = rows
  }, [rows])

  useEffect(() => {
    if (focusedId && effectiveFocus && focusedId !== effectiveFocus) setFocusedId(effectiveFocus)
  }, [effectiveFocus, focusedId])

  useEffect(() => {
    if (treeFocusedRef.current && document.activeElement === document.body && !rootCollapsed)
      rowRefs.current.get(effectiveFocus)?.focus()
  }, [rows, effectiveFocus, rootCollapsed])

  useEffect(() => {
    if (!menu) return undefined
    const controls = () => [
      ...(menuScopeRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])
    ]
    controls()[0]?.focus()
    const navigate = (event) => {
      if (!menuScopeRef.current?.contains(event.target)) return
      const buttons = controls()
      const index = buttons.indexOf(document.activeElement)
      const next =
        event.key === 'ArrowDown'
          ? (index + 1) % buttons.length
          : event.key === 'ArrowUp'
            ? (index - 1 + buttons.length) % buttons.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : null
      if (next != null) {
        event.preventDefault()
        buttons[next]?.focus()
      }
      if (event.key === 'Tab') closeMenu()
    }
    window.addEventListener('keydown', navigate)
    return () => window.removeEventListener('keydown', navigate)
  }, [menu, closeMenu])

  function toggleFolder(id) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function activate(row) {
    if (Date.now() < suppressClickUntilRef.current) return
    setFocusedId(row.id)
    rowRefs.current.get(row.id)?.focus()
    if (row.type === 'directory') toggleFolder(row.id)
    else onSelectFile?.(row.files[0])
  }

  function openMenu(event, row = null) {
    event.preventDefault()
    event.stopPropagation()
    if (event.pointerType && event.pointerType !== 'mouse') {
      suppressClickUntilRef.current = Date.now() + 800
    }
    if (row) {
      setFocusedId(row.id)
      rowRefs.current.get(row.id)?.focus()
    }
    menuReturnRef.current = document.activeElement
    setMenu({ x: event.clientX, y: event.clientY, row })
  }

  function onTreeKey(event, row) {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const rect = event.currentTarget.getBoundingClientRect()
      openMenu(
        {
          preventDefault: () => event.preventDefault(),
          stopPropagation: () => event.stopPropagation(),
          clientX: rect.left + 30,
          clientY: rect.bottom
        },
        row
      )
      return
    }
    const action = compareTreeKey(rows, row.id, event.key, collapsed)
    if (!Object.keys(action).length) return
    event.preventDefault()
    if (action.focusId) {
      setFocusedId(action.focusId)
      rowRefs.current.get(action.focusId)?.focus()
      rowRefs.current.get(action.focusId)?.scrollIntoView?.({ block: 'nearest' })
    }
    if (action.toggleId) toggleFolder(action.toggleId)
    if (action.activateId) onSelectFile?.(row.files[0])
    if (action.reviewId && preferences.showCheckboxes) onToggleReviewed?.(row.files, !row.checked)
  }

  function menuAction(run) {
    closeMenu()
    run()
  }
  const context = menu?.row
  const menuFiles = context?.files || visibleFiles
  const menuProgress = context || visibleProgress
  // 撤回只对「工作区里还有未提交改动」的文件有意义：比基线多出来的已提交改动撤不掉。
  const discardable = menuFiles.filter((file) => file.uncommitted)

  return (
    <section
      className="flex h-full min-h-0 flex-col text-white/80"
      aria-label="Git 比较"
      aria-busy={Boolean(loading)}
    >
      <header className="flex h-[35px] shrink-0 items-center gap-0.5 pl-4 pr-2">
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-semibold"
          title={root ? `Git 比较 · ${root}` : 'Git 比较'}
        >
          {repoName || 'Git 比较'}
        </span>
        <button
          type="button"
          className={ACTION}
          title="筛选更改"
          aria-label="筛选更改"
          aria-pressed={searchOpen}
          onClick={() => {
            setSearchOpen((value) => !value)
            if (searchOpen) setQuery('')
          }}
        >
          <IconSearch size={15} />
        </button>
        <button
          type="button"
          className={ACTION}
          title="刷新比较"
          aria-label="刷新比较"
          disabled={!cwd || loading}
          onClick={onRefresh}
        >
          <IconRefresh size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          className={ACTION}
          title="折叠所有文件夹"
          aria-label="折叠所有文件夹"
          disabled={!allRows.length}
          onClick={() => {
            setCollapsed(
              new Set(allRows.filter((row) => row.type === 'directory').map((row) => row.id))
            )
            setRootCollapsed(false)
          }}
        >
          <IconSquareMinus size={15} />
        </button>
        <button
          type="button"
          className={ACTION}
          title="更多比较操作"
          aria-label="更多比较操作"
          data-git-compare-menu="true"
          aria-haspopup="menu"
          aria-expanded={Boolean(menu && !menu.row)}
          onClick={(event) => {
            if (menu && !menu.row) {
              closeMenu()
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            openMenu({
              preventDefault() {},
              stopPropagation() {},
              clientX: rect.left,
              clientY: rect.bottom
            })
          }}
        >
          <IconDots size={16} />
        </button>
      </header>

      <div className="mx-2 mb-1 flex min-h-8 shrink-0 items-center rounded-sm border border-white/[.08] bg-white/[.025]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left hover:bg-white/[.05] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-40"
          disabled={!cwd || !onCompareBaseChange}
          title={`比较基线：${baseName} · 点击选择分支、标签或提交`}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(true)}
        >
          <IconGitCompare size={16} className="shrink-0 text-info-soft" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-white/90">{baseName}</span>
          <IconChevronRight size={12} className="shrink-0 rotate-90 text-white/40" />
        </button>
        <button
          type="button"
          disabled={!cwd || !onCompareBaseChange || headComparison}
          aria-pressed={Boolean(compareBase?.direct)}
          title={
            headComparison
              ? 'HEAD 比较只包含未提交更改'
              : compareBase?.direct
                ? '完整比较：直接与基线比较，点击切换到合并基点'
                : '合并比较：从共同祖先计算更改，点击切换到完整比较'
          }
          className="mr-1 shrink-0 rounded-sm border-l border-white/10 px-1.5 py-0.5 text-[10px] text-white/50 hover:bg-white/[.08] hover:text-white disabled:opacity-35"
          onClick={() =>
            onCompareBaseChange?.({
              ...(compareBase || { kind: 'auto', ref: null, name: '自动基线' }),
              direct: !compareBase?.direct
            })
          }
        >
          {headComparison ? '工作区' : compareBase?.direct ? '完整' : '合并'}
        </button>
      </div>

      {searchOpen && (
        <div className="mx-2 mb-1 flex h-[26px] shrink-0 items-center gap-1 rounded-sm border border-white/15 bg-white/[.025] px-2 focus-within:border-accent/70">
          <IconSearch size={13} className="shrink-0 text-white/40" />
          <input
            ref={searchRef}
            aria-label="按路径筛选更改"
            placeholder="筛选文件或路径"
            value={query}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-white/35"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('')
                setSearchOpen(false)
                rowRefs.current.get(effectiveFocus)?.focus()
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                rowRefs.current.get(effectiveFocus)?.focus()
              }
            }}
          />
          <button
            type="button"
            className="text-white/40 hover:text-white"
            title="关闭筛选"
            aria-label="关闭筛选"
            onClick={() => {
              setQuery('')
              setSearchOpen(false)
            }}
          >
            <IconX size={13} />
          </button>
        </div>
      )}
      {preferences.unreviewedOnly && (
        <div className="mx-2 mb-1 flex shrink-0 items-center gap-1 text-[11px] text-info-soft">
          <IconCheck size={12} />
          <span className="flex-1">仅显示未审阅</span>
          <button
            type="button"
            title="显示全部更改"
            aria-label="显示全部更改"
            onClick={() => setPreference('unreviewedOnly', false)}
          >
            <IconX size={13} />
          </button>
        </div>
      )}

      {!unavailable && (
        <button
          type="button"
          title={`${root}\n当前分支：${branchName}`}
          aria-expanded={!rootCollapsed}
          className="flex h-[22px] shrink-0 items-center gap-1 px-[5px] text-left hover:bg-list-hover"
          onClick={() => setRootCollapsed((value) => !value)}
        >
          <IconChevronRight
            size={14}
            className={`shrink-0 text-white/50 ${rootCollapsed ? '' : 'rotate-90'}`}
          />
          <IconGitBranch size={12} className="shrink-0 text-white/35" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-white/60">
            {branchName} · 工作区
          </span>
          <span className="mr-1 text-[10px] tabular-nums text-white/40">
            {filtered ? `${visibleFiles.length}/` : ''}
            {files.length}
          </span>
        </button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
        {repository?.warning && (
          <div role="status" className="px-3 py-2 text-[11px] text-warn-soft">
            {repository.warning}
          </div>
        )}
        {failure ? (
          <div role="alert" className="px-4 py-4 text-[12px] leading-relaxed">
            <p className="mb-2 text-danger-soft">
              {typeof failure === 'string' ? failure : failure.message || '无法读取 Git 比较'}
            </p>
            <button
              type="button"
              className="text-info-soft hover:underline"
              disabled={loading}
              onClick={onRefresh}
            >
              重新比较
            </button>
          </div>
        ) : !cwd ? (
          <p className="px-4 py-4 text-[12px] leading-relaxed text-white/45">
            选择一个项目或终端会话以比较 Git 更改。
          </p>
        ) : !repository ? (
          <p role="status" className="px-4 py-4 text-[12px] leading-relaxed text-white/45">
            {loading ? '正在读取仓库…' : '当前目录不属于 Git 仓库。'}
          </p>
        ) : !files.length ? (
          <div role="status" className="px-4 py-5 text-[12px] leading-relaxed text-white/45">
            <IconCheck size={22} className="mb-2 text-white/25" />
            <p>
              {loading
                ? '正在比较…'
                : compareBase?.kind === 'head'
                  ? '工作区没有未提交的更改。'
                  : `相对 ${baseName} 没有更改。`}
            </p>
            <button
              type="button"
              className="mt-2 text-info-soft hover:underline"
              onClick={() => setPickerOpen(true)}
            >
              选择其他比较基线
            </button>
          </div>
        ) : !visibleFiles.length ? (
          <div role="status" className="px-4 py-5 text-[12px] leading-relaxed text-white/45">
            <p>
              {preferences.unreviewedOnly && progress.checked
                ? '全部更改已审阅。'
                : '没有符合筛选条件的更改。'}
            </p>
            <button
              type="button"
              className="mt-2 text-info-soft hover:underline"
              onClick={() => {
                setQuery('')
                setPreference('unreviewedOnly', false)
              }}
            >
              显示全部更改
            </button>
          </div>
        ) : (
          !rootCollapsed && (
            <div
              ref={treeRef}
              role="tree"
              aria-label="比较中的更改"
              onFocusCapture={() => {
                treeFocusedRef.current = true
              }}
              onBlurCapture={(event) => {
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
                  treeFocusedRef.current = false
              }}
            >
              {rows.map((row) => (
                <CompareRow
                  key={row.id}
                  row={row}
                  selected={row.type === 'file' && selectedPath === row.path}
                  focused={effectiveFocus === row.id}
                  closed={collapsed.has(row.id)}
                  preferences={preferences}
                  elementRef={(element) => {
                    if (element) rowRefs.current.set(row.id, element)
                    else rowRefs.current.delete(row.id)
                  }}
                  onFocus={() => setFocusedId(row.id)}
                  onActivate={() => activate(row)}
                  onPin={() => onSelectFile?.(row.files[0], true)}
                  onKeyDown={(event) => onTreeKey(event, row)}
                  onContextMenu={(event) => openMenu(event, row)}
                  onToggleReviewed={onToggleReviewed}
                  onOpenFile={onOpenFile}
                  onDiscard={onDiscard}
                />
              ))}
            </div>
          )
        )}
      </div>
      <footer
        className="flex h-6 shrink-0 items-center gap-2 border-t border-white/[.06] px-3 text-[10px] tabular-nums text-white/40"
        aria-live="polite"
      >
        <span className="min-w-0 flex-1 truncate">
          {loading
            ? '正在比较…'
            : `${visibleFiles.length}${filtered ? ` / ${files.length}` : ''} 个更改`}
        </span>
        <span title="文件修改后会自动恢复为未审阅">
          已审阅 {progress.count}/{progress.total}
        </span>
        {progress.total > 0 && (
          <span
            role="progressbar"
            aria-label="审阅进度"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.count}
            className="h-1 w-9 overflow-hidden rounded bg-white/10"
          >
            <span
              className="block h-full bg-success-soft/70"
              style={{ width: `${(progress.count / progress.total) * 100}%` }}
            />
          </span>
        )}
      </footer>

      {pickerOpen && (
        <GitComparePicker
          key={root}
          cwd={cwd}
          current={compareBase}
          onClose={() => setPickerOpen(false)}
          onPick={(value) => {
            setPickerOpen(false)
            onCompareBaseChange?.(value)
          }}
        />
      )}
      {menu && (
        <div ref={menuScopeRef}>
          <FloatingMenu
            x={menu.x}
            y={menu.y}
            minWidth={224}
            onClose={closeMenu}
            ignoreSelector="[data-git-compare-menu]"
          >
            {context ? (
              <>
                {context.type === 'file' ? (
                  <>
                    <MenuItem
                      icon={IconFileDiff}
                      label="打开更改"
                      onClick={() => menuAction(() => onSelectFile?.(context.files[0]))}
                    />
                    <MenuItem
                      icon={IconArrowUpRight}
                      label="打开文件"
                      disabled={!onOpenFile || context.status === 'deleted'}
                      onClick={() => menuAction(() => onOpenFile?.(context.files[0]))}
                    />
                  </>
                ) : (
                  <MenuItem
                    icon={IconFileDiff}
                    label={`打开目录中的全部更改 (${menuFiles.length})`}
                    disabled={!onOpenAll}
                    onClick={() => menuAction(() => onOpenAll?.(menuFiles))}
                  />
                )}
                <MenuItem
                  icon={IconArrowBackUp}
                  label={
                    context.type === 'file'
                      ? '放弃更改'
                      : `放弃目录中的更改 (${discardable.length})`
                  }
                  hint={context.type === 'file' && !context.uncommitted ? '无未提交改动' : ''}
                  disabled={
                    !onDiscard ||
                    (context.type === 'file' ? !context.uncommitted : !discardable.length)
                  }
                  onClick={() =>
                    menuAction(() =>
                      onDiscard?.(context.type === 'file' ? context.files : discardable)
                    )
                  }
                />
                <MenuItem
                  icon={IconCheck}
                  label={menuProgress.checked ? '标记为未审阅' : '标记为已审阅'}
                  disabled={!onToggleReviewed}
                  onClick={() =>
                    menuAction(() => onToggleReviewed?.(menuFiles, !menuProgress.checked))
                  }
                />
                <MenuSeparator />
                <MenuItem
                  icon={IconFolderOpen}
                  label="在文件管理器中显示"
                  disabled={!onRevealFile}
                  onClick={() =>
                    menuAction(() =>
                      onRevealFile?.(
                        context.type === 'file'
                          ? context.files[0]
                          : { path: context.path, type: 'directory' }
                      )
                    )
                  }
                />
                <MenuItem
                  icon={IconClipboard}
                  label="复制路径"
                  disabled={!onCopyPath}
                  onClick={() => menuAction(() => onCopyPath?.({ path: context.path }, false))}
                />
                <MenuItem
                  icon={IconClipboard}
                  label="复制相对路径"
                  disabled={!onCopyPath}
                  onClick={() => menuAction(() => onCopyPath?.({ path: context.path }, true))}
                />
              </>
            ) : (
              <>
                <MenuItem
                  icon={IconGitCompare}
                  label="选择比较基线…"
                  disabled={!cwd || !onCompareBaseChange}
                  onClick={() => menuAction(() => setPickerOpen(true))}
                />
                <MenuItem
                  icon={IconFileDiff}
                  label={`打开全部更改 (${visibleFiles.length})`}
                  disabled={!visibleFiles.length || !onOpenAll}
                  onClick={() => menuAction(() => onOpenAll?.(visibleFiles))}
                />
                <MenuItem
                  icon={IconArrowBackUp}
                  label={`放弃全部未提交的更改 (${discardable.length})`}
                  disabled={!onDiscard || !discardable.length}
                  onClick={() => menuAction(() => onDiscard?.(discardable))}
                />
                <MenuSeparator />
                <MenuItem
                  icon={IconList}
                  label={preferences.viewMode === 'tree' ? '切换为列表视图' : '切换为树视图'}
                  onClick={() =>
                    menuAction(() =>
                      setPreference('viewMode', preferences.viewMode === 'tree' ? 'list' : 'tree')
                    )
                  }
                />
                <MenuItem
                  icon={IconCheck}
                  label="使用文件类型图标"
                  hint={preferences.iconStyle === 'file' ? '✓' : ''}
                  onClick={() =>
                    menuAction(() =>
                      setPreference(
                        'iconStyle',
                        preferences.iconStyle === 'file' ? 'status' : 'file'
                      )
                    )
                  }
                />
                <MenuItem
                  icon={IconCheck}
                  label="紧凑文件夹"
                  hint={preferences.compactFolders ? '✓' : ''}
                  disabled={preferences.viewMode === 'list'}
                  onClick={() =>
                    menuAction(() => setPreference('compactFolders', !preferences.compactFolders))
                  }
                />
                <MenuItem
                  icon={IconCheck}
                  label="显示增删行数"
                  hint={preferences.showStats ? '✓' : ''}
                  onClick={() =>
                    menuAction(() => setPreference('showStats', !preferences.showStats))
                  }
                />
                <MenuItem
                  icon={IconCheck}
                  label="显示审阅复选框"
                  hint={preferences.showCheckboxes ? '✓' : ''}
                  onClick={() =>
                    menuAction(() => setPreference('showCheckboxes', !preferences.showCheckboxes))
                  }
                />
                <MenuItem
                  icon={IconCheck}
                  label="仅显示未审阅"
                  hint={preferences.unreviewedOnly ? '✓' : ''}
                  onClick={() =>
                    menuAction(() => setPreference('unreviewedOnly', !preferences.unreviewedOnly))
                  }
                />
                <MenuSeparator />
                <MenuItem
                  icon={IconSquarePlus}
                  label="展开所有文件夹"
                  disabled={!files.length}
                  onClick={() =>
                    menuAction(() => {
                      setCollapsed(new Set())
                      setRootCollapsed(false)
                    })
                  }
                />
                <MenuItem
                  icon={IconSquareMinus}
                  label="折叠所有文件夹"
                  disabled={!files.length}
                  onClick={() =>
                    menuAction(() => {
                      setCollapsed(
                        new Set(
                          allRows.filter((row) => row.type === 'directory').map((row) => row.id)
                        )
                      )
                      setRootCollapsed(false)
                    })
                  }
                />
                <MenuSeparator />
                <MenuItem
                  icon={IconCheck}
                  label="将显示的更改全部标为已审阅"
                  disabled={!menuFiles.length || !onToggleReviewed || menuProgress.checked}
                  onClick={() => menuAction(() => onToggleReviewed?.(menuFiles, true))}
                />
                <MenuItem
                  icon={IconX}
                  label="将显示的更改全部标为未审阅"
                  disabled={!menuProgress.count || !onToggleReviewed}
                  onClick={() => menuAction(() => onToggleReviewed?.(menuFiles, false))}
                />
              </>
            )}
          </FloatingMenu>
        </div>
      )}
    </section>
  )
}

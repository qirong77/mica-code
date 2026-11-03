import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowLeft,
  IconCopy,
  IconGitBranch,
  IconGitCommit,
  IconRefresh,
  IconSearch
} from '@tabler/icons-react'
import { Button, SelectMenu } from '@mica-config-ui/web'
import { absoluteTime, relativeTime } from './git-blame'
import { statusColor, statusLabel } from './git-decorations'
import {
  branchOptions,
  filterCommits,
  formatChangeCounts,
  layoutGraph,
  mergeHistory
} from './git-graph'
import { GitDiffEditor } from './GitDiffEditor'

const ROW_HEIGHT = 26
const LANE_WIDTH = 14
const LANE_PAD = 8

const BADGE = 'shrink-0 rounded-sm border px-1 text-[10px] leading-4'

function RefBadge({ badge }) {
  const style =
    badge.kind === 'head'
      ? 'border-accent/60 bg-accent-subtle text-accent'
      : badge.kind === 'tag'
        ? 'border-git-modified/50 text-git-modified'
        : badge.kind === 'remote'
          ? 'border-line text-fg-dim'
          : 'border-git-added/50 text-git-added'
  return (
    <span
      className={`${BADGE} ${style}`}
      title={badge.kind === 'head' ? `当前检出：${badge.name}` : badge.name}
    >
      {badge.name}
    </span>
  )
}

/** 一条提交：泳道线段 + 提交点，宽度跟着这一行的泳道数走。 */
function GraphCell({ row }) {
  const width = row.laneCount * LANE_WIDTH + LANE_PAD
  const x = (lane) => LANE_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2
  const y = (unit) => unit * ROW_HEIGHT
  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      {row.edges.map((edge, index) => {
        const [x0, y0] = edge.from
        const [x1, y1] = edge.to
        if (x0 === x1) {
          return (
            <line
              key={index}
              x1={x(x0)}
              y1={y(y0)}
              x2={x(x1)}
              y2={y(y1)}
              stroke={edge.color}
              strokeWidth={2}
              strokeLinecap="round"
            />
          )
        }
        const startY = y(y0)
        const endY = y(y1)
        return (
          <path
            key={index}
            d={`M ${x(x0)} ${startY} C ${x(x0)} ${startY + (endY - startY) * 0.6} ${x(x1)} ${endY - (endY - startY) * 0.6} ${x(x1)} ${endY}`}
            fill="none"
            stroke={edge.color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        )
      })}
      <circle
        cx={x(row.lane)}
        cy={y(0.5)}
        r={4}
        fill={row.color}
        stroke="var(--color-canvas)"
        strokeWidth={2}
      />
    </svg>
  )
}

export function GitGraphView({ cwd, onOpenFile, onClose, mobile = false }) {
  const [branch, setBranch] = useState('')
  const [page, setPage] = useState({ key: '', skip: 0 })
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const [history, setHistory] = useState({ commits: [], head: '', branch: '', more: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')
  const [open, setOpen] = useState(null)
  const [refs, setRefs] = useState({ branches: [], tags: [] })
  const listRef = useRef(null)
  const historyKey = JSON.stringify([cwd, branch, retry])
  const skip = page.key === historyKey ? page.skip : 0

  useEffect(() => {
    if (page.key !== historyKey) setPage({ key: historyKey, skip: 0 })
  }, [historyKey, page.key])

  useEffect(() => {
    if (!cwd) return undefined
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.resolve()
      .then(() => window.mica.git.log(cwd, { ref: branch || undefined, max: 200, skip }))
      .then((response) => {
        if (cancelled) return
        if (response?.error) throw new Error(response.error)
        const history = response?.history || {}
        setHistory((previous) => mergeHistory(previous, history, skip))
      })
      .catch((failure) => {
        if (!cancelled) setError(failure?.message || String(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [branch, cwd, retry, skip])

  useEffect(() => {
    if (!cwd) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => window.mica.git.refs(cwd))
      .then((response) => {
        if (cancelled || response?.error) return
        const list = response?.refs || {}
        setRefs({
          branches: list.branches || [],
          tags: list.tags || []
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cwd, retry])

  const visible = useMemo(() => filterCommits(history.commits, query), [history.commits, query])
  const rows = useMemo(() => layoutGraph(visible), [visible])

  // 选中的提交跟着列表走：刷新后它可能不在了（被过滤、被 rebase 掉），回到第一条。
  useEffect(() => {
    if (!visible.length) {
      setSelected('')
      return
    }
    if (!visible.some((commit) => commit.hash === selected)) setSelected(visible[0].hash)
  }, [selected, visible])

  useEffect(() => {
    if (!cwd || !selected) {
      setDetail(null)
      setDetailError('')
      return undefined
    }
    let cancelled = false
    setDetail(null)
    setDetailError('')
    Promise.resolve()
      .then(() => window.mica.git.commit(cwd, selected))
      .then((response) => {
        if (cancelled) return
        if (response?.error) throw new Error(response.error)
        setDetail(response?.detail || null)
      })
      .catch((failure) => {
        if (!cancelled) setDetailError(failure?.message || String(failure))
      })
    return () => {
      cancelled = true
    }
  }, [cwd, selected])

  const selectCommit = useCallback((hash) => {
    setSelected(hash)
    requestAnimationFrame(() => {
      const element = listRef.current?.querySelector(`[data-hash="${hash}"]`)
      element?.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  const moveSelection = (delta) => {
    if (!visible.length) return
    const index = visible.findIndex((commit) => commit.hash === selected)
    const next = Math.min(Math.max(index + delta, 0), visible.length - 1)
    if (next !== index) selectCommit(visible[next].hash)
  }

  const copyHash = async (hash) => {
    try {
      await navigator.clipboard.writeText(hash)
    } catch {
      // 没有剪贴板权限时不打断浏览，哈希仍然可以手动选中
    }
  }

  const openCommitFile = (file) => {
    if (!detail?.commit) return
    const head = detail.commit.hash
    const base = detail.base
    setOpen({
      path: file.path,
      status: file.status,
      base: {
        mode: 'refs',
        ref: base,
        head,
        label: detail.commit.parents.length ? base.slice(0, 8) : '初始提交',
        headLabel: detail.commit.shortHash
      }
    })
  }

  if (open) {
    return (
      <div className="mica-config-ui is-embed is-fill flex h-full min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center border-b border-line px-2">
          <Button
            variant="ghost"
            size="compact"
            icon={<IconArrowLeft size={14} />}
            onClick={() => setOpen(null)}
          >
            返回图谱
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <GitDiffEditor
            cwd={cwd}
            file={open}
            comparisonLabel={`${open.base.headLabel} · 相对 ${open.base.label}`}
            onClose={() => setOpen(null)}
            onOpenFile={onOpenFile ? () => onOpenFile({ path: open.path }) : undefined}
          />
        </div>
      </div>
    )
  }

  if (!cwd) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-fg-muted">
        这个目录还不是 Git 仓库，没有提交历史可显示。
      </div>
    )
  }

  return (
    <div className="mica-config-ui is-embed is-fill flex h-full min-h-0 flex-col text-[12px]">
      <header className="flex h-[35px] shrink-0 items-center gap-2 border-b border-line px-3">
        {mobile && (
          <Button
            variant="ghost"
            size="compact"
            icon={<IconArrowLeft size={14} />}
            title="返回文件列表"
            onClick={onClose}
          />
        )}
        <IconGitCommit size={16} className="shrink-0 text-fg-muted" />
        <span className="shrink-0 font-semibold text-fg-strong">Git 图谱</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={cwd || ''}>
          {history.branch ? `当前分支 ${history.branch} · ` : ''}
          {history.commits.length} 个提交
        </span>
        <Button
          variant="ghost"
          size="compact"
          icon={<IconRefresh size={14} className={loading ? 'animate-spin' : ''} />}
          title="刷新"
          disabled={loading}
          onClick={() => setRetry((value) => value + 1)}
        />
      </header>
      {/* 工具栏自己开一层：下拉弹层要盖住下面的提交列表，不能被后面的兄弟节点压住。 */}
      <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1">
        {/* 分支选择器与设置页同一个下拉（见 @mica-config-ui/web）：原生 select 的弹层
            由系统绘制，几百个分支时会铺满整屏、点不动也关不掉。
            下拉自己按内容收缩，容器却是固定宽度的：不传 flex-1 的话它只画到
            「全部分支」四个字那么宽，右边剩下的 100 多像素看着就像搜索框被推远了。 */}
        <span
          className="flex min-w-0 items-center gap-1"
          style={{ width: 'clamp(120px, 22vw, 220px)' }}
        >
          <IconGitBranch size={13} className="shrink-0 text-fg-muted" />
          <SelectMenu
            className="min-w-0 flex-1"
            size="compact"
            filterable
            filterPlaceholder="筛选分支"
            menuMinWidth={340}
            value={branch}
            options={branchOptions(refs)}
            ariaLabel="分支"
            onChange={setBranch}
          />
        </span>
        {/* 宽度与内边距都写在 .text-input 那一侧（见 @mica-config-ui/web 的 styles.css）：
            它的规则不在 @layer 里，这边的 Tailwind w-56 / pl-6 会被压掉——宽度退回
            浏览器给搜索框的默认值，图标正好压在占位文字上。 */}
        <span className="relative inline-flex w-56 items-center">
          <IconSearch
            size={13}
            className="pointer-events-none absolute top-1/2 left-[7px] -translate-y-1/2 text-fg-muted"
          />
          <input
            type="search"
            value={query}
            placeholder="搜索说明、作者或提交号"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            className="text-input is-compact text-input-with-icon"
          />
        </span>
        <span className="text-[11px] text-fg-dim">
          {query ? `${visible.length} / ${history.commits.length} 条` : ''}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          ref={listRef}
          role="listbox"
          aria-label="提交列表"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveSelection(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveSelection(-1)
            }
          }}
          className="min-h-0 flex-1 overflow-auto focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          {error && (
            <p className="p-4 text-fg-soft" role="alert">
              无法读取提交历史：<span className="text-danger">{error}</span>
            </p>
          )}
          {!error && !visible.length && (
            <p className="p-4 text-fg-dim">{loading ? '正在读取提交历史…' : '没有匹配的提交'}</p>
          )}
          {rows.map((row) => {
            const commit = row.commit
            const active = commit.hash === selected
            return (
              <div
                key={commit.hash}
                data-hash={commit.hash}
                role="option"
                aria-selected={active}
                tabIndex={-1}
                onClick={() => setSelected(commit.hash)}
                className={`flex h-[26px] cursor-default items-center gap-1.5 pr-2 ${
                  active ? 'bg-overlay-strong' : 'hover:bg-overlay'
                }`}
              >
                <GraphCell row={row} />
                <span className="flex shrink-0 items-center gap-1">
                  {(commit.refs || []).map((badge) => (
                    <RefBadge key={`${badge.kind}-${badge.name}`} badge={badge} />
                  ))}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${active ? 'text-fg-max' : 'text-fg-soft'}`}
                  title={commit.subject}
                >
                  {commit.subject}
                </span>
                <span className="hidden w-28 shrink-0 truncate text-[11px] text-fg-dim sm:block">
                  {commit.author}
                </span>
                <span
                  className="w-16 shrink-0 text-right text-[11px] text-fg-dim"
                  title={absoluteTime(Date.parse(commit.date))}
                >
                  {relativeTime(Date.parse(commit.date))}
                </span>
                <span className="hidden w-16 shrink-0 font-mono text-[11px] text-fg-faint md:block">
                  {commit.shortHash}
                </span>
              </div>
            )
          })}
          {history.more && !query && (
            <div className="border-t border-line py-1.5">
              <Button
                variant="ghost"
                size="compact"
                fullWidth
                disabled={loading}
                onClick={() => setPage({ key: historyKey, skip: history.commits.length })}
              >
                加载更早的提交
              </Button>
            </div>
          )}
        </div>
        <aside className="flex min-h-0 w-full shrink-0 flex-col overflow-auto border-t border-line bg-panel md:w-[320px] md:border-l md:border-t-0">
          {detailError && (
            <p className="p-3 text-[11px] text-danger" role="alert">
              {detailError}
            </p>
          )}
          {!detail && !detailError && <p className="p-3 text-[11px] text-fg-dim">正在读取提交…</p>}
          {detail && !detailError && (
            <>
              <div className="border-b border-line p-3">
                <p className="select-text text-[12px] font-semibold leading-5 text-fg-strong">
                  {detail.commit.subject}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {detail.commit.refs.map((badge) => (
                    <RefBadge key={`${badge.kind}-${badge.name}`} badge={badge} />
                  ))}
                </div>
                <dl className="mt-2 space-y-1 text-[11px] text-fg-muted">
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0">提交</dt>
                    <dd className="flex min-w-0 items-center gap-1">
                      <span className="truncate font-mono text-fg-soft">{detail.commit.hash}</span>
                      <Button
                        variant="ghost"
                        size="compact"
                        icon={<IconCopy size={12} />}
                        title="复制提交号"
                        onClick={() => copyHash(detail.commit.hash)}
                      />
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0">作者</dt>
                    <dd className="min-w-0 truncate text-fg-soft" title={detail.commit.email}>
                      {detail.commit.author}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0">时间</dt>
                    <dd className="min-w-0 truncate text-fg-soft">
                      {absoluteTime(Date.parse(detail.commit.date))}
                      <span className="text-fg-dim">
                        （{relativeTime(Date.parse(detail.commit.date))}）
                      </span>
                    </dd>
                  </div>
                  {detail.commit.parents.length > 1 && (
                    <div className="flex gap-2">
                      <dt className="w-12 shrink-0">合并</dt>
                      <dd className="min-w-0 text-fg-soft">
                        {detail.commit.parents.length} 个父提交
                      </dd>
                    </div>
                  )}
                  {detail.commit.parents.map((parent) => (
                    <div key={parent} className="flex gap-2">
                      <dt className="w-12 shrink-0">父提交</dt>
                      <dd className="min-w-0">
                        <button
                          type="button"
                          className="truncate font-mono text-fg-soft hover:text-fg-max hover:underline"
                          title={parent}
                          onClick={() => selectCommit(parent)}
                        >
                          {parent.slice(0, 8)}
                        </button>
                      </dd>
                    </div>
                  ))}
                </dl>
                {detail.commit.body && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words select-text text-[11px] leading-4 text-fg-muted">
                    {detail.commit.body}
                  </pre>
                )}
              </div>
              <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-fg-muted">
                <span>{detail.files.length} 个文件</span>
                <span className="text-git-added">+{detail.additions}</span>
                <span className="text-git-deleted">−{detail.deletions}</span>
              </div>
              <ul className="min-h-0 flex-1 overflow-auto">
                {detail.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-overlay"
                      title={`${file.path}\n点击查看这个文件在此提交中的差异`}
                      onClick={() => openCommitFile(file)}
                    >
                      <span
                        className="w-3 shrink-0 font-mono text-[10px]"
                        style={{ color: statusColor(file.status) }}
                      >
                        {statusLabel(file.status)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-fg-soft">
                        {file.path}
                      </span>
                      <span className="shrink-0 text-[10px] text-fg-dim">
                        {formatChangeCounts(file)}
                      </span>
                    </button>
                  </li>
                ))}
                {!detail.files.length && (
                  <li className="px-3 py-2 text-[11px] text-fg-dim">这个提交没有改动文件</li>
                )}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

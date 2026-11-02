import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowLeft,
  IconChevronDown,
  IconFileDiff,
  IconGitBranch,
  IconRefresh,
  IconX
} from '@tabler/icons-react'
import { FileSystemIcon } from './FileIcon'
import { statusColor, statusLabel } from './git-decorations'
import { lazyView } from './lazy-view'

// diff 视图静态依赖 monaco 本体：与文件页共用同一个懒加载入口，只有真的打开评审才下载。
const GitDiffEditor = lazyView(() => import('./GitDiffEditor'), 'GitDiffEditor')

/**
 * 分支评审：盖满整个窗口的一层，左边文件、右边 diff。
 *
 * 为什么不是「切到文件页再看 Git 比较」：那是**工作区**的界面——它带着文件树、当前目录、
 * 未提交改动，进去就要把页面根目录换成被评审的副本，等于让用户以为自己的会话换了项目。
 * 评审要的只是「这条分支相对主分支改了什么」，所以它是一层弹窗：关掉就回到原来的对话与
 * 目录，会话状态一个字节都不动。
 *
 * 数据只来自提交（`git:ref-summary`）：不读工作区，副本目录被系统清掉也不影响。
 */
export function ReviewView({ request, onClose }) {
  const cwd = request?.cwd || ''
  const [state, setState] = useState({ loading: true, repository: null, error: null })
  const [base, setBase] = useState(request?.base || '')
  const [refs, setRefs] = useState(null)
  const [selected, setSelected] = useState('')
  const requestId = useRef(0)

  // 换一个副本 = 换一份数据：基线与选中文件都回到初始值。
  useEffect(() => {
    setBase(request?.base || '')
    setSelected('')
  }, [cwd, request?.base, request?.head])

  const load = useCallback(
    async (nextBase) => {
      if (!cwd) return
      const id = ++requestId.current
      setState((current) => ({ ...current, loading: true, error: null }))
      const result = await window.mica.git
        .refSummary(cwd, {
          ...(nextBase ? { base: nextBase } : {}),
          ...(request?.head ? { head: request.head } : {})
        })
        .catch((error) => ({ repository: null, error: String(error?.message || error) }))
      if (id !== requestId.current) return
      const repository = result?.repository || null
      setState({ loading: false, repository, error: result?.error || null })
      setSelected((current) =>
        repository?.files?.some((file) => file.path === current)
          ? current
          : repository?.files?.[0]?.path || ''
      )
    },
    [cwd, request?.head]
  )

  useEffect(() => {
    void load(base)
  }, [load, base])

  // 基线候选：本地分支在前，远端分支其次；主分支由运行时解析（缺省时给的是实际生效的那条）。
  useEffect(() => {
    if (!cwd) return undefined
    let alive = true
    void window.mica.git
      .refs(cwd)
      .then((result) => {
        if (!alive) return
        // 值用完整 ref、显示用短名（`main` 而不是 `refs/heads/main`）：两边都不能猜，
        // `git rev-parse` 只认前者，人只认后者。
        const list = [...(result?.refs?.branches || []), ...(result?.refs?.tags || [])]
          .filter((item) => item?.ref)
          .map((item) => ({ ref: item.ref, label: item.name || item.ref }))
        setRefs(list)
      })
      .catch(() => alive && setRefs(null))
    return () => {
      alive = false
    }
  }, [cwd])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const repository = state.repository
  const files = useMemo(() => repository?.files || [], [repository])
  const current = useMemo(
    () => files.find((file) => file.path === selected) || null,
    [files, selected]
  )
  // 显示用短名（`main`），请求用完整 ref：`comparison` 回的是 baseLabel，别把
  // `refs/heads/main` 直接摆到界面上。
  const resolvedBase = repository?.baseLabel || base
  const headLabel = repository?.headLabel || request?.head || ''
  const title = request?.label || repository?.root?.split('/').pop() || '分支评审'

  return (
    <div className="review-overlay" role="dialog" aria-modal="true" aria-label="分支评审">
      <header className="review-header">
        <button type="button" className="review-back" onClick={onClose}>
          <IconArrowLeft size={14} />
          <span>返回对话</span>
        </button>
        <div className="review-title">
          <IconGitBranch size={14} />
          <span className="review-title-name">{title}</span>
          <span className="review-branch">{headLabel || 'HEAD'}</span>
          <span className="review-arrow">←</span>
          <span className="review-branch is-base">{resolvedBase || '主分支'}</span>
        </div>
        <div className="review-actions">
          <span className="review-counts">
            {repository
              ? `${files.length} 个文件 · +${repository.additions} −${repository.deletions}`
              : ''}
          </span>
          <button
            type="button"
            className="review-button"
            title="重新读取这条分支的改动"
            onClick={() => void load(base)}
            disabled={state.loading}
          >
            <IconRefresh size={14} />
          </button>
          <button type="button" className="review-button" title="关闭评审" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
      </header>
      <div className="review-body">
        <aside className="review-files">
          <div className="review-base-row">
            <span className="review-base-label">对比基线</span>
            <label className="review-select">
              <select
                value={base}
                onChange={(event) => setBase(event.target.value)}
                aria-label="选择对比基线"
              >
                <option value="">主分支（自动）</option>
                {(refs || []).map((item) => (
                  <option key={item.ref} value={item.ref}>
                    {item.label}
                  </option>
                ))}
              </select>
              <IconChevronDown size={12} />
            </label>
          </div>
          {state.error && <div className="review-error">{state.error}</div>}
          {!state.error && state.loading && <div className="review-empty">正在读取分支改动…</div>}
          {!state.error && !state.loading && files.length === 0 && (
            <div className="review-empty">这条分支相对 {resolvedBase || '主分支'} 没有改动</div>
          )}
          <ul className="review-file-list">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className={`review-file${file.path === selected ? ' is-selected' : ''}`}
                  onClick={() => setSelected(file.path)}
                  title={file.path}
                >
                  <FileSystemIcon name={file.path} className="size-3.5 shrink-0" />
                  <span className="review-file-name">{file.path}</span>
                  <span className={`review-file-status ${statusColor(file.status)}`}>
                    {statusLabel(file.status)}
                  </span>
                  <span className="review-file-count">
                    {file.binary ? '·' : `+${file.additions} −${file.deletions}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="review-diff">
          {current ? (
            <GitDiffEditor
              cwd={repository?.root || cwd}
              file={{
                path: current.path,
                status: current.status,
                binary: current.binary,
                fingerprint: current.fingerprint,
                base: {
                  mode: 'refs',
                  ref: repository.compareRef,
                  head: repository.headHash,
                  label: resolvedBase,
                  headLabel: headLabel
                }
              }}
              comparisonLabel={`${headLabel} · 相对 ${resolvedBase}`}
            />
          ) : (
            <div className="review-placeholder">
              <IconFileDiff size={22} />
              <span>{state.loading ? '正在读取…' : '从左侧选择文件查看改动'}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

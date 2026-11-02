import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconGitBranch } from '@tabler/icons-react'
import { FilesView } from './FilesView'
import { BranchPicker } from './BranchPicker'
import { CwdPicker } from './CwdPicker'
import { normalizeCwd } from './cwd-recents'
import { useIsMobile, useLatest } from './hooks'
import { useGitWorkspace } from './useGitWorkspace'

/** A page owns its browsing directory. Changing it never writes a chat/session directory. */
export const EditorWorkspace = forwardRef(function EditorWorkspace(
  {
    root = null,
    contextKey = null,
    visible = true,
    askText,
    recentCwds = [],
    // 「提交对提交」：给了 `head` 就只读提交，Git 面板变成 base...head 的对比。
    // 由页面地址的 `?base=&head=` 带进来（插件点一条 `项目 · 分支` 时打开的那种页面）。
    compare = null,
    onCompareBaseChange,
    onCornerResizeStart,
    onCwdChange,
    onGitChanged
  },
  ref
) {
  const [selection, setSelection] = useState(null)
  const cwd = selection?.contextKey === contextKey ? selection.path : root
  const current = useLatest({ contextKey, cwd, visible })
  const filesRef = useRef(null)
  const branchAnchorRef = useRef(null)
  const cwdAnchorRef = useRef(null)
  const selectionRequest = useRef(0)
  const [picker, setPicker] = useState(null)
  const [pathError, setPathError] = useState('')
  const [pathBusy, setPathBusy] = useState(false)
  const [localRecent, setLocalRecent] = useState([])
  const mobile = useIsMobile()
  const { git, compareBase, refresh, setCompareBase } = useGitWorkspace(cwd, {
    enabled: visible,
    compare
  })

  const setFilesRef = useCallback(
    (node) => {
      filesRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  const selectDirectory = useCallback(
    (path) => {
      const next = normalizeCwd(path)
      if (!next || next === current.current.cwd) return
      setSelection({ contextKey: current.current.contextKey, path: next })
      setLocalRecent((previous) => [next, ...previous.filter((item) => item !== next)].slice(0, 20))
    },
    [current]
  )

  useEffect(() => {
    onCwdChange?.(cwd || null)
  }, [cwd, onCwdChange])

  useEffect(() => {
    selectionRequest.current += 1
    setPicker(null)
    setPathError('')
    setPathBusy(false)
  }, [contextKey, cwd, visible])

  const recent = useMemo(() => {
    const paths = new Map()
    for (const path of [cwd, root, ...localRecent]) {
      if (path) paths.set(path, { path, usedAtMs: 0, sessionCount: 0 })
    }
    for (const entry of recentCwds) {
      if (!paths.has(entry.path)) paths.set(entry.path, entry)
    }
    return [...paths.values()]
  }, [cwd, root, localRecent, recentCwds])

  const closePicker = useCallback(() => {
    selectionRequest.current += 1
    setPicker(null)
    setPathBusy(false)
    setPathError('')
  }, [])

  const applyDirectory = useCallback(
    async (path) => {
      const next = normalizeCwd(path)
      if (!next) return
      const request = ++selectionRequest.current
      const source = current.current
      const isCurrent = () =>
        request === selectionRequest.current &&
        current.current.visible &&
        current.current.contextKey === source.contextKey &&
        current.current.cwd === source.cwd
      setPathBusy(true)
      setPathError('')
      try {
        const info = await window.mica.files.stat(next)
        if (!isCurrent()) return
        if (!info?.ok || info.kind !== 'directory') {
          throw new Error(info?.error || '请选择一个存在的文件夹')
        }
        selectDirectory(info.path || next)
        closePicker()
      } catch (error) {
        if (isCurrent()) setPathError(error?.message || String(error))
      } finally {
        if (request === selectionRequest.current) setPathBusy(false)
      }
    },
    [closePicker, current, selectDirectory]
  )

  const afterGitChange = useCallback(async () => {
    const target = current.current.cwd
    await filesRef.current?.reloadAfterGitChange(target)
    await refresh({ cwd: target, quiet: true })
    await onGitChanged?.()
  }, [current, onGitChanged, refresh])

  const branch = git.status?.branch
  const branchLabel = branch || (git.status?.root ? 'detached' : null)
  const openPathPicker = () => {
    setPathError('')
    setPicker('cwd')
  }

  return (
    <div className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}>
      <FilesView
        ref={setFilesRef}
        root={cwd || null}
        visible={visible}
        askText={askText}
        onRootChange={selectDirectory}
        onCornerResizeStart={onCornerResizeStart}
        gitCwd={git.cwd || cwd}
        gitRepository={git.repository}
        gitBranchChanges={git.branch}
        gitLoading={git.loading}
        gitBranch={branch || null}
        gitCompareBase={compareBase}
        gitCompareError={git.compareError}
        gitCompareHead={compare?.head || null}
        onGitCompareBaseChange={compare?.head ? onCompareBaseChange : setCompareBase}
        onRefreshGit={() => refresh({ quiet: true })}
      />
      <footer className="safe-bottom no-drag flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line-soft bg-shade px-3 text-xs text-fg-soft">
        {branchLabel && (
          <button
            ref={branchAnchorRef}
            type="button"
            className={`-ml-1.5 flex h-full items-center gap-1.5 rounded-sm px-1.5 text-left hover:bg-overlay-strong hover:text-fg-max ${
              cwd ? 'max-w-[45%] shrink-0' : 'min-w-0'
            }`}
            title="切换分支…"
            aria-label="切换编辑器分支"
            aria-haspopup="dialog"
            aria-expanded={picker === 'branch'}
            onClick={() => setPicker('branch')}
          >
            <IconGitBranch size={13} className="shrink-0" />
            <span className="truncate">{branchLabel}</span>
          </button>
        )}
        <button
          ref={cwdAnchorRef}
          type="button"
          className={`ml-auto min-w-0 truncate rounded-sm px-1.5 py-0.5 text-right hover:bg-overlay ${
            cwd ? 'text-fg-dim hover:text-fg-strong' : 'text-fg-faint'
          }`}
          title={cwd ? `${cwd}\n切换目录…` : '选择编辑器目录…'}
          aria-label="切换编辑器目录"
          aria-haspopup="dialog"
          aria-expanded={picker === 'cwd'}
          onClick={openPathPicker}
        >
          {cwd || '选择目录…'}
        </button>
      </footer>
      {visible && picker === 'branch' && cwd && (
        <BranchPicker
          cwd={cwd}
          askText={askText}
          anchorRef={mobile ? null : branchAnchorRef}
          canOperate={() =>
            filesRef.current?.hasDirty() ? '有未保存的文件，先保存或关闭后再切换分支。' : ''
          }
          onChanged={afterGitChange}
          onClose={closePicker}
        />
      )}
      {visible && picker === 'cwd' && (
        <CwdPicker
          cwd={cwd || ''}
          recent={recent}
          anchorRef={mobile ? null : cwdAnchorRef}
          ariaLabel="切换编辑器目录"
          error={pathError}
          busy={pathBusy}
          onApply={applyDirectory}
          onClose={closePicker}
        />
      )}
    </div>
  )
})

import { IconArrowLeft, IconCheck, IconFileDiff, IconX } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { FileIcon } from './FileIcon'
import { isFileReviewed } from './git-review'
import { fileName } from './monaco'

export function GitReviewTabs({
  tabs,
  activePath,
  reviewed,
  onActivate,
  onClose,
  onBack,
  onPin,
  mobile
}) {
  const stripRef = useRef(null)
  const counts = new Map()
  for (const tab of tabs) counts.set(fileName(tab.path), (counts.get(fileName(tab.path)) || 0) + 1)
  useEffect(() => {
    stripRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath])
  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="打开的比较"
      className="flex h-8 shrink-0 overflow-x-auto bg-tabstrip"
    >
      {mobile && (
        <button
          type="button"
          title="返回变更列表"
          aria-label="返回变更列表"
          className="sticky left-0 z-10 grid w-9 shrink-0 place-items-center bg-tabstrip text-fg"
          onClick={onBack}
        >
          <IconArrowLeft size={15} />
        </button>
      )}
      {tabs.map((tab, index) => (
        <div
          key={tab.path}
          title={tab.path}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault()
              onClose(tab.path)
            }
          }}
          className={`group flex h-8 min-w-32 max-w-60 shrink-0 items-center gap-2 border-r border-line px-2.5 text-[12px] ${tab.path === activePath ? 'bg-canvas text-fg' : 'text-fg-muted hover:bg-panel-hi'}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.path === activePath}
            tabIndex={tab.path === activePath ? 0 : -1}
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => onActivate(tab.path)}
            onDoubleClick={() => onPin?.(tab.path)}
            onKeyDown={(event) => {
              let next
              if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
              else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = tabs.length - 1
              else if (event.key === 'Delete') {
                event.preventDefault()
                onClose(tab.path)
                return
              } else return
              event.preventDefault()
              onActivate(tabs[next].path)
              event.currentTarget
                .closest('[role="tablist"]')
                .querySelectorAll('[role="tab"]')
                [next]?.focus()
            }}
          >
            <FileIcon name={fileName(tab.path)} className="size-4 shrink-0" />
            <span className={`truncate ${tab.preview ? 'italic' : ''}`}>{fileName(tab.path)}</span>
            {counts.get(fileName(tab.path)) > 1 && (
              <span className="min-w-0 truncate text-[10px] text-fg-faint">
                {tab.path.includes('/') ? tab.path.slice(0, tab.path.lastIndexOf('/')) : '.'}
              </span>
            )}
            {isFileReviewed(tab, reviewed) && (
              <IconCheck size={12} className="shrink-0 text-git-added" />
            )}
          </button>
          <button
            type="button"
            title={`关闭比较 ${fileName(tab.path)}`}
            aria-label={`关闭比较 ${fileName(tab.path)}`}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-panel-hi hover:text-fg"
            onClick={() => onClose(tab.path)}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function GitCompareWelcome({ repository, branch, reviewed, onOpen, loading }) {
  const files = repository?.files || []
  const remaining = files.filter((file) => !isFileReviewed(file, reviewed))
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      <div className="max-w-sm text-center text-[13px] text-fg-muted">
        <IconFileDiff size={42} stroke={1} className="mx-auto mb-4 text-fg-faint" />
        <div className="mb-2 text-[16px] text-fg">
          {files.length ? '查看分支上的每一处更改' : loading ? '正在读取比较…' : 'Git 比较'}
        </div>
        <p className="break-all">
          {repository
            ? `${branch || 'HEAD'} · 相对 ${repository.baseLabel || 'HEAD'}`
            : '从左侧选择比较基线，查看当前工作区的完整差异。'}
        </p>
        {!!files.length && (
          <>
            <p className="mt-3">
              {files.length} 个文件 · {files.length - remaining.length} 个已阅
            </p>
            <button
              type="button"
              className="mt-4 rounded-sm border border-line-strong bg-panel px-4 py-1.5 text-fg hover:bg-panel-hi"
              onClick={() => onOpen(remaining[0] || files[0])}
            >
              {remaining.length ? '查看下一项未阅更改' : '重新查看更改'}
            </button>
            <p className="mt-4 text-[11px]">↑ ↓ 选择文件 · Enter 打开差异 · 空格标记已阅</p>
          </>
        )}
      </div>
    </div>
  )
}

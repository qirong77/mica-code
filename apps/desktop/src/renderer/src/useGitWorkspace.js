import { useCallback, useEffect, useRef, useState } from 'react'
import { setUiStateEntries, useUiStateValue } from './ui-state'
import { useLatest } from './hooks'

/**
 * 一个工作目录的 Git 数据：仓库摘要、分支对比、分支状态。
 *
 * 主应用那份（`App.jsx` 的 refreshGit）还要解析活跃会话的 cwd、跟着 PTY 的 shell 走，所以
 * 留在原地；独立文件窗口只有一个固定目录（地址里的 `?cwd=`），用这份就够了。两边读同一批
 * host 能力（`git:summary` / `git:branch-summary` / `git:status`）与同一张比较基线表
 * （界面状态的 `gitCompareBase`），所以看到的仓库、基线与主窗口一致。
 */

const EMPTY_COMPARE_BASES = {}
/** 与主应用文件视图的轮询节奏一致：3 秒一次，只在可见且有焦点时跑。 */
const POLL_MS = 3000

const EMPTY_GIT = {
  cwd: null,
  repository: null,
  branch: null,
  status: null,
  compareError: null,
  loading: false
}

export function useGitWorkspace(cwd) {
  const compareBases = useUiStateValue('gitCompareBase', EMPTY_COMPARE_BASES)
  const compareBasesRef = useLatest(compareBases)
  const cwdRef = useLatest(cwd)
  const requestRef = useRef(0)
  const pollBusyRef = useRef(false)
  const [git, setGit] = useState(EMPTY_GIT)
  const gitRef = useLatest(git)

  const refresh = useCallback(
    async ({ quiet = false, cwd: requested = null } = {}) => {
      const target = requested || cwdRef.current
      const request = ++requestRef.current
      if (!target) {
        setGit(EMPTY_GIT)
        return
      }
      if (!quiet) setGit({ ...gitRef.current, cwd: target, loading: true })
      try {
        const summary = await window.mica.git.summary(target)
        const root = summary?.repository?.root || target
        const chosen = compareBasesRef.current[root] || compareBasesRef.current[target]
        const [branch, status] = await Promise.all([
          window.mica.git.branchSummary(
            target,
            chosen ? { base: chosen.ref || null, direct: !!chosen.direct } : undefined
          ),
          window.mica.git.status(target)
        ])
        if (request !== requestRef.current) return
        setGit({
          cwd: target,
          repository: summary?.repository || null,
          branch: branch?.repository || null,
          compareError: branch?.error || null,
          status: status?.status || null,
          loading: false
        })
      } catch (error) {
        if (request !== requestRef.current) return
        console.error('refresh git failed', error)
        setGit({ ...EMPTY_GIT, cwd: target })
      }
    },
    [compareBasesRef, cwdRef, gitRef]
  )

  /** 比较基线按仓库根存进界面状态：主窗口、别的窗口、刷新之后读到的都是同一条。 */
  const setCompareBase = useCallback(
    (value) => {
      const root = gitRef.current.repository?.root || gitRef.current.cwd || cwdRef.current
      if (!root) return
      setUiStateEntries('gitCompareBase', {
        [root]: value
          ? {
              kind: value.kind,
              ref: value.ref || null,
              name: value.name || '',
              direct: !!value.direct
            }
          : null
      })
      setGit({ ...gitRef.current, branch: null, compareError: null, loading: true })
    },
    [cwdRef, gitRef]
  )

  const root = git.repository?.root
  const compareBase = cwd
    ? compareBases[root] || compareBases[git.cwd] || compareBases[cwd] || null
    : null

  useEffect(() => {
    void refresh({ cwd: cwd || null })
  }, [cwd, refresh])

  useEffect(() => {
    const poll = async () => {
      if (pollBusyRef.current) return
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      pollBusyRef.current = true
      try {
        await refresh({ quiet: true })
      } finally {
        pollBusyRef.current = false
      }
    }
    const timer = window.setInterval(poll, POLL_MS)
    // 后台页签会被浏览器节流，窗口重新可见/获得焦点时补一次，否则一进来看到的是旧数据。
    const refreshNow = () => void refresh({ quiet: true })
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshNow()
    }
    window.addEventListener('focus', refreshNow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshNow)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  return { git, compareBase, refresh, setCompareBase }
}

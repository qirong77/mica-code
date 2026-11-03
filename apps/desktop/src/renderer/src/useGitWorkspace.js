import { useCallback, useEffect, useRef, useState } from 'react'
import { setUiStateEntries, uiStateKeys, useUiStateValue } from './ui-state'
import { useLatest } from './hooks'

/**
 * Git data for an editor page's own directory. Comparison preferences are shared by repository,
 * while the directory and request lifecycle belong to this page, independently of its session.
 */
const EMPTY_COMPARE_BASES = {}
const readCompareBases = () => uiStateKeys().gitCompareBase || EMPTY_COMPARE_BASES
const POLL_MS = 3000

const EMPTY_GIT = {
  cwd: null,
  repository: null,
  branch: null,
  status: null,
  compareError: null,
  // 这一份数据是不是「提交对提交」读出来的：为真时页面上不该出现「工作区」这类字样。
  review: false,
  loading: false
}

export function useGitWorkspace(cwd, { enabled = true, compare = null } = {}) {
  const compareBases = useUiStateValue('gitCompareBase', EMPTY_COMPARE_BASES)
  const cwdRef = useLatest(cwd)
  const enabledRef = useLatest(enabled)
  // 评审模式：`head` 非空就只读提交（`ref-summary`），工作区一概不参与。
  const compareRef = useLatest(compare)
  const requestRef = useRef(0)
  const inFlightRef = useRef(0)
  const [git, setGit] = useState(EMPTY_GIT)
  const gitRef = useLatest(git)

  const refresh = useCallback(
    async ({ quiet = false, cwd: requested = null, refresh: force = false } = {}) => {
      const target = requested || cwdRef.current || null
      if (!enabledRef.current || target !== (cwdRef.current || null)) return
      const request = ++requestRef.current
      const bases = readCompareBases()
      const isCurrent = () =>
        enabledRef.current &&
        request === requestRef.current &&
        target === (cwdRef.current || null) &&
        bases === readCompareBases()
      if (!target) {
        setGit(EMPTY_GIT)
        return
      }
      setGit((current) =>
        current.cwd !== target
          ? { ...EMPTY_GIT, cwd: target, loading: true }
          : quiet
            ? current
            : { ...current, loading: true }
      )
      inFlightRef.current += 1
      try {
        const summary = await window.mica.git.summary(target, { refresh: force })
        if (!isCurrent()) return
        const root = summary?.repository?.root || target
        const chosen = bases[root] || bases[target]
        const review = compareRef.current?.head ? compareRef.current : null
        // Keep the polling guard until both reads finish, even if either one rejects.
        // 评审模式不抓 status：两边都在提交里，未提交改动与「当前检出哪条分支」都不相关。
        const results = await Promise.allSettled([
          review
            ? window.mica.git.refSummary(target, {
                ...(review.base ? { base: review.base } : {}),
                head: review.head
              })
            : window.mica.git.branchSummary(
                target,
                chosen ? { base: chosen.ref || null, direct: !!chosen.direct } : undefined
              ),
          review ? Promise.resolve({ status: null }) : window.mica.git.status(target)
        ])
        if (!isCurrent()) return
        const failed = results.find((result) => result.status === 'rejected')
        if (failed) throw failed.reason
        const [branch, status] = results.map((result) => result.value)
        setGit({
          cwd: target,
          repository: summary?.repository || null,
          branch: branch?.repository || null,
          compareError: branch?.error || null,
          status: status?.status || null,
          review: !!review,
          loading: false
        })
      } catch (error) {
        if (!isCurrent()) return
        console.error('refresh git failed', error)
        setGit({ ...EMPTY_GIT, cwd: target })
      } finally {
        inFlightRef.current -= 1
      }
    },
    [cwdRef, enabledRef, compareRef]
  )

  const setCompareBase = useCallback(
    (value) => {
      const target = cwdRef.current || null
      if (!target) return
      const current = gitRef.current
      const root = (current.cwd === target && current.repository?.root) || target
      const before = readCompareBases()
      setUiStateEntries('gitCompareBase', {
        [root]: value
          ? {
              kind: value.kind,
              ref: value.ref || null,
              name: value.name || '',
              direct: !!value.direct
            }
          : null,
        ...(root !== target ? { [target]: null } : {})
      })
      if (before === readCompareBases()) return
      // The table changes synchronously, invalidating reads before React runs the effect.
      setGit((previous) => ({
        ...(previous.cwd === target ? previous : EMPTY_GIT),
        cwd: target,
        branch: null,
        compareError: null,
        loading: true
      }))
    },
    [cwdRef, gitRef]
  )

  const activeGit =
    git.cwd === (cwd || null) ? git : { ...EMPTY_GIT, cwd: cwd || null, loading: !!cwd }
  const root = activeGit.repository?.root
  const compareBase = cwd ? (root && compareBases[root]) || compareBases[cwd] || null : null

  useEffect(() => {
    if (enabled) void refresh({ cwd: cwd || null })
    return () => {
      requestRef.current += 1
    }
  }, [cwd, compareBases, enabled, refresh, compare?.base, compare?.head])

  useEffect(() => {
    if (!enabled) return undefined
    const poll = async () => {
      // 评审模式读的是提交：除非换基线，内容不会自己变，不必轮询。
      if (compareRef.current?.head) return
      if (inFlightRef.current) return
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      await refresh({ quiet: true })
    }
    const timer = window.setInterval(poll, POLL_MS)
    const refreshNow = () => void poll()
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
  }, [enabled, refresh, compareRef])

  return { git: activeGit, compareBase, refresh, setCompareBase }
}

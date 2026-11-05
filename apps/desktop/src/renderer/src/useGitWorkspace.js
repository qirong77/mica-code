import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setUiStateEntries, uiStateKeys, useUiStateValue } from './ui-state'
import { useLatest } from './hooks'

/**
 * Git data for an editor page's own directory. Comparison preferences are shared by repository,
 * while the directory and request lifecycle belong to this page, independently of its session.
 *
 * 比较的两头都按仓库记住：`gitCompareBase` 是目标分支（合入的去处），`gitCompareHead` 是当前
 * 分支（我在开发的一侧），后者缺省为工作区。换掉当前分支只是把这一页切成「提交对提交」，不碰会话。
 */
const EMPTY_COMPARE_BASES = {}
const readCompareBases = () => uiStateKeys().gitCompareBase || EMPTY_COMPARE_BASES
const readCompareHeads = () => uiStateKeys().gitCompareHead || EMPTY_COMPARE_BASES
const POLL_MS = 3000
/** 宿主把 `.git` 的变化推过来，几个写操作挨在一起（checkout 会改 HEAD + index）合并一次。 */
const CHANGE_DEBOUNCE_MS = 100

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
  const compareHeads = useUiStateValue('gitCompareHead', EMPTY_COMPARE_BASES)
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
      const heads = readCompareHeads()
      const isCurrent = () =>
        enabledRef.current &&
        request === requestRef.current &&
        target === (cwdRef.current || null) &&
        bases === readCompareBases() &&
        heads === readCompareHeads()
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
        const chosenHead = heads[root] || heads[target]
        // 页面地址带来的那份对比优先：这一页打开时就是它（插件的评审入口）。
        const review = compareRef.current?.head
          ? { base: compareRef.current.base || null, head: compareRef.current.head }
          : chosenHead?.ref
            ? { base: chosen?.ref || null, head: chosenHead.ref }
            : null
        // Keep the polling guard until both reads finish, even if either one rejects.
        // 评审模式不抓 status：两边都在提交里，未提交改动与「当前检出哪条分支」都不相关。
        // 只有页面地址带来的评审窗口才省掉它——那一页的目录可能是别处的副本，甚至已经不在了；
        // 本页自己选的当前分支仍要读 status，否则底部那条「当前分支」会凭空消失。
        const results = await Promise.allSettled([
          review
            ? window.mica.git.refSummary(target, {
                ...(review.base ? { base: review.base } : {}),
                head: review.head
              })
            : window.mica.git.branchSummary(
                target,
                chosen ? { base: chosen.ref || null } : undefined
              ),
          compareRef.current?.head
            ? Promise.resolve({ status: null })
            : window.mica.git.status(target)
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
              name: value.name || ''
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

  // 当前分支：`null`（或选择器里的「工作区」）就是把这一侧放回工作区。
  const setCompareHead = useCallback(
    (value) => {
      const target = cwdRef.current || null
      if (!target) return
      const current = gitRef.current
      const root = (current.cwd === target && current.repository?.root) || target
      const before = readCompareHeads()
      setUiStateEntries('gitCompareHead', {
        [root]:
          value && value.kind !== 'worktree' && (value.ref || value.name)
            ? { kind: value.kind, ref: value.ref || null, name: value.name || '' }
            : null,
        ...(root !== target ? { [target]: null } : {})
      })
      if (before === readCompareHeads()) return
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
  // 评审那一份对比的基线由发起方（插件的 `openReview`）定，不读按仓库记下的那格——
  // 否则面板上的「目标分支」会显示上一份对比的基线，与真正发出去的 `refSummary` 对不上。
  const reviewCompareBase = useMemo(
    () =>
      compare?.head
        ? { kind: 'branch', ref: compare.base || null, name: compare.base || '' }
        : null,
    [compare?.head, compare?.base]
  )
  const compareBase = cwd
    ? reviewCompareBase || (root && compareBases[root]) || compareBases[cwd] || null
    : null
  // 当前分支固定成同一个对象：`FilesView` 靠它的身份认「这是不是另一份对比」。
  const urlCompareHead = useMemo(
    () => (compare?.head ? { kind: 'branch', ref: compare.head, name: compare.head } : null),
    [compare?.head]
  )
  const compareHead = useMemo(
    () =>
      cwd ? urlCompareHead || (root && compareHeads[root]) || compareHeads[cwd] || null : null,
    [cwd, urlCompareHead, root, compareHeads]
  )

  useEffect(() => {
    if (enabled) void refresh({ cwd: cwd || null })
    return () => {
      requestRef.current += 1
    }
  }, [cwd, compareBases, compareHeads, enabled, refresh, compare?.base, compare?.head])

  useEffect(() => {
    if (!enabled) return undefined
    // 宿主侧的仓库监听（`host/git-watch.js`）：页面在看哪个目录就订阅哪个，
    // 隐藏/离开时撤销。不是仓库时宿主回 `{ root: null }`，什么都不做。
    void window.mica.git.watch?.(cwd || null)?.catch?.(() => {})
    return () => {
      void window.mica.git.unwatch?.(cwd || null)?.catch?.(() => {})
    }
  }, [cwd, enabled])

  useEffect(() => {
    if (!enabled) return undefined
    let timer = null
    const off = window.mica.git.onChanged?.((payload) => {
      if (!enabledRef.current || !cwdRef.current) return
      // 事件带的是仓库根：已经知道自己的根时，别的仓库的变化与自己无关。
      const known = gitRef.current.repository?.root
      if (known && payload?.root && payload.root !== known) return
      if (timer) return
      timer = window.setTimeout(() => {
        timer = null
        // 缓存已经在宿主侧被这次事件失效，这里走缓存也读得到新内容。
        void refresh({ quiet: true })
      }, CHANGE_DEBOUNCE_MS)
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      off?.()
    }
  }, [enabled, refresh, cwdRef, enabledRef, gitRef])

  useEffect(() => {
    if (!enabled) return undefined
    const poll = async () => {
      // 评审模式读的是提交：除非换分支，内容不会自己变，不必轮询。
      if (compareRef.current?.head) return
      const heads = readCompareHeads()
      const active = gitRef.current
      if (heads[active.repository?.root] || heads[active.cwd] || heads[cwdRef.current]) return
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
  }, [enabled, refresh, compareRef, cwdRef, gitRef])

  return { git: activeGit, compareBase, compareHead, refresh, setCompareBase, setCompareHead }
}

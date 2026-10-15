import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  closeReviewTab,
  openReviewTabs,
  reconcileReviewTabs,
  reviewScope,
  updateReviewed
} from './git-review'
import { setUiStateEntries, uiStateKeys, useUiStateValue } from './ui-state'

const EMPTY = {}
const NO_FILES = []

/** Comparison tabs and review state are independent of the source-control editor. */
export function useGitReview({ cwd, repository, compareBase }) {
  const root = repository?.root || cwd
  const scope = reviewScope(root, compareBase)
  const reviews = useUiStateValue('gitCompareReviewed', EMPTY)
  const reviewed = reviews[scope] || EMPTY
  const [stored, setStored] = useState({ scope, tabs: [], active: null })
  const base = useMemo(
    () => ({
      mode: 'snapshot',
      ref: repository?.compareRef,
      label: repository?.baseLabel || 'HEAD'
    }),
    [repository?.compareRef, repository?.baseLabel]
  )
  const files = repository?.files || NO_FILES
  const state = useMemo(() => {
    if (stored.scope !== scope) return { scope, tabs: [], active: null }
    if (!repository) return stored
    const tabs = reconcileReviewTabs(stored.tabs, files, base)
    const active = tabs.some((tab) => tab.path === stored.active)
      ? stored.active
      : tabs[0]?.path || null
    return tabs === stored.tabs && active === stored.active ? stored : { scope, tabs, active }
  }, [stored, scope, repository, files, base])
  useEffect(() => {
    if (state !== stored) setStored((current) => (current === stored ? state : current))
  }, [state, stored])

  const open = useCallback(
    (selected, pin = false) => {
      setStored((current) => {
        const previous = current.scope === scope ? current : { scope, tabs: [], active: null }
        const tabs = reconcileReviewTabs(previous.tabs, files, base)
        return openReviewTabs({ ...previous, tabs }, selected, base, pin)
      })
    },
    [scope, files, base]
  )

  const close = useCallback(
    (path) => setStored({ scope, ...closeReviewTab(state, path) }),
    [scope, state]
  )
  const activate = useCallback((path) => setStored({ ...state, active: path }), [state])
  const toggleReviewed = useCallback(
    (batch, checked) => {
      const current = uiStateKeys().gitCompareReviewed || EMPTY
      setUiStateEntries('gitCompareReviewed', {
        [scope]: updateReviewed(current[scope], batch, checked)
      })
    },
    [scope]
  )
  const current = state.tabs.find((tab) => tab.path === state.active) || null
  const index = files.findIndex((file) => file.path === current?.path)
  const previous = index > 0 ? files[index - 1] : null
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : null
  return {
    scope,
    tabs: state.tabs,
    current,
    reviewed,
    open,
    close,
    activate,
    toggleReviewed,
    previous,
    next
  }
}

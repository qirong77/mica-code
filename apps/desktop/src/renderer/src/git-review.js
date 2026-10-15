/** A review belongs to a comparison and to the exact content that was read. */
export function reviewScope(root, base) {
  return JSON.stringify([root || '', base?.ref || 'auto', !!base?.direct])
}

export function isFileReviewed(file, reviewed) {
  return !!file?.fingerprint && reviewed?.[file.path] === file.fingerprint
}

export function updateReviewed(reviewed, files, checked) {
  const next = { ...reviewed }
  for (const file of files) {
    if (checked && file.fingerprint) next[file.path] = file.fingerprint
    else delete next[file.path]
  }
  return next
}

/** Keep opened comparisons in sync without reloading Monaco on every poll. */
export function reconcileReviewTabs(tabs, files, base) {
  const byPath = new Map(files.map((file) => [file.path, file]))
  let changed = false
  const next = []
  for (const tab of tabs) {
    const file = byPath.get(tab.path)
    if (!file) {
      changed = true
      continue
    }
    if (
      file.fingerprint === tab.fingerprint &&
      file.status === tab.status &&
      file.binary === tab.binary &&
      JSON.stringify(tab.base) === JSON.stringify(base)
    )
      next.push(tab)
    else {
      changed = true
      next.push({ ...file, base, preview: tab.preview })
    }
  }
  return changed ? next : tabs
}

/** Single-click reuses a preview; double-click and batch open keep tabs. */
export function openReviewTabs(state, selected, base, pin = false) {
  const files = Array.isArray(selected) ? selected : [selected]
  const fixed = pin || Array.isArray(selected)
  let tabs = [...state.tabs]
  for (const file of files) {
    if (!file?.path) continue
    const existing = tabs.findIndex((tab) => tab.path === file.path)
    if (existing >= 0) {
      if (fixed && tabs[existing].preview) tabs[existing] = { ...tabs[existing], preview: false }
      continue
    }
    if (!fixed) tabs = tabs.filter((tab) => !tab.preview)
    tabs.push({ ...file, base, preview: !fixed })
  }
  return { ...state, tabs, active: files[0]?.path || state.active }
}

export function closeReviewTab(state, path) {
  const index = state.tabs.findIndex((tab) => tab.path === path)
  const tabs = state.tabs.filter((tab) => tab.path !== path)
  return {
    tabs,
    active:
      state.active === path ? tabs[Math.min(index, tabs.length - 1)]?.path || null : state.active
  }
}

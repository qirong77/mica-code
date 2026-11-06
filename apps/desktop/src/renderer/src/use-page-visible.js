import { useSyncExternalStore } from 'react'

function subscribe(listener) {
  document.addEventListener('visibilitychange', listener)
  window.addEventListener('focus', listener)
  window.addEventListener('blur', listener)
  return () => {
    document.removeEventListener('visibilitychange', listener)
    window.removeEventListener('focus', listener)
    window.removeEventListener('blur', listener)
  }
}

function snapshot() {
  return document.visibilityState !== 'hidden'
}

export function pageIsActive(doc = document) {
  return doc.visibilityState !== 'hidden' && doc.hasFocus()
}

function activeSnapshot() {
  return pageIsActive()
}

/** A cached view can be selected while its entire browser/Electron window is hidden. */
export function usePageVisible(visible = true, requireFocus = false) {
  const pageVisible = useSyncExternalStore(subscribe, requireFocus ? activeSnapshot : snapshot, () => true)
  return visible && pageVisible
}

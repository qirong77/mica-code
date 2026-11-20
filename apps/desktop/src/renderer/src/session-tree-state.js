import { sessionFilterMode } from './session-filter'
import { DEFAULT_SESSION_SEARCH_RANGE, sessionSearchRange } from './session-search'

export const SESSION_TREE_UI_STATE_KEY = 'sessionTreeSearch'
export const SESSION_TREE_FILTER_PREVIEW_LIMIT = 30

export const DEFAULT_SESSION_TREE_UI_STATE = Object.freeze({
  query: '',
  rangeId: DEFAULT_SESSION_SEARCH_RANGE,
  filterOpen: false,
  filterMode: 'all',
  recentLimit: 6,
  filterLimit: SESSION_TREE_FILTER_PREVIEW_LIMIT
})

function positiveLimit(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

/**
 * 界面状态文件可能来自旧版本或用户手动编辑：搜索恢复时只接受已知档位和正整数分页，
 * 否则一个坏值就会让侧栏无法渲染。
 */
export function normalizeSessionTreeUiState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    query: typeof source.query === 'string' ? source.query : DEFAULT_SESSION_TREE_UI_STATE.query,
    rangeId: sessionSearchRange(source.rangeId).id,
    filterOpen: source.filterOpen === true,
    filterMode: sessionFilterMode(source.filterMode).id,
    recentLimit: positiveLimit(source.recentLimit, DEFAULT_SESSION_TREE_UI_STATE.recentLimit),
    filterLimit: positiveLimit(source.filterLimit, DEFAULT_SESSION_TREE_UI_STATE.filterLimit)
  }
}

export function updateSessionTreeUiState(current, patch) {
  const base = normalizeSessionTreeUiState(current)
  const next = typeof patch === 'function' ? patch(base) : patch
  return normalizeSessionTreeUiState({ ...base, ...(next || {}) })
}

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_SESSION_TREE_UI_STATE,
  normalizeSessionTreeUiState,
  updateSessionTreeUiState
} from './session-tree-state'

describe('session tree ui state', () => {
  it('uses stable defaults for missing or invalid persisted values', () => {
    expect(normalizeSessionTreeUiState(null)).toEqual(DEFAULT_SESSION_TREE_UI_STATE)
    expect(
      normalizeSessionTreeUiState({
        query: 42,
        rangeId: 'unknown',
        filterOpen: 'yes',
        filterMode: 'unknown',
        recentLimit: -1,
        filterLimit: 'not-a-number'
      })
    ).toEqual(DEFAULT_SESSION_TREE_UI_STATE)
  })

  it('keeps the user search and filter choices across updates', () => {
    const state = updateSessionTreeUiState(DEFAULT_SESSION_TREE_UI_STATE, {
      query: '编辑器',
      rangeId: '30d',
      filterOpen: true,
      filterMode: '12h',
      recentLimit: 16,
      filterLimit: 60
    })

    expect(state).toEqual({
      query: '编辑器',
      rangeId: '30d',
      filterOpen: true,
      filterMode: '12h',
      recentLimit: 16,
      filterLimit: 60
    })
  })

  it('supports functional updates without dropping another persisted field', () => {
    const state = updateSessionTreeUiState(
      { ...DEFAULT_SESSION_TREE_UI_STATE, query: 'mica', rangeId: '7d' },
      (current) => ({ filterLimit: current.filterLimit + 30 })
    )

    expect(state).toMatchObject({ query: 'mica', rangeId: '7d', filterLimit: 60 })
  })
})

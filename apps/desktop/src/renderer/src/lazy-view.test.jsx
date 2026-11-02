import { describe, expect, it } from 'bun:test'
import { forwardRef, memo } from 'react'
import { loadView } from './lazy-view'

describe('loadView', () => {
  it('loads function, memo and forwardRef components', async () => {
    const Component = () => null
    for (const View of [Component, memo(Component), forwardRef(Component)]) {
      expect(await loadView(async () => ({ View }), 'View')).toEqual({ default: View })
    }
  })

  it('reports missing exports with the view name instead of resolving undefined', async () => {
    await expect(loadView(async () => ({ Other: () => null }), 'FilesView')).rejects.toThrow(
      '无法加载视图 FilesView：模块未提供有效组件（导出：Other）'
    )
  })

  it('rejects absent modules and non-component exports', async () => {
    for (const module of [undefined, null, { View: {} }, { View: 'invalid' }]) {
      await expect(loadView(async () => module, 'View')).rejects.toThrow('无法加载视图 View')
    }
  })

  it('preserves import failures for diagnosis and allows another load attempt', async () => {
    const failure = new Error('Failed to fetch dynamically imported module')
    let attempts = 0
    const View = () => null
    const loader = async () => {
      if (++attempts === 1) throw failure
      return { View }
    }
    await expect(loadView(loader, 'View')).rejects.toBe(failure)
    expect(await loadView(loader, 'View')).toEqual({ default: View })
  })
})

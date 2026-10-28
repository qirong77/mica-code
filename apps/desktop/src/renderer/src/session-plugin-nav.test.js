import { describe, expect, test } from 'bun:test'
import { countPluginOverrides, pickActivePlugin } from './sessionPluginNav'

const plugin = (id, overrides = {}) => ({ id, name: id, overrides })

describe('pickActivePlugin', () => {
  const plugins = [plugin('auto-compact'), plugin('memory')]

  test('选中的插件还在就继续用', () => {
    expect(pickActivePlugin(plugins, 'memory').id).toBe('memory')
  })

  test('选中的插件不在了回到第一个，不留在空页签上', () => {
    expect(pickActivePlugin(plugins, 'removed').id).toBe('auto-compact')
    expect(pickActivePlugin(plugins, '').id).toBe('auto-compact')
  })

  test('还没加载时什么都不选', () => {
    expect(pickActivePlugin(null, 'memory')).toBeNull()
    expect(pickActivePlugin([], 'memory')).toBeNull()
  })
})

describe('countPluginOverrides', () => {
  test('数出本会话改过的项', () => {
    expect(countPluginOverrides(plugin('a', { quickLimit: '10', modelLimit: '5' }))).toBe(2)
  })

  test('没改过、字段缺失或形状不对都算 0', () => {
    expect(countPluginOverrides(plugin('a'))).toBe(0)
    expect(countPluginOverrides(plugin('a', {}))).toBe(0)
    expect(countPluginOverrides({ id: 'a', overrides: null })).toBe(0)
    expect(countPluginOverrides(null)).toBe(0)
  })
})

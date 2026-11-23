import { describe, expect, it } from 'vitest'
import { planActivityBarClick } from './editor-activity-bar'

describe('planActivityBarClick', () => {
  it('点另一个图标切到那个面板，侧栏保持展开', () => {
    expect(
      planActivityBarClick({ panel: 'search', activePanel: 'explorer', collapsed: false })
    ).toEqual({ panel: 'search', collapsed: false })
  })

  it('再点当前项收起侧栏，面板不变', () => {
    expect(
      planActivityBarClick({ panel: 'explorer', activePanel: 'explorer', collapsed: false })
    ).toEqual({ panel: 'explorer', collapsed: true })
    expect(planActivityBarClick({ panel: 'git', activePanel: 'git', collapsed: false })).toEqual({
      panel: 'git',
      collapsed: true
    })
  })

  it('侧栏收着时点同一个图标把它放回来', () => {
    expect(planActivityBarClick({ panel: 'git', activePanel: 'git', collapsed: true })).toEqual({
      panel: 'git',
      collapsed: false
    })
  })

  it('侧栏收着时点另一个图标放回来并切到那一项', () => {
    expect(
      planActivityBarClick({ panel: 'search', activePanel: 'explorer', collapsed: true })
    ).toEqual({ panel: 'search', collapsed: false })
  })

  it('收起 Git 图谱等于关掉整页，回到资源管理器', () => {
    expect(
      planActivityBarClick({ panel: 'git-graph', activePanel: 'git-graph', collapsed: false })
    ).toEqual({ panel: 'explorer', collapsed: true })
  })

  it('手机上不收起侧栏，点当前项回到资源管理器', () => {
    expect(
      planActivityBarClick({
        panel: 'explorer',
        activePanel: 'explorer',
        collapsed: false,
        mobile: true
      })
    ).toEqual({ panel: 'explorer', collapsed: false })
    expect(
      planActivityBarClick({ panel: 'git', activePanel: 'git', collapsed: false, mobile: true })
    ).toEqual({ panel: 'explorer', collapsed: false })
    expect(
      planActivityBarClick({ panel: 'search', activePanel: 'git', collapsed: false, mobile: true })
    ).toEqual({ panel: 'search', collapsed: false })
  })
})

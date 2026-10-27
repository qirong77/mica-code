import { describe, expect, it } from 'bun:test'
import {
  buildSystemChecks,
  describeAccessibility,
  describeCommandLineTools,
  describeScreenRecording,
  isAllowedPane,
  normalizeCheckStatus,
  parseClangVersion,
  parseXcodeSelectPath,
  requireAllowedPane
} from './system-core.js'

/**
 * 检查项的映射与面板白名单。真实的权限探测在 system-host.js（需要 Electron 的 app 身份），
 * 这里只覆盖「原始状态 → 页面状态」这一段，以及「不能打开任意 URL」这条约束。
 */
describe('system check status mapping', () => {
  it('falls back to unknown for anything it does not recognize', () => {
    expect(normalizeCheckStatus('granted')).toBe('granted')
    expect(normalizeCheckStatus('denied')).toBe('denied')
    expect(normalizeCheckStatus('unknown')).toBe('unknown')
    expect(normalizeCheckStatus(undefined)).toBe('unknown')
    expect(normalizeCheckStatus('maybe')).toBe('unknown')
  })

  it('maps the accessibility boolean the way isTrustedAccessibilityClient reports it', () => {
    expect(describeAccessibility(true)).toEqual({ status: 'granted', detail: '' })
    expect(describeAccessibility(false)).toEqual({
      status: 'denied',
      detail: '系统里还没有授予辅助功能权限'
    })
    expect(describeAccessibility('unknown')).toEqual({ status: 'unknown', detail: '' })
  })

  it('maps every getMediaAccessStatus reading for screen recording', () => {
    expect(describeScreenRecording('granted').status).toBe('granted')
    expect(describeScreenRecording('not-determined').status).toBe('denied')
    expect(describeScreenRecording('denied').status).toBe('denied')
    const restricted = describeScreenRecording('restricted')
    expect(restricted.status).toBe('denied')
    expect(restricted.detail).toContain('管理员')
    expect(describeScreenRecording('')).toEqual({ status: 'unknown', detail: '' })
  })

  it('needs both xcode-select and a working clang for command line tools', () => {
    expect(describeCommandLineTools({ platform: 'linux' })).toEqual({
      status: 'unknown',
      detail: '仅支持 macOS'
    })
    expect(describeCommandLineTools({ platform: 'darwin' })).toMatchObject({ status: 'denied' })
    expect(
      describeCommandLineTools({
        platform: 'darwin',
        xcodePath: '/Library/Developer/CommandLineTools'
      })
    ).toMatchObject({ status: 'denied' })
    expect(
      describeCommandLineTools({
        platform: 'darwin',
        xcodePath: '/Library/Developer/CommandLineTools',
        clangVersion: '16.0.0'
      })
    ).toEqual({
      status: 'granted',
      detail: '/Library/Developer/CommandLineTools（clang 16.0.0）'
    })
  })
})

describe('command output parsing', () => {
  it('takes the first non-empty line of xcode-select -p', () => {
    expect(parseXcodeSelectPath('\n/Library/Developer/CommandLineTools\n')).toBe(
      '/Library/Developer/CommandLineTools'
    )
    expect(parseXcodeSelectPath('')).toBe('')
  })

  it('reads the version out of both Apple clang and upstream clang', () => {
    expect(
      parseClangVersion(
        'Apple clang version 16.0.0 (clang-1600.0.26.6)\nTarget: arm64-apple-darwin'
      )
    ).toBe('16.0.0')
    expect(parseClangVersion('clang version 18.1.8 (https://github.com/llvm/)')).toBe('18.1.8')
    expect(parseClangVersion('command not found')).toBe('')
  })
})

describe('settings panels', () => {
  it('only accepts the panes the plugin manifest declares', () => {
    expect(
      isAllowedPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    ).toBe(true)
    expect(isAllowedPane('https://example.com')).toBe(false)
    expect(isAllowedPane('')).toBe(false)
    expect(isAllowedPane(null)).toBe(false)
  })

  it('rejects unknown panes with a readable error instead of opening them', () => {
    expect(() => requireAllowedPane('file:///etc/passwd')).toThrow('不认识的系统设置面板')
    expect(() => requireAllowedPane('')).toThrow('缺少 pane')
    expect(
      requireAllowedPane(
        '  x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture  '
      )
    ).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
})

describe('buildSystemChecks', () => {
  it('reports every declared check in manifest order', () => {
    const report = buildSystemChecks({
      platform: 'darwin',
      accessibility: 'granted',
      screenRecording: 'denied',
      commandLineTools: { xcodePath: '/Library/Developer/CommandLineTools', clangVersion: '16.0.0' }
    })

    expect(report.platform).toBe('darwin')
    expect(report.checks.map((check) => check.id)).toEqual([
      'accessibility',
      'screen-recording',
      'command-line-tools'
    ])
    expect(report.checks.map((check) => check.status)).toEqual(['granted', 'denied', 'granted'])
    // 每一项都带着清单里的文案与「去哪里修」的入口
    expect(report.checks[0].label).toBe('辅助功能')
    expect(report.checks[0].pane).toContain('Privacy_Accessibility')
    expect(report.checks[2].pane).toBeUndefined()
  })

  it('explains that a non-macOS host cannot answer', () => {
    const report = buildSystemChecks({ platform: 'linux' })
    for (const check of report.checks) {
      expect(check.status).toBe('unknown')
      expect(check.detail).toBe('仅支持 macOS')
    }
  })
})

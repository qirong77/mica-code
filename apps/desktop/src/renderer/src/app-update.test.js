import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  OFFICIAL_RELEASE_URL,
  mergeNativeStatus,
  nativeFailureMessage,
  nativeStatusFromResult,
  preserveNativeStatus,
  runNativeUpdate,
  sourceUpdateDetails,
  updateButtonState,
  updateCheckUrl,
  updateLinks
} from './app-update.js'

test('shows a left-footer action for a discovered source update', () => {
  assert.deepEqual(updateButtonState({ available: true }, null), {
    visible: true,
    label: '有新提交',
    tone: 'primary'
  })
})

test('native downloaded state takes precedence over the source commit hint', () => {
  assert.deepEqual(updateButtonState({ available: true }, { status: 'downloaded' }), {
    visible: true,
    label: '重启更新',
    tone: 'primary'
  })
  assert.deepEqual(updateButtonState(null, { status: 'downloading', progress: 42.4 }), {
    visible: true,
    label: '下载更新 42%',
    tone: 'primary'
  })
})

test('shows immediate checking and error states without inventing an empty action', () => {
  assert.deepEqual(updateButtonState(null, { status: 'checking' }), {
    visible: true,
    label: '检查更新…',
    tone: 'primary'
  })
  assert.deepEqual(updateButtonState(null, { status: 'error', error: 'IPC failed' }), {
    visible: true,
    label: '更新失败',
    tone: 'primary'
  })
  assert.deepEqual(updateButtonState(null, { status: 'unsupported', reason: 'local-build' }), {
    visible: true,
    label: '更新说明',
    tone: undefined
  })
})

test('does not leave an empty footer action when nothing is newer', () => {
  assert.deepEqual(updateButtonState({ available: false }, { status: 'not-available' }), {
    visible: false,
    label: '',
    tone: undefined
  })
  assert.equal(updateCheckUrl(), '/api/update/check')
  assert.equal(updateCheckUrl(true), '/api/update/check?force=1')
})

test('the native feed reporting no package suppresses a newer source commit hint', async () => {
  const phases = []
  const outcome = await runNativeUpdate({
    bridge: {
      check: async () => ({ ok: true, status: { status: 'not-available', version: '1.0.0' } })
    },
    onStatus: (status) => phases.push(status)
  })
  assert.equal(outcome.kind, 'source')
  assert.equal(outcome.reason, 'no-package')
  assert.equal(updateButtonState({ available: true }, phases.at(-1)).visible, false)
  assert.equal(sourceUpdateDetails(outcome).mode, '无可用桌面更新')
  assert.match(sourceUpdateDetails(outcome).detail, /源码提交领先不代表正式 Release 已发布/)
})

test('a click that discovers an available native update immediately starts downloading', async () => {
  const calls = []
  const phases = []
  const outcome = await runNativeUpdate({
    bridge: {
      async check() {
        calls.push('check')
        return { ok: true, status: { status: 'available', version: '1.0.2' } }
      },
      async download() {
        calls.push('download')
        return { ok: true, status: { status: 'downloading', progress: 0 } }
      }
    },
    onStatus: (status) => phases.push(status.status)
  })
  assert.deepEqual(calls, ['check', 'download'])
  assert.deepEqual(phases, ['checking', 'available', 'downloading', 'downloading'])
  assert.equal(outcome.kind, 'download')
  assert.equal(outcome.result.ok, true)
})

test('a downloaded native package goes straight to install and preserves failures', async () => {
  const calls = []
  const outcome = await runNativeUpdate({
    currentStatus: 'downloaded',
    bridge: {
      async install() {
        calls.push('install')
        return { ok: false, code: 'busy', error: '会话仍在运行' }
      }
    }
  })
  assert.deepEqual(calls, ['install'])
  assert.equal(outcome.kind, 'install')
  assert.equal(outcome.result.ok, false)
  assert.equal(outcome.result.code, 'busy')
  assert.equal(outcome.status.status, 'downloaded')
})

test('discovering an already downloaded package still requires an explicit restart click', async () => {
  const calls = []
  const outcome = await runNativeUpdate({
    bridge: {
      check: async () => {
        calls.push('check')
        return { ok: true, status: { status: 'downloaded', version: '1.0.2', progress: 100 } }
      },
      install: async () => {
        calls.push('install')
        return { ok: true, status: { status: 'installing' } }
      }
    }
  })
  assert.deepEqual(calls, ['check'])
  assert.equal(outcome.kind, 'download')
  assert.equal(updateButtonState({ available: true }, outcome.status).label, '重启更新')
})

test('IPC rejection is returned as a visible native failure', async () => {
  const outcome = await runNativeUpdate({
    bridge: {
      async check() {
        throw new Error('bridge disconnected')
      }
    }
  })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.result.ok, false)
  assert.equal(outcome.result.rejected, true)
  assert.equal(outcome.result.error, 'bridge disconnected')
})

test('status polling cannot downgrade a package that is downloading or downloaded', () => {
  const downloading = { status: 'downloading', progress: 60 }
  const downloaded = { status: 'downloaded', progress: 100 }
  assert.equal(preserveNativeStatus(downloading, { status: 'not-available' }), downloading)
  assert.equal(preserveNativeStatus(downloaded, { status: 'checking' }), downloaded)
  assert.deepEqual(preserveNativeStatus(downloaded, { status: 'installing' }), {
    status: 'installing'
  })
})

test('a foreground failure can replace an optimistic downloading state', () => {
  const downloading = { status: 'downloading', progress: 0 }
  const unsupported = { status: 'unsupported', reason: 'local-build' }
  assert.equal(mergeNativeStatus(downloading, unsupported), downloading)
  assert.deepEqual(mergeNativeStatus(downloading, unsupported, { force: true }), unsupported)
})

test('foreground native responses are marked final for the component state merger', async () => {
  const events = []
  await runNativeUpdate({
    currentStatus: 'available',
    bridge: {
      download: async () => ({
        ok: false,
        code: 'unsupported',
        reason: 'local-build',
        status: { status: 'unsupported', reason: 'local-build' }
      })
    },
    onStatus: (status, meta) => events.push({ status, meta })
  })
  assert.equal(events[0].status.status, 'downloading')
  assert.equal(events.at(-1).status.status, 'unsupported')
  assert.deepEqual(events.at(-1).meta, { final: true })
})

test('failure envelopes and missing methods cannot leave the action stuck checking or downloading', async () => {
  for (const code of ['unsupported', 'remote-window', 'network']) {
    const phases = []
    const outcome = await runNativeUpdate({
      bridge: { check: async () => ({ ok: false, code, error: 'unavailable' }) },
      onStatus: (status) => phases.push(status.status)
    })
    assert.equal(outcome.kind, code === 'network' ? 'error' : 'source')
    assert.equal(phases.at(-1), code === 'network' ? 'error' : 'unsupported')
  }
  for (const bridge of [{}, { download: async () => ({ ok: false, error: 'offline' }) }]) {
    const phases = []
    await runNativeUpdate({
      bridge,
      currentStatus: 'available',
      onStatus: (status) => phases.push(status.status)
    })
    assert.equal(phases.at(-1), 'error')
  }
})

test('browser pages explain their installer boundary instead of pretending to be a source checkout', async () => {
  const outcome = await runNativeUpdate({})
  assert.equal(outcome.reason, 'browser')
  assert.equal(sourceUpdateDetails(outcome).mode, '浏览器页面')
  assert.match(sourceUpdateDetails(outcome).detail, /不会替本机或远程服务安装或重启/)
  assert.doesNotMatch(sourceUpdateDetails(outcome).detail, /当前运行的是源码/)
})

test('unsupported native capabilities retain their specific reason, message, release link and raw error', async () => {
  const reasons = [
    ['development', '源码 / 开发模式'],
    ['local-build', '本机构建包'],
    ['unsupported-platform', '平台暂不支持'],
    ['unsupported-architecture', '架构暂不支持'],
    ['appimage-required', '安装方式不支持'],
    ['mac-signature-required', 'macOS 签名要求未满足'],
    ['updater-disabled', '自动更新已停用'],
    ['capability-unavailable', '本机安装器不可用'],
    ['feed-unavailable', '更新源不可用']
  ]
  for (const [reason, mode] of reasons) {
    const message = `此环境不能自动更新（${reason}）`
    const result = {
      ok: false,
      code: 'unsupported',
      reason,
      error: `diagnostic:${reason}`,
      status: { status: 'unsupported', reason, message, releaseUrl: OFFICIAL_RELEASE_URL }
    }
    const phases = []
    const outcome = await runNativeUpdate({
      bridge: { check: async () => result },
      onStatus: (status) => phases.push(status)
    })
    assert.equal(outcome.kind, 'source')
    assert.equal(outcome.reason, reason)
    assert.equal(outcome.message, message)
    assert.equal(outcome.result, result)
    assert.equal(outcome.result.error, `diagnostic:${reason}`)
    assert.equal(outcome.status.status, 'unsupported')
    assert.equal(outcome.status.releaseUrl, OFFICIAL_RELEASE_URL)
    assert.equal(phases.at(-1).reason, reason)
    assert.equal(phases.at(-1).message, message)
    const details = sourceUpdateDetails(outcome)
    assert.equal(details.mode, mode)
    assert.match(details.detail, new RegExp(reason))
    assert.match(details.detail, /正式 Release 下载页/)
    assert.equal(nativeFailureMessage(result), details.detail)
    assert.equal(updateButtonState({ available: true }, outcome.status).label, '有新提交')
    assert.equal(updateButtonState(null, outcome.status).label, '更新说明')
    if (reason !== 'development') assert.notEqual(details.mode, '源码 / 开发模式')
  }
})

test('unsupported modes have specific explanations even without a native human message', () => {
  for (const [reason, pattern] of [
    ['local-build', /本机构建/],
    ['unsupported-platform', /当前平台/],
    ['unsupported-architecture', /架构/],
    ['appimage-required', /AppImage/],
    ['mac-signature-required', /签名要求/],
    ['updater-disabled', /已停用/],
    ['capability-unavailable', /安装器/],
    ['feed-unavailable', /无法读取桌面更新源/],
    ['unsupported', /当前环境暂不支持/]
  ]) {
    assert.match(sourceUpdateDetails({ reason }).detail, pattern)
  }
  assert.notEqual(sourceUpdateDetails({ reason: 'unsupported' }).mode, '源码 / 开发模式')
})

test('failure envelopes with a stale available or downloaded status cannot trigger native actions', async () => {
  for (const staleStatus of ['available', 'downloaded']) {
    for (const code of ['network', 'unsupported', 'remote-window']) {
      const calls = []
      const phases = []
      const result = {
        ok: false,
        code,
        reason: code === 'unsupported' ? 'local-build' : code,
        error: 'request failed',
        status: { status: staleStatus, version: '1.0.2', message: '不能确认更新包' }
      }
      const outcome = await runNativeUpdate({
        bridge: {
          check: async () => {
            calls.push('check')
            return result
          },
          download: async () => {
            calls.push('download')
            throw new Error('must not download')
          },
          install: async () => {
            calls.push('install')
            throw new Error('must not install')
          }
        },
        onStatus: (status) => phases.push(status)
      })
      assert.deepEqual(calls, ['check'])
      assert.equal(outcome.kind, code === 'network' ? 'error' : 'source')
      assert.equal(outcome.result, result)
      assert.equal(outcome.status.message, '不能确认更新包')
      assert.equal(
        phases.some((status) => status.status === 'available'),
        false
      )
      assert.notEqual(updateButtonState({ available: true }, outcome.status).label, '下载更新')
      if (code === 'remote-window') {
        assert.equal(outcome.reason, 'remote-window')
        assert.equal(sourceUpdateDetails(outcome).mode, '远程页面')
        assert.match(sourceUpdateDetails(outcome).detail, /不能安装本机应用/)
      }
    }
  }
})

test('unsupported download and install actions return source explanations rather than false progress', async () => {
  for (const [action, currentStatus] of [
    ['download', 'available'],
    ['install', 'downloaded']
  ]) {
    const phases = []
    const outcome = await runNativeUpdate({
      currentStatus,
      bridge: {
        [action]: async () => ({
          ok: false,
          code: 'unsupported',
          reason: 'mac-signature-required',
          error: 'signature check failed',
          status: { status: 'unsupported', message: '此应用签名不支持自动安装' }
        })
      },
      onStatus: (status) => phases.push(status)
    })
    assert.equal(outcome.kind, 'source')
    assert.equal(outcome.reason, 'mac-signature-required')
    assert.equal(phases.at(-1).status, 'unsupported')
    assert.equal(outcome.status.message, '此应用签名不支持自动安装')
  }
})

test('null or incomplete check responses are failures, never a claim that the app is up to date', async () => {
  for (const result of [null, { ok: true }]) {
    const phases = []
    const outcome = await runNativeUpdate({
      bridge: { check: async () => result },
      onStatus: (status) => phases.push(status)
    })
    assert.equal(outcome.kind, 'error')
    assert.equal(outcome.result.ok, false)
    assert.equal(outcome.status.status, 'error')
    assert.equal(
      phases.some((status) => status.status === 'not-available'),
      false
    )
    assert.equal(updateButtonState({ available: true }, outcome.status).label, '更新失败')
  }
})

test('native error messages are human-readable without replacing the original diagnostic error', async () => {
  const result = {
    ok: false,
    error: 'HttpError: 404 latest-mac.yml',
    status: {
      status: 'error',
      reason: 'feed-unavailable',
      message: '更新源暂时不可用，请前往正式下载页。',
      releaseUrl: OFFICIAL_RELEASE_URL
    }
  }
  const outcome = await runNativeUpdate({ bridge: { check: async () => result } })
  assert.equal(outcome.kind, 'error')
  assert.equal(nativeFailureMessage(outcome.result), result.status.message)
  assert.equal(outcome.result.error, 'HttpError: 404 latest-mac.yml')
  assert.equal(outcome.status.error, result.error)
  assert.equal(outcome.status.reason, 'feed-unavailable')
  assert.equal(updateButtonState({ available: true }, outcome.status).label, '更新失败')
})

test('native error or unsupported status is authoritative even inside an ok response', async () => {
  for (const status of ['error', 'unsupported']) {
    const outcome = await runNativeUpdate({
      bridge: {
        check: async () => ({
          ok: true,
          status: {
            status,
            reason: 'updater-disabled',
            message: '当前不能更新',
            error: 'diagnostic'
          }
        })
      }
    })
    assert.equal(outcome.kind, status === 'error' ? 'error' : 'source')
    assert.notEqual(updateButtonState({ available: true }, outcome.status).label, '下载更新')
  }
})

test('status normalization preserves envelope metadata and protects polling from failed available results', () => {
  const result = {
    ok: false,
    code: 'unsupported',
    reason: 'local-build',
    message: '当前是本机构建包',
    releaseUrl: OFFICIAL_RELEASE_URL,
    error: 'missing app-update.yml',
    status: { status: 'available', version: '1.0.2' }
  }
  assert.deepEqual(nativeStatusFromResult(result), {
    status: 'unsupported',
    version: '1.0.2',
    reason: 'local-build',
    message: '当前是本机构建包',
    releaseUrl: OFFICIAL_RELEASE_URL,
    error: 'missing app-update.yml'
  })
  assert.equal(result.status.status, 'available')
  assert.equal(nativeStatusFromResult(null), null)
})

test('all update details offer the official release recovery link before source links', () => {
  const latestUrl = 'https://github.com/qirong77/mica-code/commit/abc123'
  const repository = 'https://github.com/qirong77/mica-code'
  assert.deepEqual(updateLinks({ latestUrl, repository }), [
    { href: OFFICIAL_RELEASE_URL, label: '打开正式 Release 下载页' },
    { href: latestUrl, label: '打开最新提交' },
    { href: repository, label: '打开项目仓库' }
  ])
  assert.deepEqual(updateLinks(null), [
    { href: OFFICIAL_RELEASE_URL, label: '打开正式 Release 下载页' }
  ])
  assert.deepEqual(
    updateLinks({ latestUrl: 'javascript:alert(1)', repository: 'file:///tmp/repo' }),
    updateLinks(null)
  )
  assert.equal(
    updateLinks({ latestUrl: OFFICIAL_RELEASE_URL, repository: OFFICIAL_RELEASE_URL }).length,
    1
  )
})

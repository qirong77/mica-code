import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTerminalSessions } from './terminal-sessions.js'

/**
 * 可控的假 pty：真 pty 在 bun 下不送数据（node-pty 原生绑定），
 * 会话生命周期本身与 pty 实现对无关，这里只验证我们自己的状态机。
 */
function createFakePty() {
  const dataHandlers = []
  const exitHandlers = []
  const written = []
  let destroyed = 0
  const proc = {
    written,
    data(chunk) {
      for (const handler of dataHandlers) handler(chunk)
    },
    exit(exitCode = 0, signal = 0) {
      for (const handler of exitHandlers) handler({ exitCode, signal })
    },
    get destroyed() {
      return destroyed
    },
    onData(handler) {
      dataHandlers.push(handler)
      return { dispose() {} }
    },
    onExit(handler) {
      exitHandlers.push(handler)
      return { dispose() {} }
    },
    write(payload) {
      written.push(payload)
    },
    resize() {},
    kill() {},
    destroy() {
      destroyed += 1
    }
  }
  return proc
}

function makeSessions() {
  const ptys = []
  const sessions = createTerminalSessions({
    onChange: () => {},
    spawnPty: () => {
      const proc = createFakePty()
      ptys.push(proc)
      return proc
    }
  })
  return { sessions, ptys }
}

describe('terminal session lifecycle', () => {
  let sessions = null
  let ptys = []

  beforeEach(() => {
    ;({ sessions, ptys } = makeSessions())
  })

  afterEach(() => {
    sessions.shutdown()
  })

  test('forwards input and renders pty output into the screen', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    sessions.write(session.id, { text: 'echo hi', submit: true })

    expect(ptys[0].written).toEqual(['echo hi\r'])
    ptys[0].data('echo hi\r\nhi\r\n')

    const detail = await sessions.detail(session.id)
    expect(detail.screen.text).toContain('hi')
    expect(detail.outputSeq).toBeGreaterThan(0)
  })

  test('wait returns timeout instead of hanging when nothing matches', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    ptys[0].data('flood\r\n')

    const startedAt = Date.now()
    const waited = await sessions.waitFor(session.id, { text: 'never', timeoutMs: 300 })
    expect(waited.matched).toBe(false)
    expect(waited.reason).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(3000)
  })

  test('close wakes a pending wait and destroys the pty', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    const pending = sessions.waitFor(session.id, { text: 'never', timeoutMs: 5000 })
    setTimeout(() => sessions.close(session.id), 100)

    const result = await pending
    expect(result.matched).toBe(false)
    expect(result.reason).toBe('closed')
    expect(ptys[0].destroyed).toBe(1)
  })

  test('an exited shell frees its slot for a new session', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    ptys[0].exit(0, 0)

    const summary = sessions.list().find((item) => item.id === session.id)
    expect(summary.running).toBe(false)

    for (let index = 0; index < 11; index += 1) {
      await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    }
    expect(sessions.list()).toHaveLength(12)
  })

  test('rejects the session after the live-shell limit', async () => {
    for (let index = 0; index < 12; index += 1) {
      await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    }
    await expect(sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })).rejects.toThrow(/上限/)
  })

  test('resize keeps pty and mirror in sync', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    const resized = await sessions.resize(session.id, { cols: 100, rows: 40 })
    expect(resized.cols).toBe(100)
    expect(resized.rows).toBe(40)
    expect(sessions.get(session.id).cols).toBe(100)
  })

  test('wait text ignores the echo of what we just typed', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    // shell 回显了命令本身，但命令还没跑完：此时等 `done` 不能被回显骗到
    sessions.write(session.id, { text: 'echo done-marker', submit: true })
    ptys[0].data('echo done-marker\r\n')

    const timely = await sessions.waitFor(session.id, { text: 'done-marker', timeoutMs: 120 })
    expect(timely.matched).toBe(false)
    expect(timely.reason).toBe('timeout')

    ptys[0].data('done-marker\r\n')
    const hit = await sessions.waitFor(session.id, { text: 'done-marker', timeoutMs: 2000 })
    expect(hit.matched).toBe(true)
  })

  test('wait can still match the echo when skipEcho is off', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    sessions.write(session.id, { text: 'echo plain-marker', submit: true })
    ptys[0].data('echo plain-marker\r\n')

    const hit = await sessions.waitFor(session.id, {
      text: 'plain-marker',
      skipEcho: false,
      timeoutMs: 1000
    })
    expect(hit.matched).toBe(true)
    expect(hit.reason).toBe('text')
  })

  test.each([
    {
      cols: 80,
      prompt: 'MICA_QA_7E42_INPUT> ',
      output: 'MICA_QA_7E42_RECEIVED=<林 奇荣 qa smoke>'
    },
    {
      cols: 21,
      prompt: 'MICA_QA_7E42_INPUT> ',
      output: 'MICA_QA_7E42_RECEIVED=<林 奇荣 qa smoke>'
    },
    { cols: 21, prompt: 'abcd中文  xyz尾> ', output: 'received: 林 奇荣 qa smoke' },
    { cols: 21, prompt: 'INPUT> ', output: '林 奇荣 qa smoke' },
    { cols: 21, prompt: 'INPUT> ', output: 'INPUT> 林 奇荣 qa smoke' },
    { cols: 21, prompt: '', output: '林 奇荣 qa smoke' }
  ])(
    'wait preserves interactive results at $cols columns with prompt $prompt and output $output',
    async ({ cols, prompt, output }) => {
      const session = await sessions.create({ shell: '/bin/sh', cols, rows: 24 })
      const input = '林 奇荣 qa smoke'
      ptys[0].data(prompt)
      await sessions.detail(session.id)
      sessions.write(session.id, { text: input, submit: true })
      ptys[0].data(`${input}\r\n`)

      const echoOnly = await sessions.waitFor(session.id, { text: input, timeoutMs: 100 })
      expect(echoOnly.matched).toBe(false)
      const raw = await sessions.waitFor(session.id, {
        text: input,
        skipEcho: false,
        timeoutMs: 350
      })
      expect(raw.matched).toBe(true)

      ptys[0].data(`\r\n${output}\r\n`)
      for (const condition of [
        { text: output },
        { regex: `${output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n` }
      ]) {
        const hit = await sessions.waitFor(session.id, { ...condition, timeoutMs: 350 })
        expect(hit.matched).toBe(true)
        expect(hit.screen).toEqual((await sessions.detail(session.id)).screen)
      }
    }
  )

  test('wait locates the latest repeated echo from its write context', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 20, rows: 24 })
    const command = 'git status'
    ptys[0].data(`~ $ ${command}\r\nclean\r\n~ $ `)
    await sessions.detail(session.id)
    sessions.write(session.id, { text: command, submit: true })
    ptys[0].data(`${command}\r\noutput: ${command}\r\n`)
    const hit = await sessions.waitFor(session.id, { text: `output: ${command}`, timeoutMs: 350 })
    expect(hit.matched).toBe(true)
    expect(session.recentInputs.at(-1).echoContext.preceding).toBe(1)
  })

  test('wait matches long stdout by text and regex while returning the unchanged visual screen', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 64, rows: 24 })
    const marker =
      'MICA_WRAP_TARGET_9137_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_abcdefghijklmnopqrstuvwxyz_LONG_OUTPUT'
    ptys[0].data(`${marker}\r\n$ `)
    const { screen } = await sessions.detail(session.id)
    expect(screen.lines).toEqual([marker.slice(0, 64), marker.slice(64), '$ '])
    expect(screen.cursor).toEqual({ x: 2, y: 2, absoluteY: 2 })
    for (const condition of [{ text: marker }, { regex: `^${marker}\\n` }]) {
      const hit = await sessions.waitFor(session.id, { ...condition, timeoutMs: 350 })
      expect(hit.matched).toBe(true)
      expect(hit.screen).toEqual(screen)
      expect(Object.keys(hit).sort()).toEqual(['elapsedMs', 'matched', 'reason', 'screen'])
    }
    expect((await sessions.detail(session.id)).screen).toEqual(screen)
  })

  test.each([
    { cols: 20, marker: 'MICA_WRAP_TARGET_ABCDEFGHIJKLMNOPQRSTUVWXYZ_LONG_OUTPUT' },
    { cols: 21, marker: 'abcdefghijklmnopqrst中文宽字符_输出标记_ABCDEFGHIJKLMNOPQRSTUVWXYZ' }
  ])(
    'wait masks long echoes at $cols columns before stdout and honors skipEcho:false',
    async ({ cols, marker }) => {
      const session = await sessions.create({ shell: '/bin/sh', cols, rows: 24 })
      const command = `printf '%s\\n' ${marker}`
      sessions.write(session.id, { text: command, submit: true })
      ptys[0].data(`$ ${command}\r\n`)
      const { screen } = await sessions.detail(session.id)
      for (const condition of [{ text: marker.slice(-6) }, { regex: marker }]) {
        const miss = await sessions.waitFor(session.id, { ...condition, timeoutMs: 100 })
        expect(miss.matched).toBe(false)
        expect(miss.reason).toBe('timeout')
        expect(miss.screen).toEqual(screen)
      }
      for (const condition of [{ text: marker }, { regex: marker }]) {
        const echo = await sessions.waitFor(session.id, {
          ...condition,
          skipEcho: false,
          timeoutMs: 350
        })
        expect(echo.matched).toBe(true)
        expect(echo.screen).toEqual(screen)
      }

      ptys[0].data(`${marker}\r\n$ `)
      const output = await sessions.detail(session.id)
      for (const condition of [{ text: marker }, { regex: marker }]) {
        const hit = await sessions.waitFor(session.id, { ...condition, timeoutMs: 350 })
        expect(hit.matched).toBe(true)
        expect(hit.screen).toEqual(output.screen)
      }
    }
  )

  test('wait does not join real newlines into a false text or regex match', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 20, rows: 24 })
    const first = 'abcdefghijklmnopqrst'
    const second = 'uvwxyz_LONG_OUTPUT'
    ptys[0].data(`${first}\r\n${second}\r\n`)
    for (const condition of [{ text: first + second }, { regex: `${first}${second}` }]) {
      const miss = await sessions.waitFor(session.id, { ...condition, timeoutMs: 100 })
      expect(miss.matched).toBe(false)
      expect(miss.reason).toBe('timeout')
    }
    const hit = await sessions.waitFor(session.id, {
      text: `${first}\n${second}`,
      timeoutMs: 350
    })
    expect(hit.matched).toBe(true)
  })

  test('wait matches a specific exit code', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    setTimeout(() => ptys[0].exit(2, 0), 30)
    const hit = await sessions.waitFor(session.id, { expectExitCode: 2, timeoutMs: 2000 })
    expect(hit.matched).toBe(true)
    expect(hit.reason).toBe('exitCode')
  })

  test('wait reports a mismatching exit code immediately instead of timing out', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    setTimeout(() => ptys[0].exit(1, 0), 30)
    const startedAt = Date.now()
    const miss = await sessions.waitFor(session.id, { expectExitCode: 0, timeoutMs: 5000 })
    expect(miss.matched).toBe(false)
    expect(miss.reason).toBe('exitCode')
    expect(miss.exitCode).toBe(1)
    expect(Date.now() - startedAt).toBeLessThan(1500)
  })

  test('reading the screen does not hang while the command keeps printing', async () => {
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })
    // 持续输出：pendingWrites 一直不归零，读屏必须靠预算兜底返回
    const timer = setInterval(() => ptys[0].data('tick\n'), 5)
    try {
      // 让输出先堆起来，读屏时队列里始终有未解析的块
      await new Promise((resolve) => setTimeout(resolve, 40))
      const startedAt = Date.now()
      const detail = await sessions.detail(session.id)
      expect(detail.screen.text).toContain('tick')
      expect(Date.now() - startedAt).toBeLessThan(3000)
    } finally {
      clearInterval(timer)
    }
  })
})

describe('terminal session reclamation', () => {
  test('reclaims an exited session after the TTL, not before', async () => {
    const ptys = []
    const sessions = createTerminalSessions({
      onChange: () => {},
      sweepIntervalMs: 0,
      spawnPty: () => {
        const proc = createFakePty()
        ptys.push(proc)
        return proc
      }
    })
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24, owner: 'sess-1' })
    ptys[0].exit(0, 0)

    expect(sessions.sweep(Date.now())).toEqual([])
    expect(sessions.list()).toHaveLength(1)

    const later = Date.now() + 11 * 60 * 1000
    expect(sessions.sweep(later)).toEqual([session.id])
    expect(sessions.list()).toHaveLength(0)
    sessions.shutdown()
  })

  test('keeps a session that a window is still showing', async () => {
    const ptys = []
    const sessions = createTerminalSessions({
      onChange: () => {},
      sweepIntervalMs: 0,
      spawnPty: () => {
        const proc = createFakePty()
        ptys.push(proc)
        return proc
      }
    })
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24, owner: 'sess-1' })
    ptys[0].exit(0, 0)
    sessions.setWindowVisible(session.id, true)

    expect(sessions.sweep(Date.now() + 60 * 60 * 1000)).toEqual([])
    expect(sessions.list()).toHaveLength(1)
    sessions.shutdown()
  })

  test('reclaims a hidden live shell only after the idle TTL', async () => {
    const ptys = []
    const sessions = createTerminalSessions({
      onChange: () => {},
      sweepIntervalMs: 0,
      spawnPty: () => {
        const proc = createFakePty()
        ptys.push(proc)
        return proc
      }
    })
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24, owner: 'sess-1' })

    // 默认半小时回收，期限内保留
    expect(sessions.sweep(Date.now() + 29 * 60 * 1000)).toEqual([])
    expect(sessions.list()).toHaveLength(1)

    expect(sessions.sweep(Date.now() + 31 * 60 * 1000)).toEqual([session.id])
    expect(sessions.list()).toHaveLength(0)
    expect(ptys[0].destroyed).toBe(1)
    sessions.shutdown()
  })

  test('activity pushes the idle TTL forward', async () => {
    const sessions = createTerminalSessions({
      onChange: () => {},
      sweepIntervalMs: 0,
      idleTtlMs: 10_000,
      spawnPty: () => createFakePty()
    })
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24, owner: 'sess-1' })

    sessions.write(session.id, { text: 'ls', submit: true })

    expect(sessions.sweep(Date.now() + 9_000)).toEqual([])
    expect(sessions.sweep(Date.now() + 11_000)).toEqual([session.id])
    sessions.shutdown()
  })

  test('reads renew live and exited sessions but list polling does not', async () => {
    const proc = createFakePty()
    const sessions = createTerminalSessions({
      sweepIntervalMs: 0,
      idleTtlMs: 10_000,
      exitedTtlMs: 10_000,
      spawnPty: () => proc
    })
    try {
      const session = await sessions.create({ shell: '/bin/sh', owner: 'sess-1' })
      for (const exited of [false, true]) {
        if (exited) proc.exit()
        for (const read of [
          () => sessions.detail(session.id),
          () => sessions.readOutput(session.id)
        ]) {
          session.lastActivityAt = Date.now() - 20_000
          await read()
          expect(sessions.sweep()).toEqual([])
        }
      }
      session.lastActivityAt = Date.now() - 20_000
      sessions.list({ owner: 'sess-1' })
      expect(sessions.sweep()).toEqual([session.id])
    } finally {
      sessions.shutdown()
    }
  })

  test('protects pending waits and renews activity on completion', async () => {
    const sessions = createTerminalSessions({
      sweepIntervalMs: 0,
      idleTtlMs: 10_000,
      spawnPty: () => createFakePty()
    })
    try {
      const session = await sessions.create({ shell: '/bin/sh', owner: 'sess-1' })
      const waiting = sessions.waitFor(session.id, { text: 'never', timeoutMs: 100 })
      expect(sessions.sweep(Date.now() + 60_000)).toEqual([])
      expect((await waiting).reason).toBe('timeout')
      expect(session.activeOperations).toBe(0)
      expect(sessions.sweep(Date.now() + 9_000)).toEqual([])
      expect(sessions.sweep(Date.now() + 11_000)).toEqual([session.id])
    } finally {
      sessions.shutdown()
    }
  })

  test('pending output protects the shell', async () => {
    const proc = createFakePty()
    const sessions = createTerminalSessions({
      sweepIntervalMs: 0,
      idleTtlMs: 10_000,
      spawnPty: () => proc
    })
    try {
      const session = await sessions.create({ shell: '/bin/sh', owner: 'sess-1' })
      session.lastActivityAt = Date.now() - 20_000
      proc.data('still working\r\n')
      expect(sessions.sweep()).toEqual([])
      await sessions.detail(session.id)
      expect(sessions.sweep()).toEqual([])
    } finally {
      sessions.shutdown()
    }
  })

  test('zero idle TTL disables live shell reclamation', async () => {
    const sessions = createTerminalSessions({
      sweepIntervalMs: 0,
      idleTtlMs: 0,
      spawnPty: () => createFakePty()
    })
    try {
      await sessions.create({ shell: '/bin/sh', owner: 'sess-1' })
      expect(sessions.sweep(Date.now() + 24 * 60 * 60 * 1000)).toEqual([])
    } finally {
      sessions.shutdown()
    }
  })

  test('keeps a live shell whose window is showing', async () => {
    const sessions = createTerminalSessions({
      onChange: () => {},
      sweepIntervalMs: 0,
      spawnPty: () => createFakePty()
    })
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24, owner: 'sess-1' })
    sessions.setWindowVisible(session.id, true)

    expect(sessions.sweep(Date.now() + 24 * 60 * 60 * 1000)).toEqual([])
    expect(sessions.list()).toHaveLength(1)
    sessions.shutdown()
  })

  test('reclaims a session that has no owner right away', async () => {
    const sessions = createTerminalSessions({
      onChange: () => {},
      sweepIntervalMs: 0,
      spawnPty: () => createFakePty()
    })
    const session = await sessions.create({ shell: '/bin/sh', cols: 80, rows: 24 })

    // 没有归属的终端在顶栏没有任何入口，留着只会越积越多
    expect(sessions.sweep(Date.now())).toEqual([session.id])
    expect(sessions.list()).toHaveLength(0)
    sessions.shutdown()
  })
})

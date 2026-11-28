import { readBtwState } from '@packages/mica-common/btwState.js'
import { MICA_METHODS } from '@packages/mica-runtime/codexProtocol.js'
import { unwrapHostResult } from './chat-capabilities.js'

/** Forward requests to the resident app-server. Host selection and turn state belong to chat.js. */
export function registerChatHostIpc(ipc, { runs, request, ensureBtwRun, ensureCapabilityRun }) {
  function inputSignal(method) {
    return (event, { id } = {}) => {
      const run = runs.get(id)
      if (!run?.child?.stdin?.writable) return { ok: true, forwarded: false }
      run.sender = event.sender
      void request(run, method, {}).catch(() => {})
      return { ok: true, forwarded: true }
    }
  }
  ipc.handle('chat:input-activity', inputSignal(MICA_METHODS.inputActivity))
  ipc.handle('chat:input-focus', inputSignal(MICA_METHODS.inputFocus))

  function taskRequest(method, options) {
    return (event, payload = {}) => {
      const { id, taskId } = payload
      if (!id || !taskId) return { ok: false, error: '参数缺失' }
      const run = runs.get(id)
      if (run?.child) run.sender = event.sender
      return request(run, method, { taskId, ...options?.(payload) })
    }
  }
  ipc.handle(
    'chat:kill-background-task',
    taskRequest(MICA_METHODS.killBackgroundTask, ({ forceAfterMs }) =>
      forceAfterMs === undefined ? {} : { forceAfterMs }
    )
  )
  ipc.handle(
    'chat:background-task-output',
    taskRequest(MICA_METHODS.backgroundTaskOutput, ({ tailBytes }) =>
      tailBytes ? { tailBytes } : {}
    )
  )
  ipc.handle('chat:subagent-detail', taskRequest(MICA_METHODS.subagentTaskDetail))
  ipc.handle('chat:kill-subagent', taskRequest(MICA_METHODS.killSubagentTask))
  ipc.handle('chat:restart-subagent', taskRequest(MICA_METHODS.restartSubagentTask))

  function btwRequest(event, { id, sessionId, cwd }, method, params) {
    const { run, error } = ensureBtwRun(id, event, { sessionId, cwd })
    return run ? request(run, method, params) : { ok: false, error }
  }
  ipc.handle('chat:btw-ask', (event, payload = {}) => {
    if (!payload.id) return { ok: false, error: 'chat id 缺失' }
    const question = typeof payload.question === 'string' ? payload.question.trim() : ''
    const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : ''
    return btwRequest(event, payload, MICA_METHODS.btwAsk, {
      question,
      ...(threadId ? { threadId } : {}),
      ...(payload.queue ? { queue: true } : {})
    })
  })
  const threadParams = (threadId) => ({ threadId: typeof threadId === 'string' ? threadId : '' })
  function btwThreadCommand(method) {
    return (event, payload = {}) =>
      btwRequest(event, payload, method, threadParams(payload.threadId))
  }
  ipc.handle('chat:btw-compact', btwThreadCommand(MICA_METHODS.btwCompact))
  ipc.handle('chat:btw-interrupt', btwThreadCommand(MICA_METHODS.btwInterrupt))
  ipc.handle('chat:btw-recall', btwThreadCommand(MICA_METHODS.btwRecall))
  ipc.handle('chat:btw-close', (event, { id, threadId } = {}) => {
    const run = runs.get(id)
    if (!run?.child) return { ok: true }
    run.sender = event.sender
    return request(run, MICA_METHODS.btwClose, threadParams(threadId))
  })
  ipc.handle('chat:btw-threads', (event, { id, sessionId } = {}) => {
    const run = runs.get(id)
    if (run?.child) {
      run.sender = event.sender
      return request(run, MICA_METHODS.btwThreads, {})
    }
    const target = typeof sessionId === 'string' ? sessionId.trim() : ''
    const stored = target ? readBtwState(target) : []
    return { ok: true, threads: stored.map(({ id, entries }) => ({ id, entries })) }
  })

  async function sessionRequest(event, { id, sessionId, cwd }, method, params, role) {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    if ('pluginId' in params && (typeof params.pluginId !== 'string' || !params.pluginId)) {
      return { ok: false, error: 'pluginId 缺失' }
    }
    const { run, error } = ensureCapabilityRun(id, event, { sessionId, cwd, role })
    return run ? unwrapHostResult(await request(run, method, params)) : { ok: false, error }
  }
  ipc.handle('chat:capabilities', (event, payload = {}) =>
    sessionRequest(event, payload, MICA_METHODS.capabilitiesGet, {}, payload.role)
  )
  ipc.handle('chat:set-capabilities', (event, payload = {}) =>
    sessionRequest(
      event,
      payload,
      MICA_METHODS.capabilitiesSet,
      { selection: payload.selection },
      payload.role
    )
  )
  ipc.handle('chat:session-state', (event, payload = {}) =>
    sessionRequest(event, payload, MICA_METHODS.sessionStateGet, { pluginId: payload.pluginId })
  )
  ipc.handle('chat:set-session-state', (event, payload = {}) =>
    sessionRequest(event, payload, MICA_METHODS.sessionStateSet, {
      pluginId: payload.pluginId,
      value: payload.value ?? null
    })
  )
  ipc.handle('chat:plugin-settings', (event, payload = {}) =>
    sessionRequest(event, payload, MICA_METHODS.pluginSettingsGet, {})
  )
  ipc.handle('chat:set-plugin-settings', (event, payload = {}) =>
    sessionRequest(event, payload, MICA_METHODS.pluginSettingsSet, {
      pluginId: payload.pluginId,
      values: payload.values
    })
  )
}

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createSessionReader, filterCurrentThinking } from './session-reader'

describe('session reader', () => {
  it('filters checkpoints from a previous endpoint or protocol', () => {
    const history = [
      { role: 'user', text: 'question' },
      { role: 'assistant', kind: 'reasoning', text: 'old', providerId: 'p', protocol: 'openai_responses', model: 'm', apiBase: 'https://old' }
    ]
    expect(filterCurrentThinking(history, { id: 'p', protocol: 'openai_responses', api_base: 'https://old' })).toEqual(history)
    expect(filterCurrentThinking(history, { id: 'p', protocol: 'openai_responses', api_base: 'https://new' })).toEqual([history[0]])
    expect(filterCurrentThinking(history, { id: 'p', protocol: 'openai_chat_completions', api_base: 'https://old' })).toEqual([history[0]])
  })
  it('restores interrupted thinking only for the matching Responses model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-thinking-'))
    const file = join(dir, 'session.json')
    const read = createSessionReader()
    const snapshot = {
      providerId: 'p', protocol: 'openai_responses', model: 'm',
      messages: [], conversationMessages: [{ role: 'user', content: 'question' }],
      interruptedThinking: { providerId: 'p', protocol: 'openai_responses', model: 'm', apiBase: 'https://test', text: 'first\n\nsecond' }
    }
    try {
      writeFileSync(file, JSON.stringify({ turnState: 'aborted', snapshot }))
      expect((await read(file)).history.at(-1)).toMatchObject({ role: 'assistant', kind: 'reasoning', text: 'first\n\nsecond' })
      snapshot.model = 'another-model'
      writeFileSync(file, JSON.stringify({ turnState: 'aborted', snapshot }))
      expect((await read(file)).history.map((row) => row.kind)).not.toContain('reasoning')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes an active checkpoint when restoring a running session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-active-thinking-'))
    const file = join(dir, 'session.json')
    const read = createSessionReader()
    const snapshot = {
      providerId: 'p', protocol: 'openai_responses', model: 'm', messages: [],
      conversationMessages: [{ role: 'user', content: 'question' }],
      activeThinking: { providerId: 'p', protocol: 'openai_responses', model: 'm', apiBase: '', text: 'completed' }
    }
    try {
      writeFileSync(file, JSON.stringify({ turnState: 'running', snapshot }))
      expect((await read(file)).history.at(-1)).toMatchObject({ role: 'assistant', kind: 'reasoning', text: 'completed', activeCheckpoint: true })
      snapshot.model = 'different'
      writeFileSync(file, JSON.stringify({ turnState: 'running', snapshot }))
      expect((await read(file)).history.some((row) => row.kind === 'reasoning')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers only completed todo writes from the last turn across provider formats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-todo-'))
    const file = join(dir, 'session.json')
    const read = createSessionReader()
    const plan = { todos: [{ content: 'Test', status: 'in_progress' }] }
    const write = async (messages) => {
      writeFileSync(file, JSON.stringify({ turnState: 'aborted', snapshot: { messages } }))
      return (await read(file)).meta.todoInput
    }
    try {
      const chat = [
        { role: 'user', content: 'work' },
        { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'todo_write', arguments: JSON.stringify(plan) } }] },
        { role: 'tool', tool_call_id: 'a', content: 'ok' }
      ]
      expect(await write(chat)).toEqual(plan)
      expect(await write([...chat, { role: 'user', content: 'new turn' }])).toBeNull()
      expect(await write(chat.slice(0, 2))).toBeNull()
      expect(await write([
        { type: 'message', role: 'user', content: 'work' },
        { type: 'function_call', call_id: 'b', name: 'todo_write', arguments: JSON.stringify(plan) },
        { type: 'function_call_output', call_id: 'b', output: 'ok' }
      ])).toEqual(plan)
      const anthropic = [
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'todo_write', input: plan }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c' }] }
      ]
      expect(await write(anthropic)).toEqual(plan)
      expect(await write([...anthropic.slice(0, 2), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', is_error: true }] }])).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('projects history and metadata in a worker and reads fresh data on later requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-'))
    const file = join(dir, 'session.json')
    try {
      writeFileSync(
        file,
        JSON.stringify({
          cwd: ' /tmp ',
          snapshot: {
            providerId: 'p',
            conversationMessages: [
              { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] }
            ],
            usageHistory: [{ inputTokens: 100, cachedInputTokens: 25 }],
            displayUsage: { totalTokens: 42 }
          }
        })
      )
      const read = createSessionReader()
      const first = read(file)
      expect(read(file)).toBe(first)
      const result = await first
      expect(result.history).toEqual([
        {
          role: 'user',
          text: 'hello[图片]',
          variant: null,
          command: null,
          status: null,
          usage: null,
          stop_reason: null
        }
      ])
      expect(result.meta).toMatchObject({
        providerId: 'p',
        cwd: '/tmp',
        cachedRate: 0.25,
        lastUsage: { totalTokens: 42 },
        role: 'default'
      })
      writeFileSync(file, '{bad')
      expect(await read(file)).toEqual({ history: [], meta: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shares concurrent work and recovers from worker failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-fallback-'))
    const file = join(dir, 'session.json')
    writeFileSync(file, JSON.stringify({ snapshot: { conversationMessages: [{ role: 'user', content: 'saved' }] } }))
    try {
      let calls = 0
      const read = createSessionReader({
        startWorker: () => {
          calls++
          const worker = new EventEmitter()
          queueMicrotask(() => worker.emit('error', new Error('failed')))
          return worker
        }
      })
      const [result] = await Promise.all([read(file), read(file)])
      expect(result.history[0].text).toBe('saved')
      expect(calls).toBe(1)
      expect((await read(file)).history[0].text).toBe('saved')
      expect(calls).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads sessions when the parent was started with module input mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-argv-'))
    const file = join(dir, 'session.json')
    try {
      writeFileSync(file, JSON.stringify({ snapshot: { conversationMessages: [{ role: 'user', content: 'saved' }] } }))
      const moduleUrl = new URL('./session-reader.js', import.meta.url).href
      const script = `import { createSessionReader } from ${JSON.stringify(moduleUrl)}; const result = await createSessionReader()(${JSON.stringify(file)}); console.log(JSON.stringify(result.history))`
      const output = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' })
      expect(JSON.parse(output)[0].text).toBe('saved')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

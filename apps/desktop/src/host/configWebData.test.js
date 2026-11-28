import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { estimateTextTokens } from '../../../../packages/mica-config-ui/src/shared/text.ts'
import * as electron from '../server/electron-shim.js'

mock.module('electron', () => electron)
const previousHome = process.env.MICA_HOME
let home
let actions
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(tmpdir(), 'mica-desktop-config-roles-'))
  process.env.MICA_HOME = home
  actions = (await import('./configWebData.js')).configWebActions
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

function session(role, systemPrompt, lastToolSchemas) {
  const value = {
    version: 1,
    id: '20260801-desktop-role',
    title: '[Image](/tmp/demo.png)  Review   notes',
    cwd: home,
    turnState: 'completed',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    snapshot: {
      messageFormat: 'pi-ai-v1',
      providerId: 'test',
      protocol: 'openai_chat_completions',
      model: 'test',
      effort: 'high',
      role,
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      conversationMessages: [],
      usageHistory: [],
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(lastToolSchemas === undefined ? {} : { lastToolSchemas })
    }
  }
  const file = path.join(home, 'sessions', `${value.id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
  return { id: value.id, file }
}

test('cleans display titles and retains the usage and timing fields when paging from a snapshot', () => {
  const { id, file } = session('default', 'sent prompt')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const usage = { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 }
  const timings = [{ startedAt: 1, endedAt: 2, outcome: 'completed', segments: [] }]
  data.snapshot.lastUsage = { ...usage, turnId: 1 }
  data.snapshot.usageHistory = [data.snapshot.lastUsage]
  data.snapshot.turnTimings = timings
  fs.writeFileSync(file, JSON.stringify(data))
  expect(actions.readSessionsDetails().sessions[0]).toMatchObject({ id, title: 'Review notes' })
  const header = actions.readSessionDetails({ id })
  expect(header).toMatchObject({ title: 'Review notes', usageCount: 1, turnTimings: timings })
  expect(header.lastUsage).toEqual(usage)
  expect(actions.readSessionConversationPage({ id, limit: 1, tail: true }).items[0].content).toBe('hello')
  expect(JSON.parse(actions.readSessionContent({ id }).content).title).toBe(data.title)
})

test('replaces MCP entries together and preserves unrelated configuration and placeholders', async () => {
  const file = path.join(home, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ other: 123, mcpServers: { old: { command: 'old' } } }))
  const servers = { current: { command: 'tool', args: ['${ARG}'] } }
  const result = await actions.writeMcpServers({ content: JSON.stringify(servers) })
  expect(JSON.parse(result.content)).toEqual(servers)
  await expect(actions.writeMcpServers({ content: '{"broken":false}' })).rejects.toThrow('JSON 对象')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ other: 123, mcpServers: servers })
})

test('dispatches only registered configuration actions over IPC', async () => {
  const { registerConfigWebIpc } = await import('./configWeb.js')
  registerConfigWebIpc()
  try {
    const invoke = (action) => electron.invokeChannel('config-web:invoke', { action })
    expect(invoke('readSessionsDetails')).toEqual({ root: path.join(home, 'sessions'), sessions: [] })
    expect(() => invoke('toString')).toThrow('未知的配置操作')
  } finally {
    electron.ipcMain.removeHandler('config-web:invoke')
  }
})

describe('desktop config roles', () => {
  test.each(['default', 'default.md', ' default.md ', 'DEFAULT.MD', '\tdefault\n', 'default.md.md'])(
    'refuses all default mutations through %j',
    (name) => {
      const directory = path.join(home, 'role')
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(directory, 'default.md'), 'Keep user shadow untouched.')
      const before = actions.readRolesDetails().roles[0]
      expect(() => actions.createRole({ name, content: 'Override' })).toThrow('只读')
      expect(() => actions.writeRole({ name, content: 'Override' })).toThrow('只读')
      expect(() => actions.deleteRole({ name })).toThrow('只读')
      expect(actions.readRolesDetails().roles).toEqual([before])
      expect(fs.readFileSync(path.join(directory, 'default.md'), 'utf8')).toBe('Keep user shadow untouched.')
      expect(fs.readdirSync(directory)).toEqual(['default.md'])
    }
  )

  test('keeps ordinary create, write and delete operations working', () => {
    actions.createRole({ name: ' reviewer.md ', content: 'Review carefully.' })
    expect(actions.readRolesDetails().roles.map((role) => role.name)).toEqual(['default', 'reviewer'])
    actions.writeRole({ name: 'reviewer.md', content: 'Updated.' })
    expect(fs.readFileSync(path.join(home, 'role', 'reviewer.md'), 'utf8')).toBe('Updated.')
    actions.deleteRole({ name: ' reviewer ' })
    expect(actions.readRolesDetails().roles.map((role) => role.name)).toEqual(['default'])
  })

  test.each(['', '   ', '../default', 'default/../default'])('rejects unsafe role names %j', (name) => {
    expect(() => actions.createRole({ name })).toThrow()
    expect(() => actions.writeRole({ name, content: 'Override' })).toThrow()
    expect(() => actions.deleteRole({ name })).toThrow()
  })

  test.each(['reviewer', 'default', 'missing'])('combines current default and %s without inventing a snapshot', (name) => {
    if (name === 'reviewer') actions.createRole({ name, content: 'Review carefully.' })
    const { id, file } = session(name)
    const before = fs.readFileSync(file, 'utf8')
    const reference = actions.readSessionSystemPrompt({ id })
    const base = actions.readRolesDetails().roles[0].content.trim()
    expect(reference.prompt).toBe('')
    expect(reference.rolePrompt).toContain(base)
    expect(reference.rolePrompt.match(/<system>/g)).toHaveLength(1)
    if (name === 'reviewer') expect(reference.rolePrompt).toContain('<role>\nReview carefully.\n</role>')
    else expect(reference.rolePrompt).not.toContain('<role>')
    expect(actions.readSessionItem({ id, sequence: 1 }).content).toBe(reference.rolePrompt)
    expect(actions.readSessionContextAnalysis({ id }).turns[0].entries[0].tokens).toBe(estimateTextTokens(reference.rolePrompt))
    expect(JSON.parse(actions.readSessionContent({ id }).content).snapshot.systemPrompt).toBeUndefined()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  test('passes recorded tool schemas to Context analysis without reading the current registry', () => {
    const { id } = session('default', undefined, {
      tools: [
        { name: 'read_file', source: 'other', tokens: 20 },
        { name: 'search', source: 'mcp', server: 'docs', tokens: 80 }
      ]
    })
    const analysis = actions.readSessionContextAnalysis({ id })
    expect(analysis.toolSchemas).toEqual([
      { name: 'read_file', source: 'other', tokens: 20 },
      { name: 'search', source: 'mcp', server: 'docs', tokens: 80 }
    ])
  })

  test.each(['<system>\nSaved prompt.\n</system>\n<role>\nSaved role.\n</role>', ''])(
    'uses a recorded prompt verbatim, including an empty recording',
    (prompt) => {
      actions.createRole({ name: 'reviewer', content: 'Current role.' })
      const { id } = session('reviewer', prompt)
      expect(actions.readSessionSystemPrompt({ id }).prompt).toBe(prompt)
      expect(actions.readSessionItem({ id, sequence: 1 }).content).toBe(prompt)
      expect(actions.readSessionContextAnalysis({ id }).turns[0].entries[0].tokens).toBe(estimateTextTokens(prompt))
    }
  )
})

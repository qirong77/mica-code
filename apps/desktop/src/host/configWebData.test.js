import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { wrapPromptXml } from '../../../../packages/mica-common/promptXml.ts'
import {
  buildConfigWebConversationItems,
  buildConfigWebContextAnalysis
} from '../../../../packages/mica-config-ui/src/server/sessionView.ts'
import { estimateTextTokens } from '../../../../packages/mica-config-ui/src/shared/text.ts'

// Evaluate the real data layer without Electron or unrelated plugin/runtime imports.
const source = fs.readFileSync(new URL('./configWebData.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?from\s+['"][^'"\n]+['"]\s*$/gm, '')
  .replace(/^export /gm, '')
const template = fs.readFileSync(new URL('../../../../packages/mica-agent/prompt/system.md', import.meta.url), 'utf8')
let home
let actions

beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmpdir(), 'mica-desktop-config-roles-'))
  actions = runInNewContext(`${source}\nconfigWebActions`, {
    ...fs,
    ...path,
    homedir,
    process: { env: { MICA_HOME: home }, pid: process.pid },
    defaultSystemPromptTemplate: template,
    applyBrandTemplate: (value) => value.replaceAll('{{ MICA_APP_NAME }}', 'Mica'),
    wrapPromptXml,
    buildConfigWebConversationItems,
    buildConfigWebContextAnalysis
  })
})

afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function session(role, systemPrompt) {
  const value = {
    id: '20260801-desktop-role',
    snapshot: {
      providerId: 'test',
      protocol: 'openai_chat_completions',
      model: 'test',
      role,
      messages: [{ role: 'user', content: 'hello' }],
      ...(systemPrompt === undefined ? {} : { systemPrompt })
    }
  }
  const file = path.join(home, 'sessions', `${value.id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
  return { id: value.id, file }
}

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

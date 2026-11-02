import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTodoCheckpointInput } from './todo-checkpoint'

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'todo-checkpoint-test-'))
  mkdirSync(join(dir, 'todo-checkpoints'), { recursive: true })
  return dir
}

function write(dir, sessionId, value) {
  writeFileSync(
    join(dir, 'todo-checkpoints', `${sessionId}.json`),
    typeof value === 'string' ? value : JSON.stringify(value)
  )
}

describe('todo checkpoint projection', () => {
  it('projects a stored plan into the tool-input shape', () => {
    const dir = home()
    try {
      write(dir, 'session', {
        version: 1,
        sessionId: 'session',
        turnId: 'turn',
        items: [
          { content: 'Do it', status: 'in_progress' },
          { content: 'Then this', status: 'pending' }
        ]
      })
      expect(readTodoCheckpointInput(dir, 'session')).toEqual({
        todos: [
          { content: 'Do it', status: 'in_progress' },
          { content: 'Then this', status: 'pending' }
        ]
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores missing, foreign, empty and corrupt checkpoints', () => {
    const dir = home()
    try {
      expect(readTodoCheckpointInput(dir, 'missing')).toBeNull()
      expect(readTodoCheckpointInput(dir, '../session')).toBeNull()
      expect(readTodoCheckpointInput('', 'session')).toBeNull()
      write(dir, 'session', {
        version: 1,
        sessionId: 'other',
        turnId: 'turn',
        items: [{ content: 'x', status: 'pending' }]
      })
      expect(readTodoCheckpointInput(dir, 'session')).toBeNull()
      write(dir, 'session', { version: 1, sessionId: 'session', turnId: 'turn', items: [] })
      expect(readTodoCheckpointInput(dir, 'session')).toBeNull()
      write(dir, 'session', '{ not json')
      expect(readTodoCheckpointInput(dir, 'session')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

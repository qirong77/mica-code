import { describe, expect, test } from 'bun:test'
import { createSubmittedCommandTracker } from './terminal-input'

describe('createSubmittedCommandTracker', () => {
  test('reports a submitted exit command', () => {
    const commands = []
    const track = createSubmittedCommandTracker((command) => commands.push(command))
    track('  exit  ')
    track('\r')
    expect(commands).toEqual(['exit'])
  })

  test('tracks corrections before submission', () => {
    const commands = []
    const track = createSubmittedCommandTracker((command) => commands.push(command))
    track('exiy\x7ft\r')
    track('ignored\x15exit\n')
    expect(commands).toEqual(['exit', 'exit'])
  })

  test('does not report empty submissions', () => {
    const commands = []
    const track = createSubmittedCommandTracker((command) => commands.push(command))
    track('\r\n   \r')
    expect(commands).toEqual([])
  })
})

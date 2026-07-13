import { describe, expect, it } from 'vitest';
import { SESSION_TASK_KIND, SUBAGENT_TASK_KIND, formatShellName, formatShellTaskKind } from './taskRowFormat.js';

describe('task row source labels', () => {
  it('uses distinct labels for subagents and sessions', () => {
    expect(SUBAGENT_TASK_KIND).toBe('🤖(subagent)');
    expect(SESSION_TASK_KIND).toBe('# (session)');
  });

  it('derives the shell label from Unix and Windows paths', () => {
    expect(formatShellTaskKind('/bin/bash')).toBe('$ (bash)');
    expect(formatShellTaskKind('/bin/zsh/')).toBe('$ (zsh)');
    expect(formatShellName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
  });

  it('falls back to a generic shell label for empty values', () => {
    expect(formatShellTaskKind('')).toBe('$ (shell)');
    expect(formatShellTaskKind('/')).toBe('$ (shell)');
  });
});

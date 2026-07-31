import { describe, expect, it } from 'vitest';
import { getToolDefinitions } from '../registry.js';
import { ToolPtySpawn } from '../pty/ToolPtySpawn.js';
import { ToolPtySend } from '../pty/ToolPtySend.js';
import { ToolPtyRead } from '../pty/ToolPtyRead.js';
import { ToolPtyWait } from '../pty/ToolPtyWait.js';
import { ToolPtyKill } from '../pty/ToolPtyKill.js';

const PTY_TOOL_NAMES = ['pty_spawn', 'pty_send', 'pty_read', 'pty_wait', 'pty_kill'];

describe('PTY tools', () => {
  it('are registered as builtin tools', () => {
    const definitions = getToolDefinitions();
    const names = definitions.map((d) => d.name);
    for (const name of PTY_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('declare spawn/send/read/wait/kill as non-read-only tools', () => {
    for (const tool of [
      new ToolPtySpawn(),
      new ToolPtySend(),
      new ToolPtyRead(),
      new ToolPtyWait(),
      new ToolPtyKill(),
    ]) {
      expect(tool.readOnly).toBe(false);
    }
  });

  it('validate required fields', () => {
    const spawn = new ToolPtySpawn();
    expect(spawn.validateInput({}).valid).toBe(false);
    expect(spawn.validateInput({ command: '/bin/sh' }).valid).toBe(true);

    const send = new ToolPtySend();
    expect(send.validateInput({}).valid).toBe(false);
    expect(send.validateInput({ session_id: 'abc' }).valid).toBe(true);

    const kill = new ToolPtyKill();
    expect(kill.validateInput({ session_id: 'abc' }).valid).toBe(true);
  });
});
